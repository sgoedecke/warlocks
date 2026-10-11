import './style.css';
import {
  ALL_SPELLS, BOT_NAMES, DT, PLAYER_COLORS, SPELLS, WARLOCK_CARD, WARLOCK_RADIUS, type SpellId,
} from './config';
import { Bot, type Difficulty } from './ai/bot';
import { Sim } from './sim/game';
import type { Command, GameEvent, PlayerSetup, SimRules } from './sim/types';
import { GameRenderer } from './render/renderer';
import { loadRealIcons, makeCursor } from './render/textures';
import { Hud, playerName, SHOP_ICON_PATHS } from './ui/hud';
import { SoundSystem, type Sfx } from './audio';
import { addFiles, assetStatus, initAssets, onAssetStatus, removeArchive, type ArchiveRole, type AssetStatus } from './assets/loader';
import { clearMdxCache } from './render/mdx';
import { BUFFER_TICKS, HASH_EVERY, hashString, type Lockstep } from './net/lockstep';
import { workerInterval } from './net/timer';
import { MAX_PLAYERS, NetSession, normalizeCode, type LobbyState, type NetRules, type StartInfo } from './net/session';

/** Dev-only overrides of the graphics preset, for benchmarking. */
interface GraphicsOverrides {
  frameCap?: number;
  pixelRatio?: number;
}

interface Settings extends GraphicsOverrides {
  name: string;
  color: number;
  bots: number;
  difficulty: Difficulty;
  rounds: number;
  mode: 'round' | 'deathmatch';
  pointLimit: number;
  teams: 'ffa' | '2teams';
  arenaShape: 'square' | 'circle';
  startingGold: number;
  quickCast: boolean;
  lockCamera: boolean;
  volume: number;
  graphics: GraphicsPreset;
  /** MSAA costs roughly a quarter of the GPU time per frame; classic WC3 had none either. */
  antialias: boolean;
}

type GraphicsPreset = 'saver' | 'balanced' | 'high';
/**
 * Frame cap (0 = every display refresh) and the highest device pixel ratio the 3D view renders at.
 * GPU cost scales with pixels drawn, so these two settings set most of the game's power draw.
 */
const GRAPHICS: Record<GraphicsPreset, { label: string; frameCap: number; pixelRatio: number }> = {
  saver: { label: 'Battery saver (30 fps)', frameCap: 30, pixelRatio: 1 },
  balanced: { label: 'Balanced (60 fps)', frameCap: 60, pixelRatio: 1.5 },
  high: { label: 'High (display rate)', frameCap: 0, pixelRatio: 2 },
};

const DEFAULTS: Settings = {
  name: 'Player', color: 0, bots: 5, difficulty: 'normal', rounds: 10, mode: 'round', pointLimit: 20, teams: 'ffa', arenaShape: 'square', startingGold: 10, quickCast: false, lockCamera: false, volume: 0.6,
  graphics: 'balanced', antialias: true,
};

function loadSettings(): Settings {
  try {
    const s: Settings = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('warlocks.settings') ?? '{}') };
    if (!(s.graphics in GRAPHICS)) s.graphics = DEFAULTS.graphics;
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: Settings) {
  const { frameCap: _f, pixelRatio: _p, ...persisted } = s;
  localStorage.setItem('warlocks.settings', JSON.stringify(persisted));
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
}

function rulesFrom(s: Settings): NetRules {
  return { mode: s.mode, rounds: s.rounds, pointLimit: s.pointLimit, teams: s.teams, arenaShape: s.arenaShape, startingGold: s.startingGold };
}

function singlePlayerSetup(settings: Settings): GameSetup {
  const players: PlayerSetup[] = [{ name: settings.name || 'Player', color: settings.color, isBot: false }];
  const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
  const colors = PLAYER_COLORS.map((_, i) => i).filter((c) => c !== settings.color);
  for (let i = 0; i < settings.bots; i++) players.push({ name: names[i], color: colors[i], isBot: true });
  return { players, seed: (Math.random() * 2 ** 31) | 0, rules: rulesFrom(settings), difficulty: settings.difficulty, localId: 0 };
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
  private acc = 0;
  private last = performance.now();
  private raf = 0;
  private paused = false;
  private lockCamera: boolean;
  private disposers: (() => void)[] = [];
  private frameCap: number;

  constructor(private settings: Settings, private onExit: (again: boolean) => void, setup = singlePlayerSetup(settings)) {
    const { players, seed } = setup;
    this.localId = setup.localId;
    this.net = setup.net;
    this.sim = new Sim({ players, seed, rules: setup.rules });
    // Bots are deterministic, so in multiplayer every peer runs all of them rather than sending their orders.
    this.bots = this.sim.players.filter((p) => p.isBot).map((p) => new Bot(p.id, seed ^ (p.id * 7919), setup.difficulty));
    this.lockCamera = settings.lockCamera;

    this.root = document.createElement('div');
    this.root.id = 'game';
    const viewport = document.createElement('div');
    viewport.id = 'viewport';
    this.root.appendChild(viewport);
    app.appendChild(this.root);

    const gfx = GRAPHICS[settings.graphics];
    this.frameCap = settings.frameCap ?? gfx.frameCap;
    this.renderer = new GameRenderer(viewport, this.sim, this.localId, { pixelRatio: settings.pixelRatio ?? gfx.pixelRatio, antialias: settings.antialias });
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
    this.hud.bindVolume(() => sound.volume, (v) => {
      sound.setVolume(v);
      this.settings.volume = v;
      saveSettings(this.settings);
    });
    this.bindInput();
    sound.startAmbient();
    this.hud.message(`Welcome to <span style="color:#ffcc00">Warlocks</span>! Knock your enemies into the lava. Last warlock standing wins the round.`, 14);
    this.hud.message(`Right-click to move. Press a spell hotkey then left-click to aim. <span style="color:#ffcc00">Space</span> centres the camera, <span style="color:#ffcc00">C</span> toggles camera lock.`, 14);
    if (this.net) this.bindNet();
    this.raf = requestAnimationFrame(this.frame);
  }

  private bindNet() {
    const { session } = this.net!;
    const btn = (act: string) => this.root.querySelector<HTMLElement>(`[data-act="${act}"]`);
    btn('again')!.textContent = 'Back to Lobby';
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-act="quit"]')) b.textContent = 'Leave Game';
    btn('resume')!.insertAdjacentHTML('beforebegin', '<div class="mp-note">Online game: the game keeps running while this menu is open.</div>');
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
      onStart: (info, ls) => {
        this.dispose();
        startNetGame(session, info, ls);
      },
    };
    this.chatInput = document.createElement('input');
    this.chatInput.className = 'chat-input hidden';
    this.chatInput.maxLength = 120;
    this.chatInput.placeholder = 'Say:';
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
    if (this.net) this.net.lockstep.submit(cmd);
    else this.pending.push(cmd);
  }

  private setPaused(p: boolean) {
    this.paused = p;
    this.hud.setPaused(p);
  }

  /** Online the game menu doesn't stop the clock: the other players keep playing. */
  private get simPaused() {
    return this.paused && !this.net;
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
    if (this.settings.quickCast && this.mouse.inside) {
      const w = this.renderer.pick(this.mouse.x, this.mouse.y);
      if (w) {
        this.queue({ pid: this.localId, type: 'cast', spell: id, x: w.x, y: w.y });
        return;
      }
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
    this.listen(window, 'keyup', (e) => this.keys.delete(e.key));
    this.listen(window, 'keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      sound.ensure();
      this.keys.add(e.key);
      const k = e.key.toUpperCase();
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
      if (e.key === ' ' || e.key === 'F1') {
        e.preventDefault();
        this.renderer.centerOn(this.me.x, this.me.y);
        return;
      }
      if (this.paused || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (k === 'C') {
        this.lockCamera = !this.lockCamera;
        this.hud.message(`Camera lock ${this.lockCamera ? 'enabled' : 'disabled'}.`, 3);
        return;
      }
      if (k === 'S') {
        this.targeting = null;
        if (this.canAct()) this.queue({ pid: this.localId, type: 'stop' });
        return;
      }
      const spell = WARLOCK_CARD.find((id) => SPELLS[id].hotkey === k && (this.me.spells[id] ?? 0) > 0)
        ?? ALL_SPELLS.find((id) => SPELLS[id].hotkey === k && (this.me.spells[id] ?? 0) > 0);
      if (spell) this.activateSpell(spell);
    });
  }

  private updateCamera(dt: number) {
    const r = this.renderer;
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
    } else if (this.lockCamera && this.me.alive) {
      const k = 1 - Math.exp(-dt * 6);
      r.camX += (this.me.x - r.camX) * k;
      r.camY += (this.me.y - r.camY) * k;
    }
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
        if (e.soundPath) sound.playFile(e.soundPath, 'horn', 0.9);
        else sound.play('horn', 0.9);
        break;
      case 'effect':
        if (e.soundPath) sound.playFile(e.soundPath, 'reflect', 1, e);
        break;
      case 'reflect':
        if (e.soundPath) sound.playFile(e.soundPath, 'reflect', 1, e);
        else sound.playAt('reflect', e.x, e.y);
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
    this.updateCursorAndAoe();
    sound.setListener(this.renderer.camX, this.renderer.camY);
    this.renderer.render(this.simPaused ? 1 : Math.min(1, this.acc / DT), this.simPaused ? 0 : dt);
    this.hud.update(this.simPaused ? 0 : dt, this.targeting, () => sound.play('tick', 0.6));
  };

  private tick() {
    const tick = this.sim.tick;
    let cmds: Command[];
    if (this.net) cmds = this.net.lockstep.commandsFor(tick);
    else {
      cmds = this.pending;
      this.pending = [];
    }
    for (const b of this.bots) cmds = cmds.concat(b.think(this.sim));
    this.sim.step(cmds);
    for (const e of this.sim.events) this.handleEvent(e);
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

const ROLE_LABEL: Record<ArchiveRole, string> = { map: 'Map', base: 'war3.mpq', expansion: 'War3x.mpq', patch: 'War3Patch.mpq' };

function bindAssetPanel(menu: HTMLElement) {
  const statusEl = menu.querySelector<HTMLElement>('[data-asset-status]')!;
  const input = menu.querySelector<HTMLInputElement>('[data-asset-input]')!;
  let busy = false;
  const render = (st: AssetStatus) => {
    const byRole = new Map(st.archives.map((a) => [a.role, a.name]));
    const row = (role: ArchiveRole) => {
      const name = byRole.get(role);
      return `<div class="asset-row ${name ? 'ok' : ''}"><span>${ROLE_LABEL[role]}</span><span>${name ? `${escapeHtml(name)} <a href="#" data-remove="${role}" title="Forget">✕</a>` : '<i>not loaded</i>'}</span></div>`;
    };
    statusEl.innerHTML = (['map', 'base', 'expansion', 'patch'] as ArchiveRole[]).map(row).join('')
      + (st.hasMap && !st.hasWarlockModel ? '<div class="asset-warn">That map has no BloodelfWizard model; is it Warlocks?</div>' : '')
      + (st.error ? `<div class="asset-warn">${escapeHtml(st.error)}</div>` : '')
      + (busy ? '<div class="asset-busy">Reading…</div>' : '');
    statusEl.querySelectorAll<HTMLElement>('[data-remove]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      void removeArchive(a.dataset.remove as ArchiveRole);
    }));
  };
  const off = onAssetStatus(render);
  const add = async (files: Iterable<File>) => {
    busy = true;
    render(assetStatus());
    try {
      await addFiles(files);
    } finally {
      busy = false;
      render(assetStatus());
    }
  };
  input.addEventListener('change', () => input.files && void add([...input.files]));
  menu.addEventListener('dragover', (e) => {
    e.preventDefault();
    menu.classList.add('dropping');
  });
  menu.addEventListener('dragleave', () => menu.classList.remove('dropping'));
  menu.addEventListener('drop', (e) => {
    e.preventDefault();
    menu.classList.remove('dropping');
    if (e.dataTransfer?.files.length) void add([...e.dataTransfer.files]);
  });
  new MutationObserver((_, obs) => {
    if (!menu.isConnected) {
      off();
      obs.disconnect();
    }
  }).observe(app, { childList: true });
}

function escapeHtml(t: string) {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function showMenu(notice = '') {
  const s = loadSettings();
  const menu = document.createElement('div');
  menu.id = 'menu';
  const opt = (vals: (string | number)[], cur: string | number, labels?: string[]) =>
    vals.map((v, i) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${labels ? labels[i] : v}</option>`).join('');
  menu.innerHTML = `
    <div class="title">WARLOCKS</div>
    <div class="subtitle">A tribute to the Warcraft III custom map</div>
    <div class="menu-cols">
    <div class="panel frame">
      <div class="form-row">Name <input data-k="name" maxlength="16" value=""></div>
      <div class="form-row">Colour <div class="color-swatches">${PLAYER_COLORS.map((c, i) => `<div data-c="${i}" title="${c.name}" style="background:${c.css}" class="${i === s.color ? 'sel' : ''}"></div>`).join('')}</div></div>
      <div class="form-row">Opponents <select data-k="bots">${opt([1, 2, 3, 4, 5, 6, 7], s.bots)}</select></div>
      <div class="form-row">Difficulty <select data-k="difficulty">${opt(['easy', 'normal', 'hard'], s.difficulty, ['Easy', 'Normal', 'Insane'])}</select></div>
      <div class="form-row">Mode <select data-k="mode">${opt(['round', 'deathmatch'], s.mode, ['Round', 'Deathmatch'])}</select></div>
      <div class="form-row">Rounds <select data-k="rounds">${opt([3, 5, 10, 15, 20], s.rounds)}</select></div>
      <div class="form-row">Point limit <select data-k="pointLimit">${opt([10, 15, 20, 30, 50], s.pointLimit)}</select></div>
      <div class="form-row">Teams <select data-k="teams">${opt(['ffa', '2teams'], s.teams, ['FFA', '2 Teams'])}</select></div>
      <div class="form-row">Arena <select data-k="arenaShape">${opt(['square', 'circle'], s.arenaShape, ['Square', 'Circle'])}</select></div>
      <div class="form-row">Starting gold <select data-k="startingGold">${opt([10, 20, 50, 100], s.startingGold)}</select></div>
      <div class="form-row">Quick cast <input type="checkbox" data-k="quickCast" ${s.quickCast ? 'checked' : ''}></div>
      <div class="form-row">Lock camera to hero <input type="checkbox" data-k="lockCamera" ${s.lockCamera ? 'checked' : ''}></div>
      <div class="form-row">Graphics <select data-k="graphics">${opt(Object.keys(GRAPHICS), s.graphics, Object.values(GRAPHICS).map((g) => g.label))}</select></div>
      <div class="form-row">Anti-aliasing <input type="checkbox" data-k="antialias" ${s.antialias ? 'checked' : ''}></div>
      <div class="form-row" style="justify-content:center;margin-top:18px"><button class="wc-btn big" data-start>Start Game</button></div>
    </div>
    <div class="side-col">
    <div class="panel frame mp-panel">
      <div class="assets-title">Online</div>
      <div class="mp-row">
        <button class="wc-btn" data-host>Host Game</button>
        <input data-code placeholder="Code" maxlength="12" spellcheck="false" autocomplete="off">
        <button class="wc-btn" data-join>Join</button>
      </div>
      <div class="mp-hint">Hosting uses the settings on the left.</div>
      <div class="mp-notice ${notice ? '' : 'hidden'}" data-notice>${escapeHtml(notice)}</div>
    </div>
    <div class="panel frame assets-panel">
      <div class="assets-title">Original assets</div>
      <div data-asset-status></div>
      <label class="wc-btn">Add files…<input type="file" multiple accept=".w3m,.w3x,.mpq" data-asset-input hidden></label>
      <div class="assets-note">
        Drop <b>Warlock 0.88b</b> (.w3m) here to use its warlock model, spell effects and announcer voice.
        For the Blizzard art the map borrows (missiles, doodads, terrain tiles, icons), also add
        <b>war3.mpq</b>, <b>War3x.mpq</b> and <b>War3Patch.mpq</b> from a classic (1.26 or earlier) install.
        Anything missing is drawn procedurally. Files never leave your browser.
      </div>
    </div>
    </div>
    </div>
    <div class="help">
      <b>Right-click</b> move &nbsp;·&nbsp; <b>Hotkey + Left-click</b> cast &nbsp;·&nbsp; <b>S</b> stop &nbsp;·&nbsp; <b>Esc / Right-click</b> cancel targeting<br>
      <b>Arrows / screen edge</b> scroll &nbsp;·&nbsp; <b>Space</b> centre on hero &nbsp;·&nbsp; <b>C</b> camera lock &nbsp;·&nbsp; <b>Wheel</b> zoom &nbsp;·&nbsp; <b>Tab</b> scores &nbsp;·&nbsp; <b>F10</b> menu<br>
      Spells: ${WARLOCK_CARD.map((id) => `${SPELLS[id].name} <b>${SPELLS[id].hotkey}</b>`).join(' · ')}
    </div>`;
  app.appendChild(menu);
  (menu.querySelector('[data-k="name"]') as HTMLInputElement).value = s.name;
  bindAssetPanel(menu);
  menu.querySelectorAll<HTMLElement>('.color-swatches div').forEach((d) =>
    d.addEventListener('click', () => {
      menu.querySelectorAll('.color-swatches div').forEach((x) => x.classList.remove('sel'));
      d.classList.add('sel');
      s.color = Number(d.dataset.c);
    }));
  const collect = () => {
    const get = (k: string) => menu.querySelector(`[data-k="${k}"]`) as HTMLInputElement;
    s.name = get('name').value.trim() || 'Player';
    s.bots = Number(get('bots').value);
    s.difficulty = get('difficulty').value as Difficulty;
    s.mode = get('mode').value as Settings['mode'];
    s.rounds = Number(get('rounds').value);
    s.pointLimit = Number(get('pointLimit').value);
    s.teams = get('teams').value as Settings['teams'];
    s.arenaShape = get('arenaShape').value as Settings['arenaShape'];
    s.startingGold = Number(get('startingGold').value);
    s.quickCast = get('quickCast').checked;
    s.lockCamera = get('lockCamera').checked;
    s.graphics = get('graphics').value as GraphicsPreset;
    s.antialias = get('antialias').checked;
    saveSettings(s);
    sound.ensure();
    sound.setVolume(s.volume);
    sound.play('click');
    menu.remove();
  };
  const start = () => {
    collect();
    startGame(s);
  };
  const codeInput = menu.querySelector<HTMLInputElement>('[data-code]')!;
  const join = () => {
    const code = normalizeCode(codeInput.value);
    if (code.length < 4) {
      codeInput.focus();
      return;
    }
    collect();
    showLobby(NetSession.join(code, { name: s.name, color: s.color }));
  };
  menu.querySelector('[data-start]')!.addEventListener('click', start);
  menu.querySelector('[data-host]')!.addEventListener('click', () => {
    collect();
    showLobby(NetSession.host({ name: s.name, color: s.color }, rulesFrom(s), s.difficulty, Math.min(s.bots, MAX_PLAYERS - 1)));
  });
  menu.querySelector('[data-join]')!.addEventListener('click', join);
  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target === codeInput) join();
    else start();
  });
}

const MODE_LABEL = { round: 'Rounds', deathmatch: 'Deathmatch' };
const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Insane' };

function rulesSummary(r: NetRules) {
  return [
    r.mode === 'round' ? `${r.rounds} rounds` : `${MODE_LABEL[r.mode]} to ${r.pointLimit} points`,
    r.teams === 'ffa' ? 'free for all' : '2 teams',
    `${r.arenaShape} arena`,
    `${r.startingGold} starting gold`,
  ].join(' · ');
}

/** The multiplayer lobby, for host and clients alike. */
function showLobby(session: NetSession) {
  const el = document.createElement('div');
  el.id = 'menu';
  el.className = 'lobby';
  const invite = `${location.origin}${location.pathname}?join=${session.code}`;
  el.innerHTML = `
    <div class="title">WARLOCKS</div>
    <div class="subtitle">${session.isHost ? 'Hosting an online game' : 'Joining an online game'}</div>
    <div class="panel frame lobby-panel">
      <div class="lobby-code">Room code <b>${session.code}</b> <button class="wc-btn" data-copy>Copy invite link</button></div>
      <div class="lobby-status" data-status></div>
      <table class="lobby-players" data-players></table>
      ${session.isHost ? `<div class="form-row">Computer players <span class="stepper"><button class="wc-btn" data-bots="-1">−</button><span data-botcount></span><button class="wc-btn" data-bots="1">+</button></span></div>
      <div class="form-row">Difficulty <select data-difficulty>${(['easy', 'normal', 'hard'] as Difficulty[]).map((d) => `<option value="${d}">${DIFFICULTY_LABEL[d]}</option>`).join('')}</select></div>` : ''}
      <div class="lobby-rules" data-rules></div>
      <div class="buttons">
        <button class="wc-btn big" data-leave>Leave</button>
        ${session.isHost ? '<button class="wc-btn big" data-startmp>Start Game</button>' : ''}
      </div>
      <div class="assets-note">Players connect to each other directly. The room code is all a friend needs: share it or the invite link.</div>
    </div>`;
  app.appendChild(el);
  const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const render = (l: LobbyState | null) => {
    const status = q<HTMLElement>('[data-status]');
    if (!l) {
      status.textContent = 'Connecting to the host…';
      return;
    }
    const humans = l.slots.filter((x) => x.peer).length;
    status.textContent = session.isHost
      ? (humans > 1 ? `${humans} players connected.` : 'Waiting for players to join…')
      : 'Connected. Waiting for the host to start…';
    q<HTMLElement>('[data-players]').innerHTML = l.slots.map((x) => {
      const tags = [x.peer === session.hostId ? 'host' : '', x.peer === session.selfId ? 'you' : '', x.peer ? '' : DIFFICULTY_LABEL[l.difficulty].toLowerCase()].filter(Boolean).join(', ');
      return `<tr><td><span class="swatch" style="background:${PLAYER_COLORS[x.color].css}"></span></td><td>${escapeHtml(x.name)}</td><td class="tags">${tags}</td></tr>`;
    }).join('');
    q<HTMLElement>('[data-rules]').textContent = rulesSummary(l.rules);
    if (session.isHost) {
      q<HTMLElement>('[data-botcount]').textContent = String(session.botCount);
      q<HTMLSelectElement>('[data-difficulty]').value = l.difficulty;
      q<HTMLButtonElement>('[data-startmp]').disabled = l.slots.length < 2;
    }
  };
  const close = () => el.remove();
  session.events = {
    onLobby: render,
    onStart: (info, ls) => {
      close();
      startNetGame(session, info, ls);
    },
    onClosed: (reason) => {
      close();
      showMenu(reason);
    },
  };
  render(session.lobby);
  if (import.meta.env.DEV) (window as unknown as { __session: NetSession }).__session = session;
  q('[data-copy]').addEventListener('click', () => {
    void navigator.clipboard?.writeText(invite).then(() => (q('[data-copy]').textContent = 'Copied!'));
  });
  q('[data-leave]').addEventListener('click', () => {
    sound.play('click');
    session.events.onClosed = undefined;
    session.close();
    close();
    showMenu();
  });
  if (session.isHost) {
    el.querySelectorAll<HTMLElement>('[data-bots]').forEach((b) => b.addEventListener('click', () => {
      session.setBots(session.botCount + Number(b.dataset.bots));
    }));
    q<HTMLSelectElement>('[data-difficulty]').addEventListener('change', (e) => session.setDifficulty((e.target as HTMLSelectElement).value as Difficulty));
    q('[data-startmp]').addEventListener('click', () => {
      sound.ensure();
      sound.play('click');
      session.startGame();
    });
  }
}

function startNetGame(session: NetSession, info: StartInfo, lockstep: Lockstep) {
  const s = loadSettings();
  sound.ensure();
  sound.setVolume(s.volume);
  const game = new Game(s, (again) => {
    if (again) {
      if (session.isHost) session.reopenLobby();
      else session.leaveGame();
      showLobby(session);
    } else {
      session.events.onClosed = undefined;
      session.close();
      showMenu();
    }
  }, {
    players: info.players, seed: info.seed, rules: info.rules, difficulty: info.difficulty,
    localId: lockstep.localId, net: { session, lockstep },
  });
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
}

function startGame(s: Settings) {
  const game = new Game(s, (again) => {
    if (again) startGame(loadSettings());
    else showMenu();
  });
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
  return game;
}

let iconsLoading: Promise<void> = Promise.resolve();
onAssetStatus(() => {
  clearMdxCache();
  iconsLoading = loadRealIcons(SHOP_ICON_PATHS);
});

async function boot() {
  await initAssets();
  await iconsLoading;
  const joinCode = new URLSearchParams(location.search).get('join');
  if (joinCode) {
    const name = new URLSearchParams(location.search).get('name');
    history.replaceState(null, '', location.pathname);
    const s = loadSettings();
    if (import.meta.env.DEV && name) s.name = name;
    showLobby(NetSession.join(joinCode, { name: s.name, color: s.color }));
  } else if (import.meta.env.DEV && new URLSearchParams(location.search).has('host')) {
    const s = loadSettings();
    const p = new URLSearchParams(location.search);
    if (p.has('name')) s.name = p.get('name')!;
    showLobby(NetSession.host({ name: s.name, color: s.color }, rulesFrom(s), s.difficulty, Number(p.get('bots') ?? 0)));
  } else if (import.meta.env.DEV && new URLSearchParams(location.search).has('autostart')) {
    const p = new URLSearchParams(location.search);
    const s = { ...loadSettings(), bots: Number(p.get('bots') ?? 5), difficulty: 'hard' as Difficulty, rounds: 1, mode: 'round' as const, startingGold: 120, lockCamera: true, volume: 0, arenaShape: (p.get('arena') ?? 'square') as Settings['arenaShape'] };
    if (p.has('fps')) s.frameCap = Number(p.get('fps'));
    if (p.has('res')) s.pixelRatio = Number(p.get('res'));
    if (p.has('aa')) s.antialias = p.get('aa') === '1';
    const game = startGame(s);
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
