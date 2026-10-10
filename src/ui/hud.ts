import {
  ARENA_START_RADIUS, PLAYER_COLORS, SPELLS, SPELL_ORDER, WARLOCK_HP, upgradePrice, type SpellId,
} from '../config';
import type { Sim } from '../sim/game';
import type { GameEvent, Warlock } from '../sim/types';
import { goldIcon, spellIcon } from '../render/textures';
import type { GameRenderer } from '../render/renderer';

export interface HudCallbacks {
  onSpell: (id: SpellId) => void;
  onBuy: (id: SpellId) => void;
  onReady: () => void;
  onMinimap: (x: number, y: number, button: number) => void;
  onPause: () => void;
  onResume: () => void;
  onQuit: () => void;
  onPlayAgain: () => void;
}

interface FloatText {
  text: string;
  color: string;
  x: number;
  y: number;
  t: number;
}

const MINIMAP_EXTENT = 1400;

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function playerName(p: Warlock) {
  return `<span style="color:${PLAYER_COLORS[p.color].css}">${esc(p.name)}</span>`;
}

export class Hud {
  readonly root: HTMLElement;
  private overlay: HTMLCanvasElement;
  private og: CanvasRenderingContext2D;
  private minimap: HTMLCanvasElement;
  private mg: CanvasRenderingContext2D;
  private els: Record<string, HTMLElement> = {};
  private cmdButtons = new Map<SpellId, HTMLElement>();
  private shopItems = new Map<SpellId, HTMLElement>();
  private floats: FloatText[] = [];
  private mbTimer = 0;
  private hoverSpell: { id: SpellId; shop: boolean } | null = null;
  private centerTimer = 0;
  private errorTimer = 0;
  private gold = goldIcon();
  private lastCountdown = -1;
  paused = false;

  constructor(container: HTMLElement, private sim: Sim, private localId: number, private renderer: GameRenderer, private cb: HudCallbacks) {
    this.overlay = document.createElement('canvas');
    this.overlay.id = 'overlay';
    container.appendChild(this.overlay);
    this.og = this.overlay.getContext('2d')!;

    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div class="topbar">
        <div class="top-left">
          <button class="wc-btn" data-act="menu">Menu (F10)</button>
          <button class="wc-btn" data-act="scores">Scores (Tab)</button>
        </div>
        <div class="top-center frame"><div class="clock">0:00</div><div class="round">Round 1</div></div>
        <div class="resources frame">
          <div class="gold"><img src="${this.gold}"><span data-el="gold">0</span></div>
          <div data-el="alive">Alive 0</div>
        </div>
      </div>
      <div class="multiboard"><div class="mb-title">Warlocks</div><table></table></div>
      <div class="messages"></div>
      <div class="center-text"></div>
      <div class="error-text"></div>
      <div class="tooltip hidden"></div>
      <div class="console frame">
        <div class="minimap-frame"><canvas width="340" height="340"></canvas></div>
        <div class="info">
          <div class="portrait-wrap"><div class="portrait"></div><div class="portrait-hp">100 / 100</div></div>
          <div class="unit-info">
            <div class="name"></div>
            <div class="cls">Warlock</div>
            <div class="stats"></div>
            <div class="buffs"></div>
          </div>
        </div>
        <div class="command-card"></div>
      </div>
      <div class="shop frame hidden">
        <h2>Spell Shop</h2>
        <div class="sub">Click a spell to learn or upgrade it. Hover for details.</div>
        <div class="shop-grid"></div>
        <div class="shop-footer">
          <div class="gold"><img src="${this.gold}"><span data-el="shopGold">0</span> gold</div>
          <div data-el="shopTimer">Next round in 20</div>
          <button class="wc-btn big" data-act="ready">Ready</button>
        </div>
      </div>
      <div class="modal frame pause hidden">
        <h2>Game Menu</h2>
        <div class="form-row">Volume <input type="range" min="0" max="1" step="0.05" data-el="volume"></div>
        <div class="buttons">
          <button class="wc-btn big" data-act="resume">Return to Game</button>
          <button class="wc-btn big" data-act="quit">Quit to Main Menu</button>
        </div>
      </div>
      <div class="modal frame gameover hidden">
        <h2>Victory</h2>
        <div data-el="winner"></div>
        <table data-el="final"></table>
        <div class="buttons">
          <button class="wc-btn big" data-act="again">Play Again</button>
          <button class="wc-btn big" data-act="quit">Main Menu</button>
        </div>
      </div>`;
    container.appendChild(this.root);
    const q = <T extends HTMLElement>(sel: string) => this.root.querySelector(sel) as T;
    this.root.querySelectorAll<HTMLElement>('[data-el]').forEach((e) => (this.els[e.dataset.el!] = e));
    this.els.clock = q('.clock');
    this.els.round = q('.round');
    this.els.mb = q('.multiboard');
    this.els.mbTable = q('.multiboard table');
    this.els.messages = q('.messages');
    this.els.center = q('.center-text');
    this.els.error = q('.error-text');
    this.els.tooltip = q('.tooltip');
    this.els.portrait = q('.portrait');
    this.renderer.attachPortrait(this.els.portrait);
    this.els.portraitHp = q('.portrait-hp');
    this.els.name = q('.unit-info .name');
    this.els.stats = q('.unit-info .stats');
    this.els.buffs = q('.unit-info .buffs');
    this.els.shop = q('.shop');
    this.els.pause = q('.pause');
    this.els.gameover = q('.gameover');
    this.minimap = q<HTMLCanvasElement>('.minimap-frame canvas');
    this.mg = this.minimap.getContext('2d')!;

    this.root.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'menu') cb.onPause();
      else if (act === 'scores') this.toggleScores();
      else if (act === 'ready') cb.onReady();
      else if (act === 'resume') cb.onResume();
      else if (act === 'quit') cb.onQuit();
      else if (act === 'again') cb.onPlayAgain();
    });
    q('.mb-title').addEventListener('click', () => this.toggleScores());
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());

    this.buildCommandCard(q('.command-card'));
    this.buildShop(q('.shop-grid'));
    this.bindMinimap();
    this.resize();
    window.addEventListener('resize', this.onResize);
  }

  toggleScores() {
    this.els.mb.classList.toggle('collapsed');
  }

  bindVolume(get: () => number, set: (v: number) => void) {
    const el = this.els.volume as HTMLInputElement;
    el.value = String(get());
    el.addEventListener('input', () => set(parseFloat(el.value)));
  }

  private onResize = () => this.resize();

  private resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.overlay.width = this.overlay.clientWidth * dpr;
    this.overlay.height = this.overlay.clientHeight * dpr;
    this.og.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  isOverUi(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el || !el.closest) return false;
    return !!el.closest('.console, .topbar > *, .multiboard, .shop, .modal');
  }

  private buildCommandCard(card: HTMLElement) {
    const slots: (SpellId | null)[] = Array(12).fill(null);
    for (const id of SPELL_ORDER) slots[SPELLS[id].row * 4 + SPELLS[id].col] = id;
    for (const id of slots) {
      const b = document.createElement('div');
      b.className = 'cmd empty';
      card.appendChild(b);
      if (!id) continue;
      b.innerHTML = `<div class="cd" style="--p:1"></div><div class="cd-text"></div><div class="hk-badge">${SPELLS[id].hotkey}</div><div class="lvl"></div>`;
      b.style.backgroundImage = `url(${spellIcon(id)})`;
      b.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (e.button === 0 && !b.classList.contains('empty')) this.cb.onSpell(id);
      });
      b.addEventListener('mouseenter', () => (this.hoverSpell = { id, shop: false }));
      b.addEventListener('mouseleave', () => (this.hoverSpell = null));
      this.cmdButtons.set(id, b);
    }
  }

  pressButton(id: SpellId) {
    const b = this.cmdButtons.get(id);
    if (!b) return;
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 110);
  }

  private buildShop(grid: HTMLElement) {
    for (const id of SPELL_ORDER) {
      const it = document.createElement('div');
      it.className = 'shop-item';
      it.innerHTML = `<div class="icon" style="background-image:url(${spellIcon(id)})"></div><div class="label">${SPELLS[id].name}</div><div class="pips"></div><div class="price"></div>`;
      it.addEventListener('mousedown', (e) => {
        if (e.button === 0) this.cb.onBuy(id);
      });
      it.addEventListener('mouseenter', () => (this.hoverSpell = { id, shop: true }));
      it.addEventListener('mouseleave', () => (this.hoverSpell = null));
      grid.appendChild(it);
      this.shopItems.set(id, it);
    }
  }

  private bindMinimap() {
    const toWorld = (e: MouseEvent) => {
      const r = this.minimap.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width;
      const v = (e.clientY - r.top) / r.height;
      return { x: (u * 2 - 1) * MINIMAP_EXTENT, y: (1 - v * 2) * MINIMAP_EXTENT };
    };
    let dragging = false;
    this.minimap.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const w = toWorld(e);
      this.cb.onMinimap(w.x, w.y, e.button);
      dragging = e.button === 0;
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = toWorld(e);
      this.cb.onMinimap(w.x, w.y, 0);
    });
    window.addEventListener('mouseup', () => (dragging = false));
  }

  // ---------- messages ----------

  message(html: string, life = 9) {
    const d = document.createElement('div');
    d.innerHTML = html;
    this.els.messages.appendChild(d);
    while (this.els.messages.children.length > 7) this.els.messages.firstChild!.remove();
    setTimeout(() => (d.style.opacity = '0'), life * 1000);
    setTimeout(() => d.remove(), life * 1000 + 1100);
  }

  center(html: string, time = 2) {
    this.els.center.innerHTML = html;
    this.els.center.style.opacity = '1';
    this.centerTimer = time;
  }

  error(msg: string) {
    this.els.error.textContent = msg;
    this.els.error.style.opacity = '1';
    this.errorTimer = 2;
  }

  onEvent(e: GameEvent) {
    const P = (id: number) => this.sim.players[id];
    switch (e.t) {
      case 'death': {
        const victim = P(e.pid);
        if (e.killer >= 0) {
          const how = e.inLava ? 'pushed into the lava by' : 'killed by';
          this.message(`${playerName(victim)} was ${how} ${playerName(P(e.killer))}!`);
        } else {
          this.message(`${playerName(victim)} ${e.inLava ? 'burned to death in the lava' : 'has died'}.`);
        }
        break;
      }
      case 'bounty':
        if (e.pid === this.localId) this.floats.push({ text: `+${e.gold}`, color: '#ffcc00', x: e.x, y: e.y, t: 0 });
        break;
      case 'roundWinner':
        if (e.pid >= 0) {
          const w = P(e.pid);
          this.center(`${playerName(w)}<small>wins round ${this.sim.round}!</small>`, 3.2);
          this.message(`${playerName(w)} has won round ${this.sim.round}.`);
        } else {
          this.center(`Draw!<small>No warlock survived round ${this.sim.round}.</small>`, 3.2);
        }
        break;
      case 'phase':
        if (e.phase === 'shop') {
          this.message(`<span style="color:#ffcc00">Round ${this.sim.round} of ${this.sim.totalRounds}.</span> Visit the spell shop to spend your gold.`);
        } else if (e.phase === 'fight') {
          this.center('Fight!', 1.2);
        } else if (e.phase === 'gameOver') {
          this.showGameOver();
        }
        break;
      case 'error':
        if (e.pid === this.localId) this.error(e.msg);
        break;
      case 'buy':
        if (e.pid === this.localId) {
          const l = e.level;
          this.message(`You ${l === 1 ? 'learned' : 'upgraded'} <span style="color:#ffcc00">${SPELLS[e.spell].name}</span>${l > 1 ? ` to level ${l}` : ''}.`, 5);
        }
        break;
      default:
        break;
    }
  }

  private showGameOver() {
    const ranking = this.sim.ranking();
    const winner = ranking[0];
    const local = winner.id === this.localId;
    (this.els.gameover.querySelector('h2') as HTMLElement).textContent = local ? 'Victory!' : 'Defeat';
    this.els.winner.innerHTML = `${playerName(winner)} is the greatest warlock!`;
    this.els.final.innerHTML = `<tr><th>Player</th><th>Wins</th><th>Kills</th><th>Deaths</th><th>Damage</th></tr>` +
      ranking.map((p) => `<tr><td>${playerName(p)}</td><td>${p.stats.wins}</td><td>${p.stats.kills}</td><td>${p.stats.deaths}</td><td>${Math.round(p.stats.damage)}</td></tr>`).join('');
    this.els.gameover.classList.remove('hidden');
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.els.pause.classList.toggle('hidden', !p);
  }

  // ---------- per-frame ----------

  update(dt: number, targeting: SpellId | null, countdownTick: (n: number) => void) {
    const sim = this.sim;
    const me = sim.players[this.localId];
    this.els.gold.textContent = String(me.gold);
    const alive = sim.players.filter((p) => p.alive).length;
    this.els.alive.textContent = `Alive ${alive}/${sim.players.length}`;

    const t = Math.floor(sim.roundTime);
    if (sim.phase === 'shop') this.els.clock.textContent = `Shop ${Math.ceil(Math.max(0, sim.phaseTimer))}`;
    else this.els.clock.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    this.els.round.textContent = `Round ${sim.round} / ${sim.totalRounds}`;

    if (sim.phase === 'countdown') {
      const n = Math.ceil(sim.phaseTimer);
      if (n !== this.lastCountdown && n > 0) {
        this.lastCountdown = n;
        this.center(`${n}<small>Round ${sim.round}</small>`, 1.1);
        countdownTick(n);
      }
    } else this.lastCountdown = -1;

    this.centerTimer -= dt;
    if (this.centerTimer <= 0) this.els.center.style.opacity = '0';
    this.errorTimer -= dt;
    if (this.errorTimer <= 0) this.els.error.style.opacity = '0';

    // Portrait & unit info
    this.els.portraitHp.textContent = `${Math.ceil(Math.max(0, me.hp))} / ${WARLOCK_HP}`;
    this.els.portraitHp.style.color = me.hp / WARLOCK_HP > 0.5 ? '#2ad52a' : me.hp / WARLOCK_HP > 0.25 ? '#e0d020' : '#e02020';
    this.els.name.innerHTML = playerName(me);
    const statsHtml = `<div>Kills: <span>${me.stats.kills}</span></div><div>Wins: <span>${me.stats.wins}</span></div>` +
      `<div>Deaths: <span>${me.stats.deaths}</span></div><div>Damage: <span>${Math.round(me.stats.damage)}</span></div>`;
    if (this.els.stats.innerHTML !== statsHtml) this.els.stats.innerHTML = statsHtml;
    const buffs: string[] = [];
    if (me.shield > 0) buffs.push(`<img title="Shield" src="${spellIcon('shield', 32)}">`);
    if (me.windwalk > 0) buffs.push(`<img title="Windwalk" src="${spellIcon('windwalk', 32)}">`);
    if (me.link) buffs.push(`<img title="Link" src="${spellIcon('link', 32)}">`);
    if (me.inLava && me.alive) buffs.push(`<span style="color:#ff6020">Burning!</span>`);
    if (!me.alive) buffs.push(`<span style="color:#aaa">Dead - waiting for next round</span>`);
    const bh = buffs.join('');
    if (this.els.buffs.innerHTML !== bh) this.els.buffs.innerHTML = bh;

    // Command card
    for (const [id, b] of this.cmdButtons) {
      const lvl = me.spells[id] ?? 0;
      b.classList.toggle('empty', lvl === 0);
      if (lvl === 0) {
        b.style.backgroundImage = '';
        continue;
      }
      b.style.backgroundImage = `url(${spellIcon(id)})`;
      const def = SPELLS[id];
      const cd = me.cooldowns[id] ?? 0;
      const total = def.cooldown(lvl);
      (b.querySelector('.cd') as HTMLElement).style.setProperty('--p', cd > 0 ? String(1 - cd / total) : '1');
      const txt = cd > 0 ? (cd < 1 ? cd.toFixed(1) : String(Math.ceil(cd))) : '';
      const ct = b.querySelector('.cd-text') as HTMLElement;
      if (ct.textContent !== txt) ct.textContent = txt;
      const lt = b.querySelector('.lvl') as HTMLElement;
      if (lt.textContent !== String(lvl)) lt.textContent = String(lvl);
      b.classList.toggle('active', targeting === id);
      b.classList.toggle('disabled', !me.alive);
    }

    // Shop
    const shopOpen = sim.phase === 'shop';
    this.els.shop.classList.toggle('hidden', !shopOpen);
    if (shopOpen) {
      this.els.shopGold.textContent = String(me.gold);
      const waiting = sim.players.filter((p) => !p.ready).length;
      this.els.shopTimer.textContent = me.ready
        ? `Waiting for ${waiting} player${waiting === 1 ? '' : 's'}… ${Math.ceil(sim.phaseTimer)}`
        : `Round ${sim.round} starts in ${Math.ceil(Math.max(0, sim.phaseTimer))}`;
      (this.root.querySelector('[data-act="ready"]') as HTMLButtonElement).disabled = me.ready;
      for (const [id, it] of this.shopItems) {
        const lvl = me.spells[id] ?? 0;
        const def = SPELLS[id];
        const max = lvl >= def.maxLevel;
        const price = upgradePrice(id, lvl);
        const pips = Array.from({ length: def.maxLevel }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
        const pe = it.querySelector('.pips') as HTMLElement;
        if (pe.innerHTML !== pips) pe.innerHTML = pips;
        const pr = it.querySelector('.price') as HTMLElement;
        const ptxt = max ? 'Max level' : `${lvl ? 'Upgrade' : 'Learn'}: ${price}`;
        if (pr.textContent !== ptxt) pr.textContent = ptxt;
        pr.classList.toggle('max', max);
        it.classList.toggle('unaffordable', !max && price > me.gold);
      }
    }

    this.updateTooltip(me);

    this.mbTimer -= dt;
    if (this.mbTimer <= 0) {
      this.mbTimer = 0.25;
      this.updateMultiboard();
    }

    this.drawOverlay(dt);
    this.drawMinimap();
  }

  private updateTooltip(me: Warlock) {
    const tt = this.els.tooltip;
    if (!this.hoverSpell) {
      tt.classList.add('hidden');
      return;
    }
    const { id, shop } = this.hoverSpell;
    const def = SPELLS[id];
    const lvl = me.spells[id] ?? 0;
    const showLvl = shop ? Math.min(def.maxLevel, lvl + 1) : Math.max(1, lvl);
    let cost = '';
    if (shop) {
      cost = lvl >= def.maxLevel
        ? `<div class="tt-cost">Maximum level reached</div>`
        : `<div class="tt-cost"><img src="${this.gold}">${upgradePrice(id, lvl)}</div>`;
    }
    const html = `<div class="tt-title">${shop ? (lvl ? 'Upgrade ' : 'Learn ') : ''}${def.name} (<span class="hk">${def.hotkey}</span>) - [Level ${showLvl}]</div>${cost}<div>${def.describe(showLvl)}</div><div class="tt-cd">Cooldown: ${def.cooldown(showLvl).toFixed(1)} seconds</div>`;
    if (tt.innerHTML !== html) tt.innerHTML = html;
    tt.classList.remove('hidden');
    if (shop) {
      // Sit beside the shop panel, or over its top-right corner if the window is narrow.
      const r = this.els.shop.getBoundingClientRect();
      const left = Math.min(r.right + 10, window.innerWidth - tt.offsetWidth - 8);
      tt.style.left = `${left}px`;
      tt.style.top = `${r.top}px`;
      tt.style.right = 'auto';
      tt.style.bottom = 'auto';
    } else {
      tt.style.left = '';
      tt.style.top = '';
      tt.style.right = '';
      tt.style.bottom = '';
    }
  }

  private updateMultiboard() {
    const rows = this.sim.ranking().map((p) => {
      const cls = this.sim.phase !== 'shop' && !p.alive ? 'dead' : '';
      return `<tr class="${cls}"><td>${playerName(p)}${p.id === this.localId ? ' *' : ''}</td><td>${p.stats.wins}</td><td>${p.stats.kills}</td><td>${p.stats.deaths}</td></tr>`;
    });
    const html = `<tr><th>Player</th><th>W</th><th>K</th><th>D</th></tr>${rows.join('')}`;
    if (this.els.mbTable.innerHTML !== html) this.els.mbTable.innerHTML = html;
    (this.els.mb.querySelector('.mb-title') as HTMLElement).textContent = `Warlocks — Round ${this.sim.round}/${this.sim.totalRounds}`;
  }

  private drawOverlay(dt: number) {
    const g = this.og;
    const w = this.overlay.clientWidth;
    const h = this.overlay.clientHeight;
    g.clearRect(0, 0, w, h);
    // WC3 style health bars: fixed pixel size, colour shifts green -> yellow -> red.
    for (const p of this.sim.players) {
      if (!p.alive || (p.windwalk > 0 && p.id !== this.localId)) continue;
      const s = this.renderer.worldToScreen(p.x, p.y, 118);
      if (!s.visible) continue;
      const bw = 56;
      const bh = 6;
      const x = Math.round(s.x - bw / 2);
      const y = Math.round(s.y);
      const f = Math.max(0, p.hp) / WARLOCK_HP;
      g.fillStyle = '#000';
      g.fillRect(x - 1, y - 1, bw + 2, bh + 2);
      g.fillStyle = '#1a1a1a';
      g.fillRect(x, y, bw, bh);
      const r = f > 0.5 ? Math.round(255 * (1 - f) * 2) : 255;
      const gr = f > 0.5 ? 255 : Math.round(255 * f * 2);
      g.fillStyle = `rgb(${r},${gr},0)`;
      g.fillRect(x, y, Math.round(bw * f), bh);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(x, y, Math.round(bw * f), 2);
    }
    // Floating bounty text
    g.font = `bold 16px ${getComputedStyle(document.body).fontFamily}`;
    g.textAlign = 'center';
    for (const f of this.floats) {
      f.t += dt;
      const s = this.renderer.worldToScreen(f.x, f.y, 120);
      const a = Math.max(0, 1 - f.t / 2);
      g.globalAlpha = a;
      g.fillStyle = '#000';
      g.fillText(f.text, s.x + 1, s.y - f.t * 30 + 1);
      g.fillStyle = f.color;
      g.fillText(f.text, s.x, s.y - f.t * 30);
    }
    g.globalAlpha = 1;
    this.floats = this.floats.filter((f) => f.t < 2);
  }

  private drawMinimap() {
    const g = this.mg;
    const S = this.minimap.width;
    const toM = (x: number, y: number) => [((x / MINIMAP_EXTENT) + 1) * S / 2, (1 - y / MINIMAP_EXTENT) * S / 2];
    g.fillStyle = '#7a1e04';
    g.fillRect(0, 0, S, S);
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, '#c04a0a');
    grd.addColorStop(1, '#5a1402');
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    const r = (this.sim.arenaRadius / MINIMAP_EXTENT) * S / 2;
    g.fillStyle = '#6a5a40';
    g.beginPath();
    g.arc(S / 2, S / 2, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#7d6c50';
    g.beginPath();
    g.arc(S / 2, S / 2, (ARENA_START_RADIUS * 0.35 / MINIMAP_EXTENT) * S / 2, 0, Math.PI * 2);
    g.fill();
    for (const p of this.sim.players) {
      if (!p.alive || (p.windwalk > 0 && p.id !== this.localId)) continue;
      const [x, y] = toM(p.x, p.y);
      g.fillStyle = '#000';
      g.fillRect(x - 6, y - 6, 12, 12);
      g.fillStyle = PLAYER_COLORS[p.color].css;
      g.fillRect(x - 5, y - 5, 10, 10);
    }
    const corners = this.renderer.viewCorners();
    if (corners.length === 4) {
      g.strokeStyle = '#fff';
      g.lineWidth = 2;
      g.beginPath();
      corners.forEach((c, i) => {
        const [x, y] = toM(c.x, c.y);
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      });
      g.closePath();
      g.stroke();
    }
  }

  dispose() {
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    this.overlay.remove();
  }
}
