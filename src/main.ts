import '@fontsource/marcellus/latin-400.css';
import cinzelDigits from '@fontsource/cinzel/files/cinzel-latin-400-normal.woff2?url';
import './style.css';
import {
  ALL_SPELLS, DT, PLAYER_COLORS, shuffledBotNames, SPELLS, WARLOCK_CARD, WARLOCK_RADIUS, type SpellId,
} from './config';
import { Bot, type BotState, type Difficulty } from './ai/bot';
import { Sim } from './sim/game';
import { decodeState, encodeState } from './sim/snapshot';
import type { Command, GameEvent, PlayerSetup, SimRules } from './sim/types';
import { GameRenderer } from './render/renderer';
import { loadUnitModels } from './render/unitModel';
import { loadObstacleModels } from './render/obstacleModels';
import { makeCursor } from './render/textures';
import { Hud, playerName } from './ui/hud';
import { SoundSystem, type Sfx } from './audio';
import { BUFFER_TICKS, HASH_EVERY, hashString, TURN_TICKS, type Lockstep } from './net/lockstep';
import { workerInterval } from './net/timer';
import { MAX_PLAYERS, NetSession, normalizeCode, PUBLIC_ROOMS, type GameState, type LobbyState, type NetRules, type StartInfo } from './net/session';

/** What the menu remembers between visits. */
interface Settings {
  name: string;
  bots: number;
}

/** Dev-only overrides, for benchmarking. */
interface DevOptions {
  frameCap?: number;
  pixelRatio?: number;
  antialias?: boolean;
}

/** 60 fps at up to 1.5× device pixels: GPU cost scales with pixels drawn, so these set most of the power draw. */
const FRAME_CAP = 60;
const PIXEL_RATIO = 1.5;
const VOLUME = 0.6;
const DEFAULTS: Settings = { name: 'Player', bots: 3 };
const RULES: NetRules = { mode: 'deathmatch', rounds: 10, pointLimit: 20, teams: 'ffa', arenaShape: 'square', startingGold: 10 };
/** Someone joining a game in progress takes a computer player's place once there are this many warlocks. */
const BOT_REPLACE_AT = 4;
const DIFFICULTY: Difficulty = 'normal';

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('warlocks.settings') ?? '{}') };
    return { name: String(s.name).slice(0, 16) || DEFAULTS.name, bots: Math.max(0, Math.min(MAX_PLAYERS - 1, Number(s.bots) | 0)) };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: Settings) {
  localStorage.setItem('warlocks.settings', JSON.stringify({ name: s.name, bots: s.bots }));
}

const sound = new SoundSystem();
const app = document.getElementById('app')!;
const CURSORS = { normal: makeCursor('normal'), target: makeCursor('target'), targetEnemy: makeCursor('targetEnemy') };
document.body.style.cursor = CURSORS.normal;

const CAST_SFX: Partial<Record<SpellId, Sfx>> = {
  fireball: 'fireball', homing: 'homing', boomerang: 'boomerang', gravity: 'gravity', link: 'link',
  displacement: 'swap', thrust: 'thrust', shield: 'shield', windwalk: 'windwalk',
};

interface GameSetup {
  players: PlayerSetup[];
  seed: number;
  rules: Partial<SimRules>;
  difficulty: Difficulty;
  localId: number;
  net?: { session: NetSession; lockstep: Lockstep };
  /** Joining a game in progress. */
  state?: GameState;
}

function localSetup(name: string, bots: number, rules: Partial<SimRules> = RULES): GameSetup {
  const players: PlayerSetup[] = [{ name, color: 0, isBot: false }];
  const names = shuffledBotNames();
  for (let i = 0; i < bots; i++) players.push({ name: names[i], color: i + 1, isBot: true });
  return { players, seed: (Math.random() * 2 ** 31) | 0, rules, difficulty: DIFFICULTY, localId: 0 };
}

class Game {
  private sim: Sim;
  private bots: Bot[];
  private renderer: GameRenderer;
  private hud: Hud;
  private root: HTMLElement;
  private localId: number;
  private net: GameSetup['net'];
  private chatInput: HTMLInputElement | null = null;
  private stopHiddenTicker: (() => void) | null = null;
  private hiddenLast = 0;
  private targeting: SpellId | null = null;
  private pending: Command[] = [];
  private mouse = { x: 0, y: 0, inside: false };
  private keys = new Set<string>();
  /** WASD walking: the last order we sent was a WASD move toward `walkTarget`. */
  private walking = false;
  private walkTarget = { x: 0, y: 0 };
  private walkSentAt = 0;
  private acc = 0;
  private last = performance.now();
  private raf = 0;
  private paused = false;
  private disposers: (() => void)[] = [];
  private frameCap: number;

  constructor(setup: GameSetup, private onExit: (again: boolean) => void, dev: DevOptions = {}) {
    const { players, seed } = setup;
    this.localId = setup.localId;
    this.net = setup.net;
    // Bots are deterministic, so in multiplayer every peer runs all of them rather than sending their orders.
    if (setup.state) {
      this.sim = Sim.restore(setup.state.sim);
      this.bots = decodeState<BotState[]>(setup.state.bots).map((b) => Bot.restore(b));
    } else {
      this.sim = new Sim({ players, seed, rules: setup.rules });
      this.bots = this.sim.players.filter((p) => p.isBot).map((p) => new Bot(p.id, seed ^ (p.id * 7919), setup.difficulty));
    }

    this.root = document.createElement('div');
    this.root.id = 'game';
    const viewport = document.createElement('div');
    viewport.id = 'viewport';
    this.root.appendChild(viewport);
    app.appendChild(this.root);

    this.frameCap = dev.frameCap ?? FRAME_CAP;
    this.renderer = new GameRenderer(viewport, this.sim, this.localId, { pixelRatio: dev.pixelRatio ?? PIXEL_RATIO, antialias: dev.antialias ?? true });
    this.hud = new Hud(this.root, this.sim, this.localId, this.renderer, {
      onSpell: (id) => this.activateSpell(id),
      onBuy: (id) => {
        sound.play('click');
        this.queue({ pid: this.localId, type: 'buy', product: id });
      },
      onToggle: (spell) => {
        sound.play('click');
        this.queue({ pid: this.localId, type: 'toggle', spell });
      },
      onReady: () => {
        sound.play('click');
        this.queue({ pid: this.localId, type: 'ready' });
      },
      onMinimap: (x, y, button) => {
        if (button === 0) this.renderer.centerOn(x, y);
        else if (button === 2) this.issueMove(x, y);
      },
      onPause: () => this.setPaused(true),
      onResume: () => this.setPaused(false),
      onQuit: () => this.exit(false),
      onPlayAgain: () => this.exit(true),
    });
    this.bindInput();
    sound.startAmbient();
    if (this.net) this.bindNet();
    this.raf = requestAnimationFrame(this.frame);
  }

  private bindNet() {
    const { session } = this.net!;
    const btn = (act: string) => this.root.querySelector<HTMLElement>(`[data-act="${act}"]`);
    btn('again')!.textContent = 'Back to Lobby';
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-act="quit"]')) b.textContent = 'Leave Game';
    session.events = {
      onChat: (pid, text) => this.hud.message(`${playerName(this.sim.players[pid])}: ${escapeHtml(text)}`, 12),
      onClosed: (reason) => {
        if (this.sim.phase === 'gameOver') return;
        this.hud.center(escapeHtml(reason), 6);
        this.hud.message(`<span style="color:#ff6060">${escapeHtml(reason)} The game cannot continue.</span>`, 60);
        this.setPaused(true);
      },
      onLobby: () => {
        if (this.sim.phase === 'gameOver') this.hud.message('The host is back in the lobby.', 10);
      },
      onStart: (info, ls, state) => {
        this.dispose();
        startNetGame(session, info, ls, state);
      },
      onJoinRequest: (name, color) => this.admit(name, color),
    };
    this.chatInput = document.createElement('input');
    this.chatInput.className = 'chat-input hidden';
    this.chatInput.maxLength = 120;
    this.root.appendChild(this.chatInput);
    const closeChat = () => {
      this.chatInput!.value = '';
      this.chatInput!.classList.add('hidden');
      this.chatInput!.blur();
    };
    this.listen(this.chatInput, 'keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        session.chat(this.chatInput!.value);
        closeChat();
      } else if (e.key === 'Escape') closeChat();
    });
    this.listen(this.chatInput, 'blur', closeChat);
    const onVisibility = () => {
      this.stopHiddenTicker?.();
      this.stopHiddenTicker = null;
      if (document.hidden) {
        this.hiddenLast = performance.now();
        this.stopHiddenTicker = workerInterval(30, () => {
          const now = performance.now();
          // Alone, a hidden game waits, as it would offline.
          if (session.alone) {
            this.hiddenLast = now;
            return;
          }
          this.simulate(Math.min(0.25, (now - this.hiddenLast) / 1000));
          this.hiddenLast = now;
        });
      } else {
        this.last = performance.now();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    this.disposers.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      this.stopHiddenTicker?.();
    });
  }

  private openChat() {
    if (!this.chatInput) return;
    this.chatInput.classList.remove('hidden');
    this.chatInput.focus();
  }

  private dispose() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.wakeTimer);
    for (const d of this.disposers) d();
    this.hud.dispose();
    this.renderer.dispose();
    this.root.remove();
    document.body.style.cursor = CURSORS.normal;
  }

  private exit(again: boolean) {
    this.dispose();
    this.onExit(again);
  }

  /** A local order: straight into the next tick offline, or to the host online. */
  private queue(cmd: Command) {
    // Any other order replaces the walk; an instant spell doesn't touch the current order.
    if (cmd.type === 'move' || cmd.type === 'stop' || (cmd.type === 'cast' && SPELLS[cmd.spell].targeting !== 'none')) this.walking = false;
    if (this.net) this.net.lockstep.submit(cmd);
    else this.pending.push(cmd);
  }

  private setPaused(p: boolean) {
    this.paused = p;
    this.hud.setPaused(p);
  }

  /** Online the game menu doesn't stop the clock while anyone else is playing. */
  private get simPaused() {
    return this.paused && (!this.net || this.net.session.alone);
  }

  /** Players admitted since the last turn closed, and computer players leaving to make room. */
  private joinColors: number[] = [];
  private botsLeaving = new Set<number>();

  /** Host: someone wants to join the game in progress. Returns their player id, or why they can't. */
  private admit(name: string, color: number): number | string {
    const sim = this.sim;
    if (sim.phase === 'gameOver') return 'That game has just ended.';
    const active = sim.players.filter((p) => !p.left && !this.botsLeaving.has(p.id));
    const total = active.length + this.joinColors.length;
    const bot = [...active].reverse().find((p) => p.isBot);
    if (bot && total >= BOT_REPLACE_AT) {
      this.botsLeaving.add(bot.id);
      this.net!.lockstep.receive({ pid: bot.id, type: 'leave' });
    } else if (total >= MAX_PLAYERS) return 'That game is full.';
    const used = new Set([...active.filter((p) => !this.botsLeaving.has(p.id)).map((p) => p.color), ...this.joinColors]);
    if (used.has(color) || !PLAYER_COLORS[color]) color = PLAYER_COLORS.findIndex((_, i) => !used.has(i));
    const pid = sim.players.length + this.joinColors.length;
    this.joinColors.push(color);
    this.net!.lockstep.receive({ pid, type: 'join', name, color });
    return pid;
  }

  private listen<K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) {
    target.addEventListener(type, fn as EventListener, opts);
    this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
  }

  private get me() {
    return this.sim.players[this.localId];
  }

  private canAct() {
    const ph = this.sim.phase;
    return (ph === 'fight' || ph === 'roundEnd' || ph === 'countdown') && this.me.alive && !this.paused;
  }

  private issueMove(x: number, y: number) {
    if (!this.canAct()) return;
    this.queue({ pid: this.localId, type: 'move', x, y });
    this.renderer.addMoveMarker(x, y);
  }

  private activateSpell(id: SpellId) {
    sound.ensure();
    if (!this.canAct()) return;
    const lvl = this.me.spells[id] ?? 0;
    if (lvl <= 0) return;
    this.hud.pressButton(id);
    if ((this.me.cooldowns[id] ?? 0) > 0) {
      this.hud.error('Spell is not ready yet.');
      sound.play('error');
      return;
    }
    if (SPELLS[id].targeting === 'none') {
      if (this.sim.phase === 'countdown') {
        this.hud.error('Wait for the round to begin.');
        sound.play('error');
        return;
      }
      this.queue({ pid: this.localId, type: 'cast', spell: id, x: this.me.x, y: this.me.y });
      this.targeting = null;
      return;
    }
    this.targeting = id;
  }

  private bindInput() {
    const canvas = this.renderer.renderer.domElement;
    this.listen(window, 'contextmenu', (e) => e.preventDefault());
    this.listen(canvas, 'mousedown', (e) => {
      sound.ensure();
      const w = this.renderer.pick(e.clientX, e.clientY);
      if (!w) return;
      if (e.button === 0) {
        if (this.targeting) {
          if (this.canAct()) this.queue({ pid: this.localId, type: 'cast', spell: this.targeting, x: w.x, y: w.y });
          this.targeting = null;
        }
      } else if (e.button === 2) {
        if (this.targeting) this.targeting = null;
        else this.issueMove(w.x, w.y);
      }
    });
    this.listen(window, 'mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      this.mouse.inside = true;
    });
    this.listen(document.documentElement, 'mouseleave', () => (this.mouse.inside = false));
    this.listen(window, 'blur', () => this.keys.clear());
    this.listen(canvas, 'wheel', (e) => {
      this.renderer.camDist = Math.max(1000, Math.min(2600, this.renderer.camDist + e.deltaY * 0.8));
    }, { passive: true });
    this.listen(window, 'keyup', (e) => this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
    this.listen(window, 'keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      sound.ensure();
      const k = e.key.toUpperCase();
      this.keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
      if (e.key === 'Escape' && !this.targeting && this.hud.shopOpen && this.sim.phase !== 'shop') {
        this.hud.toggleShop();
        return;
      }
      if (e.key === 'F10' || (e.key === 'Escape' && !this.targeting)) {
        e.preventDefault();
        this.setPaused(!this.paused);
        return;
      }
      if (e.key === 'Escape') {
        this.targeting = null;
        return;
      }
      if (e.key === 'Enter' && this.chatInput) {
        e.preventDefault();
        this.openChat();
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        this.hud.toggleScores();
        return;
      }
      if (this.paused || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === 'B') {
        this.hud.toggleShop();
        return;
      }
      if (k === 'X') {
        this.targeting = null;
        if (this.canAct()) this.queue({ pid: this.localId, type: 'stop' });
        return;
      }
      const spell = WARLOCK_CARD.find((id) => SPELLS[id].hotkey === k && (this.me.spells[id] ?? 0) > 0)
        ?? ALL_SPELLS.find((id) => SPELLS[id].hotkey === k && (this.me.spells[id] ?? 0) > 0);
      if (spell) this.activateSpell(spell);
    });
  }

  /** The camera stays on the warlock, where the renderer draws it; it only pans while you're dead. */
  private updateCamera(dt: number) {
    const r = this.renderer;
    const me = this.me;
    if (me.alive) {
      const a = this.simPaused ? 1 : Math.min(1, this.acc / DT);
      r.camX = me.px + (me.x - me.px) * a;
      r.camY = me.py + (me.y - me.py) * a;
      return;
    }
    const speed = 1500 * (r.camDist / 1650) * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('ArrowRight')) dx += 1;
    if (this.keys.has('ArrowUp')) dy += 1;
    if (this.keys.has('ArrowDown')) dy -= 1;
    if (this.mouse.inside && document.hasFocus()) {
      const m = 3;
      if (this.mouse.x <= m) dx -= 1;
      if (this.mouse.x >= window.innerWidth - m) dx += 1;
      if (this.mouse.y <= m) dy += 1;
      if (this.mouse.y >= window.innerHeight - m) dy -= 1;
    }
    if (dx || dy) {
      r.camX = Math.max(-1200, Math.min(1200, r.camX + dx * speed));
      r.camY = Math.max(-1200, Math.min(1200, r.camY + dy * speed));
    }
  }

  /** WASD sends ordinary move orders toward a point ahead, re-sent only when they stop matching the keys. */
  private updateWalk(now: number) {
    const k = this.keys;
    let dx = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0);
    let dy = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0);
    if (!dx && !dy) {
      if (this.walking && this.canAct()) this.queue({ pid: this.localId, type: 'stop' });
      this.walking = false;
      return;
    }
    if (!this.canAct()) return;
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
    const me = this.me;
    const idle = me.order.type === 'idle';
    let send = false;
    if (!this.walking) {
      // Holding a direction resumes walking once a cast or right-click order has finished.
      send = idle;
    } else {
      const tx = this.walkTarget.x - me.x;
      const ty = this.walkTarget.y - me.y;
      const dist = Math.hypot(tx, ty);
      const turned = dist < 400 || (tx * dx + ty * dy) / dist < 0.995;
      // Orders arrive a few ticks late online, so a still-idle warlock is only re-ordered after a pause.
      send = turned || (idle && now - this.walkSentAt > 250);
    }
    if (!send) return;
    const x = me.x + dx * 1000;
    const y = me.y + dy * 1000;
    this.queue({ pid: this.localId, type: 'move', x, y });
    this.walking = true;
    this.walkTarget = { x, y };
    this.walkSentAt = now;
  }

  private updateCursorAndAoe() {
    let cursor = CURSORS.normal;
    let aoe: { x: number; y: number; r: number } | null = null;
    if (this.targeting && this.mouse.inside) {
      cursor = CURSORS.target;
      const w = this.renderer.pick(this.mouse.x, this.mouse.y);
      if (w) {
        for (const p of this.sim.players) {
          if (p.id !== this.localId && p.alive && this.sim.isVisibleTo(p, this.localId) && Math.hypot(p.x - w.x, p.y - w.y) < WARLOCK_RADIUS * 1.6) {
            cursor = CURSORS.targetEnemy;
          }
        }
        if (this.targeting === 'meteor') aoe = { x: w.x, y: w.y, r: 220 };
      }
    }
    if (document.body.style.cursor !== cursor) document.body.style.cursor = cursor;
    this.renderer.setAoe(aoe?.x ?? 0, aoe?.y ?? 0, aoe ? aoe.r : null);
  }

  private handleEvent(e: GameEvent) {
    this.renderer.onEvent(e);
    this.hud.onEvent(e);
    const P = (id: number) => this.sim.players[id];
    switch (e.t) {
      case 'cast': {
        const sfx = CAST_SFX[e.spell];
        const p = P(e.pid);
        if (sfx && (p.windwalk <= 0 || e.pid === this.localId || e.spell !== 'windwalk')) sound.playAt(sfx, p.x, p.y);
        break;
      }
      case 'lightning':
        sound.playAt('lightning', e.x1, e.y1);
        break;
      case 'teleport':
        sound.playAt('teleport', e.tx, e.ty);
        break;
      case 'explode':
        sound.playAt(e.kind === 'fireball' || e.kind === 'homing' || e.kind === 'clash' ? 'explode' : 'hit', e.x, e.y, 0.8);
        break;
      case 'hit':
        sound.playAt('hit', e.x, e.y, 0.7);
        break;
      case 'meteorFall':
        sound.playAt('meteorFall', e.x, e.y);
        break;
      case 'meteorImpact':
        sound.playAt('meteorImpact', e.x, e.y);
        break;
      case 'death':
        sound.playAt('death', e.x, e.y);
        break;
      case 'announcement':
        sound.play('horn', 0.9);
        break;
      case 'effect':
        if (e.soundPath) sound.playAt('reflect', e.x, e.y);
        break;
      case 'reflect':
        sound.playAt('reflect', e.x, e.y);
        break;
      case 'bounty':
        if (e.pid === this.localId) sound.play('bounty', 0.8);
        break;
      case 'buy':
        if (e.pid === this.localId) sound.play('buy');
        break;
      case 'error':
        if (e.pid === this.localId) sound.play('error');
        break;
      case 'phase':
        if (e.phase === 'fight') sound.play('horn', 0.9);
        if (e.phase === 'countdown') {
          this.targeting = null;
          this.renderer.centerOn(this.me.x, this.me.y);
        }
        break;
      case 'roundWinner':
        if (e.pid === this.localId) sound.play('victory');
        break;
      default:
        break;
    }
  }

  private nextFrame = 0;

  private wakeTimer = 0;
  private timerWake = false;

  /**
   * Requests the next frame. When the next frame slot is well in the future, sleep on a timer first:
   * an idle page lets Chrome stop producing begin-frames, whereas skipped rAF callbacks still wake every vsync.
   */
  private scheduleFrame(now: number) {
    const wait = this.nextFrame - now;
    if (wait > 12) {
      this.wakeTimer = window.setTimeout(() => {
        this.timerWake = true;
        this.raf = requestAnimationFrame(this.frame);
      }, wait - 8);
    }
    else this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (vsync: number) => {
    // A rAF requested mid-interval may run straight away with the previous vsync's timestamp,
    // so after a timer wake-up the timer has already done the gating and the clock is the real time.
    const woke = this.timerWake;
    this.timerWake = false;
    const now = woke ? performance.now() : vsync;
    // Cap the frame rate: high-refresh displays would otherwise render 120+ frames a second.
    // While paused the scene is static, so a few frames a second keep it responsive.
    // An unfocused window is being watched rather than played, so it gets a lower cap too.
    const cap = this.simPaused ? 10 : document.hasFocus() ? this.frameCap : Math.min(this.frameCap || 20, 20);
    if (cap > 0) {
      // Frame slots keep the average rate exact on any refresh rate (e.g. 60 on a 144 Hz display), not 1/n of it.
      const interval = 1000 / cap;
      if (this.nextFrame - now > interval) this.nextFrame = now;
      if (!woke && now < this.nextFrame - 1) {
        this.scheduleFrame(now);
        return;
      }
      this.nextFrame = Math.max(this.nextFrame + interval, now - interval / 2);
    }
    this.scheduleFrame(now);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.simPaused) this.simulate(dt);
    if (this.targeting && !this.canAct()) this.targeting = null;
    this.updateCamera(dt);
    this.updateWalk(now);
    this.updateCursorAndAoe();
    sound.setListener(this.renderer.camX, this.renderer.camY);
    this.renderer.render(this.simPaused ? 1 : Math.min(1, this.acc / DT), this.simPaused ? 0 : dt);
    this.hud.update(this.simPaused ? 0 : dt, this.targeting, () => sound.play('tick', 0.6));
  };

  private tick() {
    const tick = this.sim.tick;
    // Host: this turn adds the players just admitted, who then need the state as of its end.
    const joining = !!this.net?.lockstep.isHost && tick % TURN_TICKS === 0 && this.net.session.hasJoiners;
    let cmds: Command[];
    if (this.net) cmds = this.net.lockstep.commandsFor(tick);
    else {
      cmds = this.pending;
      this.pending = [];
    }
    for (const b of this.bots) cmds = cmds.concat(b.think(this.sim));
    this.sim.step(cmds);
    for (const e of this.sim.events) this.handleEvent(e);
    if (joining) {
      this.joinColors = [];
      this.net!.session.sendState({ tick: this.sim.tick, sim: this.sim.snapshot(), bots: encodeState(this.bots.map((b) => b.snapshot())) });
    }
    if (this.net && this.sim.tick % HASH_EVERY === 0) this.net.lockstep.hash(this.sim.tick, hashString(this.sim.stateHash()));
  }

  /** Advances the sim by `dt` seconds of real time. */
  private simulate(dt: number) {
    if (!this.net || this.net.lockstep.isHost) {
      // Offline, and for the host (whose clock everyone follows), play in real time.
      this.acc += dt;
      let steps = 0;
      while (this.acc >= DT && steps < 8) {
        this.acc -= DT;
        steps++;
        this.tick();
      }
      if (steps === 8) this.acc = 0;
      return;
    }
    // A client can only play turns the host has sent. Keep a few ticks in hand for jitter, and
    // run slightly fast or slow to hold that buffer steady, rather than stuttering.
    const ls = this.net.lockstep;
    let avail = ls.available(this.sim.tick);
    const excess = avail - BUFFER_TICKS;
    if (excess > 40) {
      // Far behind (e.g. just loaded, or the tab was asleep): fast-forward.
      for (let i = 0; i < excess - 2 && i < 300; i++) this.tick();
      this.acc = 0;
      return;
    }
    this.acc += dt * (excess > 6 ? 1.5 : excess > 1 ? 1.1 : excess < 0 ? 0.9 : 1);
    let steps = 0;
    while (this.acc >= DT && avail > 0 && steps < 8) {
      this.acc -= DT;
      avail--;
      steps++;
      this.tick();
    }
    // Starved: wait for the host rather than banking time to burst through later.
    if (avail <= 0) this.acc = Math.min(this.acc, DT);
  }
}

// ---------- main menu ----------

function escapeHtml(t: string) {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function showMenu(notice = '') {
  const s = loadSettings();
  const menu = document.createElement('div');
  menu.id = 'menu';
  menu.innerHTML = `
    <div class="title">WARLOCKS</div>
    <div class="panel frame main-menu">
      <input data-name maxlength="16" spellcheck="false" autocomplete="off">
      <button class="wc-btn big" data-quick>Quick Play</button>
      <button class="wc-btn big" data-host>Host Game</button>
      <div class="join-row">
        <input data-code placeholder="Code" maxlength="12" spellcheck="false" autocomplete="off">
        <button class="wc-btn" data-join>Join</button>
      </div>
      <div class="mp-notice ${notice ? '' : 'hidden'}">${escapeHtml(notice)}</div>
    </div>`;
  app.appendChild(menu);
  const q = <T extends HTMLElement>(sel: string) => menu.querySelector<T>(sel)!;
  const nameInput = q<HTMLInputElement>('[data-name]');
  const codeInput = q<HTMLInputElement>('[data-code]');
  nameInput.value = s.name;
  const leave = () => {
    s.name = nameInput.value.trim() || DEFAULTS.name;
    saveSettings(s);
    sound.ensure();
    sound.setVolume(VOLUME);
    sound.play('click');
    menu.remove();
    return { name: s.name, color: 0 };
  };
  const join = () => {
    const code = normalizeCode(codeInput.value);
    if (code.length < 4) {
      codeInput.focus();
      return;
    }
    showLobby(NetSession.join(code, leave()));
  };
  q('[data-quick]').addEventListener('click', () => quickPlay(1, leave()));
  q('[data-host]').addEventListener('click', () => showLobby(NetSession.host(leave(), RULES, DIFFICULTY, s.bots)));
  q('[data-join]').addEventListener('click', join);
  codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && join());
}

/** Quick Play: try public room `n`, moving to the next one if its game has started. */
function quickPlay(n: number, me: { name: string; color: number }) {
  showLobby(NetSession.public(n, me, RULES, DIFFICULTY));
}

/** The lobby, for host and clients alike. A host alone with computer players plays offline. */
function showLobby(session: NetSession) {
  const el = document.createElement('div');
  el.id = 'menu';
  el.className = 'lobby';
  const invite = `${location.origin}${location.pathname}?join=${session.code}`;
  // The role can change while this view is up (public rooms); onRole then rebuilds it.
  const hostView = session.isHost;
  el.innerHTML = `
    <div class="title">WARLOCKS</div>
    <div class="panel frame lobby-panel">
      ${session.isPublic ? '' : `<div class="lobby-code"><b>${session.code}</b> <button class="wc-btn" data-copy>Copy link</button></div>`}
      <div class="lobby-status" data-status></div>
      <table class="lobby-players" data-players></table>
      ${hostView ? '<button class="wc-btn small add-bot" data-addbot>+ Computer</button>' : ''}
      <div class="buttons">
        <button class="wc-btn big" data-leave>Leave</button>
        ${hostView ? '<button class="wc-btn big" data-startmp>Start</button>' : ''}
      </div>
    </div>`;
  app.appendChild(el);
  const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const status = q<HTMLElement>('[data-status]');
  const render = (l: LobbyState | null) => {
    // `g`: the host is mid-game, and we're waiting to be let in.
    status.textContent = !l ? (session.isPublic ? 'Searching…' : 'Connecting…') : l.g ? 'Joining…' : '';
    status.classList.toggle('hidden', !!l && !l.g);
    q<HTMLElement>('[data-players]').classList.toggle('hidden', !l || !!l.g);
    if (!l || l.g) return;
    const host = hostView && session.isHost;
    q<HTMLElement>('[data-players]').innerHTML = l.slots.map((x, i) => {
      const remove = host && !x.peer ? `<button class="wc-btn small" data-rmbot="${i}">✕</button>` : '';
      return `<tr class="${x.peer === session.selfId ? 'me' : ''}"><td><span class="swatch" style="background:${PLAYER_COLORS[x.color].css}"></span></td><td>${escapeHtml(x.name)}</td><td>${remove}</td></tr>`;
    }).join('');
    if (host) {
      q<HTMLButtonElement>('[data-addbot]').disabled = l.slots.length >= MAX_PLAYERS;
      q<HTMLButtonElement>('[data-startmp]').disabled = l.slots.length < 2;
    }
  };
  const close = () => el.remove();
  const remember = () => {
    if (session.isPublic) return;
    const s = loadSettings();
    s.bots = session.botCount;
    saveSettings(s);
  };
  session.events = {
    onLobby: render,
    onStart: (info, ls, state) => {
      close();
      startNetGame(session, info, ls, state);
    },
    onRole: () => {
      close();
      showLobby(session);
    },
    onClosed: (reason, retry) => {
      close();
      if (retry && session.isPublic && session.publicRoom < PUBLIC_ROOMS) quickPlay(session.publicRoom + 1, { name: loadSettings().name, color: 0 });
      else showMenu(reason);
    },
  };
  render(session.lobby);
  if (import.meta.env.DEV) (window as unknown as { __session: NetSession }).__session = session;
  el.querySelector('[data-copy]')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(invite).then(() => (q('[data-copy]').textContent = 'Copied'));
  });
  q('[data-leave]').addEventListener('click', () => {
    sound.play('click');
    session.events.onClosed = undefined;
    session.close();
    close();
    showMenu();
  });
  if (!hostView) return;
  q('[data-addbot]').addEventListener('click', () => session.setBots(session.botCount + 1));
  q<HTMLElement>('[data-players]').addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-rmbot]')) session.setBots(session.botCount - 1);
  });
  q('[data-startmp]').addEventListener('click', () => {
    sound.ensure();
    sound.play('click');
    remember();
    // Even alone with computer players the game stays online, so others can join it.
    session.startGame();
  });
  // Quick Play doesn't wait in a lobby: people join the game whenever they arrive.
  if (session.isPublic && !session.inGame) session.startGame();
}

function startNetGame(session: NetSession, info: StartInfo, lockstep: Lockstep, state?: GameState) {
  sound.ensure();
  sound.setVolume(VOLUME);
  const game = new Game({
    players: info.players, seed: info.seed, rules: info.rules, difficulty: info.difficulty,
    localId: lockstep.localId, net: { session, lockstep }, state,
  }, (again) => {
    if (again) {
      if (session.isHost) session.reopenLobby();
      else session.leaveGame();
      showLobby(session);
    } else {
      session.events.onClosed = undefined;
      session.close();
      showMenu();
    }
  });
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
}

function startGame(name: string, bots: number, rules?: Partial<SimRules>, dev?: DevOptions) {
  sound.ensure();
  sound.setVolume(VOLUME);
  const game = new Game(localSetup(name, bots, rules), (again) => {
    if (again) startGame(name, bots, rules, dev);
    else showMenu();
  }, dev);
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
  return game;
}

async function boot() {
  // Marcellus's old-style figures make 0 and 1 look like O and I, so digits come from Cinzel.
  const digits = new FontFace('HudDigits', `url(${cinzelDigits})`, { unicodeRange: 'U+0030-0039' });
  document.fonts.add(digits);
  const fonts = Promise.all([digits.load(), document.fonts.load('16px Marcellus')]).catch(() => {});
  await Promise.all([loadUnitModels(), loadObstacleModels(), fonts]);
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) {
    const name = new URLSearchParams(location.search).get('name');
    history.replaceState(null, '', location.pathname);
    showLobby(NetSession.join(joinCode, { name: (import.meta.env.DEV && name) || loadSettings().name, color: 0 }));
  } else if (import.meta.env.DEV && new URLSearchParams(location.search).has('public')) {
    const p = new URLSearchParams(location.search);
    quickPlay(Number(p.get('public')) || 1, { name: p.get('name') ?? loadSettings().name, color: 0 });
  } else if (import.meta.env.DEV && new URLSearchParams(location.search).has('host')) {
    const p = new URLSearchParams(location.search);
    showLobby(NetSession.host({ name: p.get('name') ?? loadSettings().name, color: 0 }, RULES, DIFFICULTY, Number(p.get('bots') ?? 0)));
  } else if (import.meta.env.DEV && new URLSearchParams(location.search).has('autostart')) {
    const p = new URLSearchParams(location.search);
    const dev: DevOptions = {};
    if (p.has('fps')) dev.frameCap = Number(p.get('fps'));
    if (p.has('res')) dev.pixelRatio = Number(p.get('res'));
    if (p.has('aa')) dev.antialias = p.get('aa') === '1';
    const rules = { ...RULES, rounds: 1, startingGold: 120, arenaShape: (p.get('arena') ?? 'square') as SimRules['arenaShape'] };
    const game = startGame('Player', Number(p.get('bots') ?? 5), rules, dev);
    const internals = game as unknown as { pending: Command[]; sim: Sim };
    if (p.get('phase') === 'fight' || p.get('phase') === 'shrink') {
      setTimeout(() => {
        internals.pending.push({ pid: 0, type: 'ready' });
        internals.sim.phaseTimer = 0;
      }, 500);
    }
    if (p.get('phase') === 'shrink') {
      setInterval(() => {
        internals.sim.shrinkTimer = 0;
      }, 500);
    }
  } else {
    showMenu();
  }
}

void boot();
