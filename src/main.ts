import './style.css';
import {
  BOT_NAMES, DT, PLAYER_COLORS, SPELLS, SPELL_ORDER, SPELL_STATS, WARLOCK_RADIUS, type SpellId,
} from './config';
import { Bot, type Difficulty } from './ai/bot';
import { Sim } from './sim/game';
import type { Command, GameEvent, PlayerSetup } from './sim/types';
import { GameRenderer } from './render/renderer';
import { makeCursor } from './render/textures';
import { Hud } from './ui/hud';
import { SoundSystem, type Sfx } from './audio';

interface Settings {
  name: string;
  color: number;
  bots: number;
  difficulty: Difficulty;
  rounds: number;
  quickCast: boolean;
  lockCamera: boolean;
  volume: number;
}

const DEFAULTS: Settings = {
  name: 'Player', color: 0, bots: 5, difficulty: 'normal', rounds: 10, quickCast: false, lockCamera: false, volume: 0.6,
};

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('warlocks.settings') ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: Settings) {
  localStorage.setItem('warlocks.settings', JSON.stringify(s));
}

const sound = new SoundSystem();
const app = document.getElementById('app')!;
const CURSORS = { normal: makeCursor('normal'), target: makeCursor('target'), targetEnemy: makeCursor('targetEnemy') };
document.body.style.cursor = CURSORS.normal;

const CAST_SFX: Partial<Record<SpellId, Sfx>> = {
  fireball: 'fireball', homing: 'homing', boomerang: 'boomerang', gravity: 'gravity', link: 'link',
  swap: 'swap', thrust: 'thrust', shield: 'shield', windwalk: 'windwalk',
};

class Game {
  private sim: Sim;
  private bots: Bot[];
  private renderer: GameRenderer;
  private hud: Hud;
  private root: HTMLElement;
  private localId = 0;
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

  constructor(private settings: Settings, private onExit: (again: boolean) => void) {
    const players: PlayerSetup[] = [{ name: settings.name || 'Player', color: settings.color, isBot: false }];
    const names = [...BOT_NAMES].sort(() => Math.random() - 0.5);
    const colors = PLAYER_COLORS.map((_, i) => i).filter((c) => c !== settings.color);
    for (let i = 0; i < settings.bots; i++) players.push({ name: names[i], color: colors[i], isBot: true });
    const seed = (Math.random() * 2 ** 31) | 0;
    this.sim = new Sim({ players, seed, rounds: settings.rounds });
    this.bots = this.sim.players.filter((p) => p.isBot).map((p) => new Bot(p.id, seed ^ (p.id * 7919), settings.difficulty));
    this.lockCamera = settings.lockCamera;

    this.root = document.createElement('div');
    this.root.id = 'game';
    const viewport = document.createElement('div');
    viewport.id = 'viewport';
    this.root.appendChild(viewport);
    app.appendChild(this.root);

    this.renderer = new GameRenderer(viewport, this.sim, this.localId);
    this.hud = new Hud(this.root, this.sim, this.localId, this.renderer, {
      onSpell: (id) => this.activateSpell(id),
      onBuy: (id) => {
        sound.play('click');
        this.pending.push({ pid: this.localId, type: 'buy', spell: id });
      },
      onReady: () => {
        sound.play('click');
        this.pending.push({ pid: this.localId, type: 'ready' });
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
    this.raf = requestAnimationFrame(this.frame);
  }

  private exit(again: boolean) {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
    this.hud.dispose();
    this.renderer.dispose();
    this.root.remove();
    document.body.style.cursor = CURSORS.normal;
    this.onExit(again);
  }

  private setPaused(p: boolean) {
    this.paused = p;
    this.hud.setPaused(p);
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
    this.pending.push({ pid: this.localId, type: 'move', x, y });
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
      this.pending.push({ pid: this.localId, type: 'cast', spell: id, x: this.me.x, y: this.me.y });
      this.targeting = null;
      return;
    }
    if (this.settings.quickCast && this.mouse.inside) {
      const w = this.renderer.pick(this.mouse.x, this.mouse.y);
      if (w) {
        this.pending.push({ pid: this.localId, type: 'cast', spell: id, x: w.x, y: w.y });
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
          if (this.canAct()) this.pending.push({ pid: this.localId, type: 'cast', spell: this.targeting, x: w.x, y: w.y });
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
        if (this.canAct()) this.pending.push({ pid: this.localId, type: 'stop' });
        return;
      }
      const spell = SPELL_ORDER.find((id) => SPELLS[id].hotkey === k);
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
        const lvl = this.me.spells[this.targeting] ?? 1;
        if (this.targeting === 'meteor') aoe = { x: w.x, y: w.y, r: SPELL_STATS.meteor.radius(lvl) };
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

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (!this.paused) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= DT && steps < 5) {
        this.acc -= DT;
        steps++;
        const cmds = this.pending;
        this.pending = [];
        for (const b of this.bots) cmds.push(...b.think(this.sim));
        this.sim.step(cmds);
        for (const e of this.sim.events) this.handleEvent(e);
      }
      if (steps === 5) this.acc = 0;
    }
    if (this.targeting && !this.canAct()) this.targeting = null;
    this.updateCamera(dt);
    this.updateCursorAndAoe();
    sound.setListener(this.renderer.camX, this.renderer.camY);
    this.renderer.render(this.paused ? 1 : this.acc / DT, this.paused ? 0 : dt);
    this.hud.update(this.paused ? 0 : dt, this.targeting, () => sound.play('tick', 0.6));
  };
}

// ---------- main menu ----------

function showMenu() {
  const s = loadSettings();
  const menu = document.createElement('div');
  menu.id = 'menu';
  const opt = (vals: (string | number)[], cur: string | number, labels?: string[]) =>
    vals.map((v, i) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${labels ? labels[i] : v}</option>`).join('');
  menu.innerHTML = `
    <div class="title">WARLOCKS</div>
    <div class="subtitle">A tribute to the Warcraft III custom map</div>
    <div class="panel frame">
      <div class="form-row">Name <input data-k="name" maxlength="16" value=""></div>
      <div class="form-row">Colour <div class="color-swatches">${PLAYER_COLORS.map((c, i) => `<div data-c="${i}" title="${c.name}" style="background:${c.css}" class="${i === s.color ? 'sel' : ''}"></div>`).join('')}</div></div>
      <div class="form-row">Opponents <select data-k="bots">${opt([1, 2, 3, 4, 5, 6, 7], s.bots)}</select></div>
      <div class="form-row">Difficulty <select data-k="difficulty">${opt(['easy', 'normal', 'hard'], s.difficulty, ['Easy', 'Normal', 'Insane'])}</select></div>
      <div class="form-row">Rounds <select data-k="rounds">${opt([3, 5, 10, 15, 20], s.rounds)}</select></div>
      <div class="form-row">Quick cast <input type="checkbox" data-k="quickCast" ${s.quickCast ? 'checked' : ''}></div>
      <div class="form-row">Lock camera to hero <input type="checkbox" data-k="lockCamera" ${s.lockCamera ? 'checked' : ''}></div>
      <div class="form-row" style="justify-content:center;margin-top:18px"><button class="wc-btn big" data-start>Start Game</button></div>
    </div>
    <div class="help">
      <b>Right-click</b> move &nbsp;·&nbsp; <b>Hotkey + Left-click</b> cast &nbsp;·&nbsp; <b>S</b> stop &nbsp;·&nbsp; <b>Esc / Right-click</b> cancel targeting<br>
      <b>Arrows / screen edge</b> scroll &nbsp;·&nbsp; <b>Space</b> centre on hero &nbsp;·&nbsp; <b>C</b> camera lock &nbsp;·&nbsp; <b>Wheel</b> zoom &nbsp;·&nbsp; <b>Tab</b> scores &nbsp;·&nbsp; <b>F10</b> menu<br>
      Spells: ${SPELL_ORDER.map((id) => `${SPELLS[id].name} <b>${SPELLS[id].hotkey}</b>`).join(' · ')}
    </div>`;
  app.appendChild(menu);
  (menu.querySelector('[data-k="name"]') as HTMLInputElement).value = s.name;
  menu.querySelectorAll<HTMLElement>('.color-swatches div').forEach((d) =>
    d.addEventListener('click', () => {
      menu.querySelectorAll('.color-swatches div').forEach((x) => x.classList.remove('sel'));
      d.classList.add('sel');
      s.color = Number(d.dataset.c);
    }));
  const start = () => {
    const get = (k: string) => menu.querySelector(`[data-k="${k}"]`) as HTMLInputElement;
    s.name = get('name').value.trim() || 'Player';
    s.bots = Number(get('bots').value);
    s.difficulty = get('difficulty').value as Difficulty;
    s.rounds = Number(get('rounds').value);
    s.quickCast = get('quickCast').checked;
    s.lockCamera = get('lockCamera').checked;
    saveSettings(s);
    sound.ensure();
    sound.setVolume(s.volume);
    sound.play('click');
    menu.remove();
    startGame(s);
  };
  menu.querySelector('[data-start]')!.addEventListener('click', start);
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') start();
  });
}

function startGame(s: Settings) {
  const game = new Game(s, (again) => {
    if (again) startGame(loadSettings());
    else showMenu();
  });
  if (import.meta.env.DEV) (window as unknown as { __game: Game }).__game = game;
}

showMenu();
