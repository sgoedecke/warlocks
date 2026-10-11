import {
  ALL_SPELLS, ICE_TILE, ITEMS, MAP_MAX, MAP_MIN, TILE_SIZE, PLAYER_COLORS, SPELLS, WARLOCK_CARD, WARLOCK_HP, productName, spellCooldown, spellPrice, type ItemId, type ProductId, type SpellId,
} from '../config';
import type { Sim } from '../sim/game';
import type { GameEvent, Warlock } from '../sim/types';
import { btnIcon, goldIcon, spellIcon } from '../render/textures';
import type { GameRenderer } from '../render/renderer';
import { WORLD_PX, WORLD_TILES, proceduralWorldTexture } from '../render/tileTextures';

export interface HudCallbacks {
  onSpell: (id: SpellId) => void;
  onBuy: (id: ProductId) => void;
  onToggle?: (spell: 'firespray' | 'splitter') => void;
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

const MINIMAP_EXTENT = MAP_MAX;

// The original shop is a row of per-player shop units whose command cards hold the
// researches/items (object data u000-u003). Navigation swaps the shop unit; on the
// sub-shops the same ability goes back to the Merchant. Slots are 4x3, row-major.
type ShopPage = 'merchant' | 'spells1' | 'spells2' | 'items';
type ShopSlot = ProductId | `nav:${ShopPage}` | 'toggle:firespray' | 'toggle:splitter' | null;
const BTN = 'ReplaceableTextures\\CommandButtons\\';
const SHOP_LAYOUT: Record<ShopPage, { title: string; icon: string; slots: ShopSlot[] }> = {
  merchant: {
    title: 'Merchant', icon: `${BTN}BTNAcolyte.blp`,
    slots: ['nav:items', 'nav:spells1', 'nav:spells2', null, 'inventory', null, null, null, 'rangeMastery', 'lifestealMastery', 'aoeMastery', null],
  },
  spells1: {
    title: 'Spells 1', icon: `${BTN}BTNNecromancerAdept.blp`,
    slots: ['nav:merchant', 'lightning', 'teleport', 'drain', 'fireball', 'boomerang', 'thrust', 'firespray', 'toggle:firespray', 'homing', 'displacement', 'bouncer'],
  },
  spells2: {
    title: 'Spells 2', icon: `${BTN}BTNTomeOfRetraining.blp`,
    slots: ['nav:merchant', 'meteor', 'rush', 'link', null, 'windwalk', 'shield', 'freeze', 'toggle:splitter', 'splitter', 'timeshift', 'gravity'],
  },
  items: {
    title: 'Items', icon: `${BTN}BTNDust.blp`,
    slots: ['nav:merchant', 'pendant', 'boots', 'helm', null, 'cape', 'soj', 'sword', null, 'staff', 'mask', 'aegis'],
  },
};
const MERCHANT_ICONS = {
  inventory: `${BTN}BTNPackBeast.blp`,
  rangeMastery: 'ReplaceableTextures\\PassiveButtons\\PASBTNTrueShot.blp',
  lifestealMastery: 'ReplaceableTextures\\PassiveButtons\\PASBTNMagicImmunity.blp',
  aoeMastery: 'ReplaceableTextures\\PassiveButtons\\PASBTNScatterRockets.blp',
};
// Per-frame HUD writes go through these so unchanged values don't invalidate style and layout.
const lastText = new WeakMap<Element, string>();
const lastHtml = new WeakMap<Element, string>();
const lastStyle = new WeakMap<HTMLElement, Record<string, string>>();
function setText(el: Element, s: string) {
  if (lastText.get(el) === s) return;
  lastText.set(el, s);
  el.textContent = s;
}
function setHtml(el: Element, s: string) {
  if (lastHtml.get(el) === s) return;
  lastHtml.set(el, s);
  el.innerHTML = s;
}
function setStyle(el: HTMLElement, prop: string, value: string) {
  let m = lastStyle.get(el);
  if (!m) lastStyle.set(el, (m = {}));
  if (m[prop] === value) return;
  m[prop] = value;
  el.style.setProperty(prop, value);
}

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
  /** One command-card slot per hotkey, showing whichever of its spells the player has learned. */
  private cmdSlots: { el: HTMLElement; spells: SpellId[]; id: SpellId | null; cooling: boolean }[] = [];
  private shopItems = new Map<ProductId, HTMLElement>();
  private shopCells: { page: ShopPage; el: HTMLElement; toggle?: 'firespray' | 'splitter' }[] = [];
  private shopPage: ShopPage = 'merchant';
  private floats: FloatText[] = [];
  private mbTimer = 0;
  private hoverProduct: { id: ProductId | `nav:${ShopPage}` | `toggle:${'firespray' | 'splitter'}`; shop: boolean } | null = null;
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
          <button class="wc-btn" data-act="menu">Menu</button>
          <button class="wc-btn" data-act="scores">Scores</button>
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
      <div class="minimap-frame frame"><canvas width="340" height="340"></canvas></div>
      <div class="spellbar">
        <div class="buffs"></div>
        <div class="hpbar"><div class="hp-fill"></div><div class="hp-text"></div></div>
        <div class="command-card"></div>
      </div>
      <div class="shop frame hidden">
        <h2 data-el="shopTitle">Merchant</h2>
        <div class="shop-grid"></div>
        <div class="shop-footer">
          <div class="gold"><img src="${this.gold}"><span data-el="shopGold">0</span> gold</div>
          <div data-el="shopTimer">Next round in 20</div>
          <button class="wc-btn big" data-act="ready">Ready</button>
        </div>
      </div>
      <div class="modal frame pause hidden">
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
    this.els.hpFill = q('.hp-fill');
    this.els.hpText = q('.hp-text');
    this.els.buffs = q('.spellbar .buffs');
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

  private onResize = () => this.resize();

  private overlayW = 0;
  private overlayH = 0;
  private overlayFont = '';

  private resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.overlayW = this.overlay.clientWidth;
    this.overlayH = this.overlay.clientHeight;
    this.overlay.width = this.overlayW * dpr;
    this.overlay.height = this.overlayH * dpr;
    this.og.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.overlayFont = `bold 16px ${getComputedStyle(document.body).fontFamily}`;
  }

  private buildCommandCard(card: HTMLElement) {
    for (const first of WARLOCK_CARD) {
      const b = document.createElement('div');
      b.className = 'cmd empty';
      card.appendChild(b);
      const column = SPELLS[first].column;
      const slot = { el: b, spells: column === 'core' ? [first] : ALL_SPELLS.filter((s) => SPELLS[s].column === column), id: null as SpellId | null, cooling: false };
      b.innerHTML = `<div class="cd" style="--p:1"></div><div class="cd-text"></div><div class="hk-badge">${SPELLS[first].hotkey}</div><div class="lvl"></div>`;
      b.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        if (e.button === 0 && slot.id) this.cb.onSpell(slot.id);
      });
      b.addEventListener('mouseenter', () => (this.hoverProduct = slot.id ? { id: slot.id, shop: false } : null));
      b.addEventListener('mouseleave', () => (this.hoverProduct = null));
      this.cmdSlots.push(slot);
    }
  }

  pressButton(id: SpellId) {
    const b = this.cmdSlots.find((s) => s.id === id)?.el;
    if (!b) return;
    b.classList.add('pressed');
    setTimeout(() => b.classList.remove('pressed'), 110);
  }

  private buildShop(grid: HTMLElement) {
    for (const page of Object.keys(SHOP_LAYOUT) as ShopPage[]) {
      SHOP_LAYOUT[page].slots.forEach((slot, i) => {
        const it = document.createElement('div');
        it.className = 'shop-item';
        it.style.gridColumn = String((i % 4) + 1);
        it.style.gridRow = String(Math.floor(i / 4) + 1);
        this.shopCells.push({ page, el: it, toggle: slot?.startsWith('toggle:') ? slot.slice(7) as 'firespray' | 'splitter' : undefined });
        grid.appendChild(it);
        if (!slot) return;
        if (slot.startsWith('nav:') || slot.startsWith('toggle:')) {
          const nav = slot.startsWith('nav:') ? slot.slice(4) as ShopPage : null;
          const label = nav ? (page === 'merchant' ? SHOP_LAYOUT[nav].title : 'Back') : 'Toggle mode';
          const icon = nav ? btnIcon(page === 'merchant' ? SHOP_LAYOUT[nav].icon : SHOP_LAYOUT.merchant.icon)
            : btnIcon(slot === 'toggle:firespray' ? 'ReplaceableTextures\\CommandButtons\\BTNHumanCaptureFlag.blp' : 'ReplaceableTextures\\CommandButtons\\BTNHire.blp');
          it.classList.add('nav');
          it.innerHTML = `<div class="icon" style="background-image:url(${icon})"></div><div class="label">${label}</div><div class="price"></div>`;
          it.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (nav) this.setShopPage(nav);
            else this.cb.onToggle?.(slot.slice(7) as 'firespray' | 'splitter');
          });
          it.addEventListener('mouseenter', () => (this.hoverProduct = { id: slot as `nav:${ShopPage}`, shop: true }));
          it.addEventListener('mouseleave', () => (this.hoverProduct = null));
          return;
        }
        const id = slot as ProductId;
        const isSpell = id in SPELLS;
        const icon = isSpell ? spellIcon(id as SpellId) : id in ITEMS ? btnIcon(ITEMS[id as ItemId].icon) : btnIcon(MERCHANT_ICONS[id as keyof typeof MERCHANT_ICONS]);
        it.innerHTML = `<div class="icon" style="background-image:url(${icon})"></div><div class="label">${productName(id)}</div><div class="pips"></div><div class="price"></div>`;
        it.addEventListener('mousedown', (e) => {
          if (e.button === 0) this.cb.onBuy(id);
        });
        it.addEventListener('mouseenter', () => (this.hoverProduct = { id, shop: true }));
        it.addEventListener('mouseleave', () => (this.hoverProduct = null));
        this.shopItems.set(id, it);
      });
    }
    this.setShopPage('merchant');
  }

  private setShopPage(page: ShopPage) {
    this.shopPage = page;
    this.els.shopTitle.textContent = SHOP_LAYOUT[page].title;
    for (const c of this.shopCells) c.el.classList.toggle('off-page', c.page !== page);
    this.hoverProduct = null;
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
      case 'damageText': {
        const color = e.color === 'cyan' ? '#70e8ff' : e.color === 'green' ? '#38ff68' : e.color === 'red' ? '#ff5050' : '#ffd840';
        this.floats.push({ text: e.text, color, x: e.x, y: e.y, t: 0 });
        break;
      }
      case 'left':
        this.message(`${playerName(P(e.pid))} has left the game.`, 8);
        break;
      case 'announcement':
        this.center(e.text, 1.8);
        this.message(`<span style="color:#ffcc00">${esc(e.text)}</span>`, 6);
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
          this.message(`You bought <span style="color:#ffcc00">${productName(e.product)}</span>${l > 1 ? ` level ${l}` : ''}.`, 5);
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
    setText(this.els.gold, String(me.gold));
    const alive = sim.players.filter((p) => p.alive).length;
    setText(this.els.alive, `Alive ${alive}/${sim.players.length}`);

    const t = Math.floor(sim.roundTime);
    if (sim.phase === 'shop') setText(this.els.clock, `Shop ${Math.ceil(Math.max(0, sim.phaseTimer))}`);
    else setText(this.els.clock, `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
    setText(this.els.round, `Round ${sim.round} / ${sim.totalRounds}`);

    if (sim.phase === 'countdown') {
      const n = Math.ceil(sim.phaseTimer);
      if (n !== this.lastCountdown && n > 0) {
        this.lastCountdown = n;
        this.center(`${n}<small>Round ${sim.round}</small>`, 1.1);
        countdownTick(n);
      }
    } else this.lastCountdown = -1;

    this.centerTimer -= dt;
    if (this.centerTimer <= 0 && this.els.center.style.opacity !== '0') this.els.center.style.opacity = '0';
    this.errorTimer -= dt;
    if (this.errorTimer <= 0 && this.els.error.style.opacity !== '0') this.els.error.style.opacity = '0';

    // Health and buffs
    const hp = Math.max(0, me.hp) / WARLOCK_HP;
    setStyle(this.els.hpFill, 'width', `${(hp * 100).toFixed(1)}%`);
    setStyle(this.els.hpFill, 'background-color', hp > 0.5 ? '#2fbf3a' : hp > 0.25 ? '#d8b820' : '#d42a20');
    setText(this.els.hpText, `${Math.ceil(Math.max(0, me.hp))} / ${WARLOCK_HP}`);
    const buffs: string[] = [];
    if (me.shield > 0) buffs.push(`<img title="Shield" src="${spellIcon('shield', 48)}">`);
    if (me.windwalk > 0) buffs.push(`<img title="Windwalk" src="${spellIcon('windwalk', 48)}">`);
    if (me.link) buffs.push(`<img title="Link" src="${spellIcon('link', 48)}">`);
    if (me.inLava && me.alive) buffs.push(`<span style="color:#ff6020">Burning!</span>`);
    if (!me.alive) buffs.push(`<span style="color:#aaa">Dead: waiting for next round</span>`);
    const bh = buffs.join('');
    setHtml(this.els.buffs, bh);

    // Command card
    for (const slot of this.cmdSlots) {
      const b = slot.el;
      const id = slot.spells.find((s) => (me.spells[s] ?? 0) > 0) ?? null;
      if (id !== slot.id) {
        slot.id = id;
        if (this.hoverProduct && !this.hoverProduct.shop && b.matches(':hover')) this.hoverProduct = id ? { id, shop: false } : null;
      }
      b.classList.toggle('empty', !id);
      if (!id) continue;
      const lvl = me.spells[id]!;
      setStyle(b, 'background-image', `url(${spellIcon(id)})`);
      const cd = me.cooldowns[id] ?? 0;
      const total = spellCooldown(id, lvl);
      // Flash the button as it comes off cooldown.
      if (slot.cooling && cd <= 0) {
        b.classList.remove('ready');
        void b.offsetWidth;
        b.classList.add('ready');
      }
      slot.cooling = cd > 0;
      b.classList.toggle('cooling', cd > 0);
      // The cooldown sweep is drawn in CSS; ~100 steps is visually continuous and avoids a restyle every frame.
      setStyle(b.querySelector('.cd') as HTMLElement, '--p', cd > 0 ? (1 - cd / total).toFixed(2) : '1');
      const txt = cd > 0 ? (cd < 1 ? cd.toFixed(1) : String(Math.ceil(cd))) : '';
      setText(b.querySelector('.cd-text') as HTMLElement, txt);
      setText(b.querySelector('.lvl') as HTMLElement, String(lvl));
      b.classList.toggle('active', targeting === id);
      b.classList.toggle('disabled', !me.alive);
    }

    // Shop
    const shopOpen = sim.phase === 'shop';
    this.els.shop.classList.toggle('hidden', !shopOpen);
    if (shopOpen) {
      setText(this.els.shopGold, String(me.gold));
      const waiting = sim.players.filter((p) => !p.ready).length;
      setText(this.els.shopTimer, me.ready
        ? `Waiting for ${waiting} player${waiting === 1 ? '' : 's'}… ${Math.ceil(sim.phaseTimer)}`
        : `Round ${sim.round} starts in ${Math.ceil(Math.max(0, sim.phaseTimer))}`);
      (this.root.querySelector('[data-act="ready"]') as HTMLButtonElement).disabled = me.ready;
      for (const [id, it] of this.shopItems) {
        const isSpell = id in SPELLS;
        const lvl = isSpell ? (me.spells[id as SpellId] ?? 0) : id in ITEMS ? (me.itemSlots.find((s) => s.id === id)?.level ?? 0) : id === 'inventory' ? me.inventoryLevel : id === 'rangeMastery' ? me.IA : id === 'aoeMastery' ? me.AA : me.RA;
        const maxLevel = isSpell ? SPELLS[id as SpellId].maxLevel : id in ITEMS ? ITEMS[id as keyof typeof ITEMS].max : id === 'inventory' ? 3 : 9;
        const max = lvl >= maxLevel;
        // Learning one spell of a hotkey column removes the others from the shop.
        const column = isSpell ? SPELLS[id as SpellId].column : 'core';
        const locked = column !== 'core' && !!me.chosen[column] && me.chosen[column] !== id;
        const price = isSpell ? spellPrice(id as SpellId, lvl) : id in ITEMS ? (ITEMS[id as keyof typeof ITEMS].costs[lvl] ?? 999) : id === 'inventory' ? 3 : 8 + 2 * lvl;
        const pips = Array.from({ length: Math.min(maxLevel, 12) }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
        setHtml(it.querySelector('.pips') as HTMLElement, pips);
        const pr = it.querySelector('.price') as HTMLElement;
        setText(pr, locked ? 'Unavailable' : max ? 'Max level' : `${lvl ? 'Upgrade' : 'Learn'}: ${price}`);
        pr.classList.toggle('max', max && !locked);
        it.classList.toggle('locked', locked);
        it.classList.toggle('unaffordable', !max && !locked && price > me.gold);
      }
      for (const c of this.shopCells) {
        if (!c.toggle) continue;
        const learned = (me.spells[c.toggle] ?? 0) > 0;
        c.el.classList.toggle('hidden', !learned);
        const mode = c.toggle === 'firespray' ? (me.fireSprayFan ? 'Fan' : 'Stream') : (me.splitterContinuous ? 'Continuous' : 'Normal');
        setText(c.el.querySelector('.price') as HTMLElement, mode);
      }
    } else if (this.shopPage !== 'merchant') {
      this.setShopPage('merchant');
    }

    this.updateTooltip(me);

    this.mbTimer -= dt;
    if (this.mbTimer <= 0) {
      this.mbTimer = 0.25;
      this.updateMultiboard();
    }

    this.drawOverlay(dt);
    this.minimapDt += dt;
    if (this.minimapDt >= 1 / 30 - 0.002 || dt === 0) {
      this.minimapDt = 0;
      this.drawMinimap();
    }
  }

  private minimapDt = 1;

  private updateTooltip(me: Warlock) {
    const tt = this.els.tooltip;
    if (!this.hoverProduct) {
      tt.classList.add('hidden');
      return;
    }
    const { id, shop } = this.hoverProduct;
    if (id.startsWith('nav:') || id.startsWith('toggle:')) {
      const target = id.slice(4) as ShopPage;
      const html = id.startsWith('nav:')
        ? `<div class="tt-title">${this.shopPage === 'merchant' ? SHOP_LAYOUT[target].title : 'Back to Merchant'}</div>`
        : `<div class="tt-title">Toggle ${id === 'toggle:firespray' ? 'Fire Spray' : 'Splitter'} mode</div><div>${id === 'toggle:firespray' ? 'Switches between a stream and a fan of fireballs.' : 'Switches between the normal and the continuous splitter.'}</div>`;
      setHtml(tt, html);
      tt.classList.remove('hidden');
      this.placeTooltip(shop);
      return;
    }
    if (!(id in SPELLS)) {
      const item = id in ITEMS ? ITEMS[id as keyof typeof ITEMS] : null;
      const html = `<div class="tt-title">${productName(id as ProductId)}</div><div>${item?.tooltip ?? 'Permanent upgrade from the Merchant.'}</div>`;
      setHtml(tt, html);
      tt.classList.remove('hidden');
      this.placeTooltip(shop);
      return;
    }
    const spellId = id as SpellId;
    const def = SPELLS[spellId];
    const lvl = me.spells[spellId] ?? 0;
    const showLvl = shop ? Math.min(def.maxLevel, lvl + 1) : Math.max(1, lvl);
    let cost = '';
    if (shop) {
      cost = lvl >= def.maxLevel
        ? `<div class="tt-cost">Maximum level reached</div>`
        : `<div class="tt-cost"><img src="${this.gold}">${spellPrice(spellId, lvl)}</div>`;
    }
    const html = `<div class="tt-title">${shop ? (lvl ? 'Upgrade ' : 'Learn ') : ''}${def.name} (<span class="hk">${def.hotkey}</span>) - [Level ${showLvl}]</div>${cost}<div>${def.tooltip}</div><div class="tt-cd">Cooldown: ${spellCooldown(spellId, showLvl).toFixed(1)} seconds</div>`;
    setHtml(tt, html);
    tt.classList.remove('hidden');
    this.placeTooltip(shop);
  }

  private placeTooltip(shop: boolean) {
    const tt = this.els.tooltip;
    if (shop) {
      // Sit beside the shop panel, or over its top-right corner if the window is narrow.
      const r = this.els.shop.getBoundingClientRect();
      const left = Math.min(r.right + 10, window.innerWidth - tt.offsetWidth - 8);
      tt.style.left = `${left}px`;
      tt.style.top = `${r.top}px`;
      tt.style.right = 'auto';
      tt.style.bottom = 'auto';
      tt.style.transform = 'none';
    } else {
      tt.style.transform = '';
      tt.style.left = '';
      tt.style.top = '';
      tt.style.right = '';
      tt.style.bottom = '';
    }
  }

  private updateMultiboard() {
    const rows = this.sim.ranking().map((p) => {
      const cls = p.left ? 'left' : this.sim.phase !== 'shop' && !p.alive ? 'dead' : '';
      return `<tr class="${cls}"><td>${playerName(p)}${p.id === this.localId ? ' *' : ''}</td><td>${p.stats.wins}</td><td>${p.stats.kills}</td><td>${p.stats.deaths}</td></tr>`;
    });
    const html = `<tr><th>Player</th><th>W</th><th>K</th><th>D</th></tr>${rows.join('')}`;
    setHtml(this.els.mbTable, html);
    setText(this.els.mb.querySelector('.mb-title') as HTMLElement, `Warlocks — Round ${this.sim.round}/${this.sim.totalRounds}`);
  }

  private drawOverlay(dt: number) {
    const g = this.og;
    g.clearRect(0, 0, this.overlayW, this.overlayH);
    // WC3 style health bars: fixed pixel size, colour shifts green -> yellow -> red.
    for (const p of this.sim.players) {
      if (!p.alive || (p.windwalk > 0 && p.id !== this.localId)) continue;
      const s = this.renderer.worldToScreen(p.x, p.y, 150);
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
    g.font = this.overlayFont;
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

  private minimapTerrain = document.createElement('canvas');
  private minimapTerrainVersion = -1;

  /** The arena's tiles, coloured from the same procedural textures the ground is drawn with. */
  private paintMinimapTerrain() {
    const c = this.minimapTerrain;
    const n = Math.round((MAP_MAX - MAP_MIN) / TILE_SIZE);
    const P = 4;
    c.width = c.height = n * P;
    const g = c.getContext('2d')!;
    const img = g.createImageData(n * P, n * P);
    const { lava, safe } = this.sim.theme;
    const period = WORLD_TILES * TILE_SIZE;
    const frac = (v: number) => v - Math.floor(v);
    for (let ty = 0; ty < n; ty++) for (let tx = 0; tx < n; tx++) {
      const code = this.sim.terrainAt(MAP_MIN + (tx + 0.5) * TILE_SIZE, MAP_MIN + (ty + 0.5) * TILE_SIZE);
      const tex = code === lava || code === safe || code === ICE_TILE ? proceduralWorldTexture(code) : null;
      for (let py = 0; py < P; py++) for (let px = 0; px < P; px++) {
        const o = (((n - 1 - ty) * P + (P - 1 - py)) * n * P + tx * P + px) * 4;
        img.data[o + 3] = 255;
        if (!tex) continue;
        const u = frac((MAP_MIN + (tx + (px + 0.5) / P) * TILE_SIZE) / period);
        const v = frac((MAP_MIN + (ty + (py + 0.5) / P) * TILE_SIZE) / period);
        const t = (Math.floor((1 - v) * WORLD_PX) * WORLD_PX + Math.floor(u * WORLD_PX)) * 4;
        img.data[o] = tex[t];
        img.data[o + 1] = tex[t + 1];
        img.data[o + 2] = tex[t + 2];
      }
    }
    g.putImageData(img, 0, 0);
  }

  private drawMinimap() {
    const g = this.mg;
    const S = this.minimap.width;
    const toM = (x: number, y: number) => [((x / MINIMAP_EXTENT) + 1) * S / 2, (1 - y / MINIMAP_EXTENT) * S / 2];
    if (this.minimapTerrainVersion !== this.sim.terrainVersion) {
      this.minimapTerrainVersion = this.sim.terrainVersion;
      this.paintMinimapTerrain();
    }
    g.drawImage(this.minimapTerrain, 0, 0, S, S);
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
