import { ALL_SPELLS, ITEMS, SPELLS, spellPrice, type ProductId, type SpellId } from '../config';
import { Rng } from '../sim/rng';
import { dcos, datan2, dhypot, dsin } from '../sim/dmath';
import type { Sim } from '../sim/game';
import type { Command, Projectile, Warlock } from '../sim/types';

export type Difficulty = 'easy' | 'normal' | 'hard';

const PARAMS: Record<Difficulty, { think: number; aimErr: number; dodge: number; aggression: number; lead: number }> = {
  easy: { think: 0.48, aimErr: 0.35, dodge: 0.25, aggression: 0.45, lead: 0.35 },
  normal: { think: 0.24, aimErr: 0.16, dodge: 0.65, aggression: 0.78, lead: 0.8 },
  hard: { think: 0.12, aimErr: 0.06, dodge: 0.93, aggression: 1, lead: 1 },
};

const BUILDS: ProductId[][] = [
  ['lightning', 'teleport', 'shield', 'fireball', 'meteor', 'drain', 'rangeMastery', 'lightning', 'boots'],
  ['homing', 'thrust', 'firespray', 'fireball', 'rush', 'freeze', 'cape', 'homing'],
  ['boomerang', 'windwalk', 'bouncer', 'fireball', 'timeshift', 'link', 'boots', 'boomerang'],
  ['meteor', 'displacement', 'shield', 'fireball', 'bouncer', 'gravity', 'aoeMastery', 'meteor'],
  ['thrust', 'firespray', 'freeze', 'fireball', 'aegis', 'rangeMastery', 'thrust'],
];

export class Bot {
  private rng: Rng;
  private p: (typeof PARAMS)[Difficulty];
  private nextThink = 0;
  private strafe = 1;
  private targetId = -1;
  private shopAt = -1;
  private build: ProductId[];

  constructor(public pid: number, seed: number, difficulty: Difficulty) {
    this.rng = new Rng(seed);
    this.p = PARAMS[difficulty];
    this.build = this.rng.pick(BUILDS);
  }

  think(sim: Sim): Command[] {
    const me = sim.players[this.pid];
    if (sim.phase === 'shop') return this.shop(sim, me);
    this.shopAt = -1;
    if (sim.phase !== 'fight' || !me.alive) return [];
    if (sim.time < this.nextThink) return [];
    this.nextThink = sim.time + this.p.think * this.rng.range(0.7, 1.3);
    return this.fight(sim, me);
  }

  private shop(sim: Sim, me: Warlock): Command[] {
    if (me.ready) return [];
    if (this.shopAt < 0) this.shopAt = sim.time + this.rng.range(0.6, 4.5);
    if (sim.time < this.shopAt) return [];
    const cmds: Command[] = [];
    const owned = { ...me.spells };
    let gold = me.gold;
    const buy = (product: ProductId, price: number) => { if (gold >= price) { gold -= price; cmds.push({ pid: me.id, type: 'buy', product }); return true; } return false; };
    for (const product of this.build) {
      if (product in SPELLS) {
        const id = product as SpellId;
        if (SPELLS[id].column !== 'core' && me.chosen[SPELLS[id].column] && me.chosen[SPELLS[id].column] !== id) continue;
        const lvl = owned[id] ?? 0;
        if (lvl >= SPELLS[id].maxLevel) continue;
        if (buy(id, spellPrice(id, lvl))) owned[id] = lvl + 1;
      } else if (product in ITEMS) {
        const item = me.itemSlots.find((x) => x.id === product);
        const lvl = item?.level ?? 0;
        const def = ITEMS[product as keyof typeof ITEMS];
        if (lvl < def.max) buy(product, def.costs[lvl]);
      } else {
        buy(product, product === 'inventory' ? 3 : 8);
      }
    }
    // Randomly upgrade useful owned spells with leftovers.
    for (let guard = 0; guard < 8; guard++) {
      const choices = ALL_SPELLS.filter((id) => (owned[id] ?? 0) > 0 && (owned[id] ?? 0) < SPELLS[id].maxLevel && spellPrice(id, owned[id] ?? 0) <= gold);
      if (!choices.length) break;
      const id = this.rng.pick(choices);
      buy(id, spellPrice(id, owned[id] ?? 0));
      owned[id] = (owned[id] ?? 0) + 1;
    }
    cmds.push({ pid: me.id, type: 'ready' });
    return cmds;
  }

  private ready(me: Warlock, id: SpellId): boolean { return (me.spells[id] ?? 0) > 0 && (me.cooldowns[id] ?? 0) <= 0; }
  private cast(me: Warlock, spell: SpellId, x: number, y: number): Command { return { pid: me.id, type: 'cast', spell, x, y }; }
  private move(me: Warlock, x: number, y: number): Command { return { pid: me.id, type: 'move', x, y }; }

  private fight(sim: Sim, me: Warlock): Command[] {
    const myD = dhypot(me.x, me.y);
    const safeR = sim.arenaRadius * 0.72;
    const toCx = myD > 1 ? -me.x / myD : 0;
    const toCy = myD > 1 ? -me.y / myD : 0;
    const busy = me.order.type === 'cast' || !!me.cast || !!me.thrust || !!me.frozen;
    const lvl = (id: SpellId) => me.spells[id] ?? 1;
    if (me.inLava || myD > safeR) {
      if (this.ready(me, 'teleport')) return [this.cast(me, 'teleport', me.x + toCx * 700, me.y + toCy * 700)];
      if (this.ready(me, 'thrust')) return [this.cast(me, 'thrust', me.x + toCx * 400, me.y + toCy * 400)];
      return [this.move(me, toCx * safeR * 0.35, toCy * safeR * 0.35)];
    }
    const threat = this.findThreat(sim, me);
    if (threat && this.rng.chance(this.p.dodge)) {
      if (threat.time < 0.45 && this.ready(me, 'shield')) return [this.cast(me, 'shield', me.x, me.y)];
      if (threat.time < 0.35 && this.ready(me, 'timeshift')) return [this.cast(me, 'timeshift', me.x, me.y)];
      let px = -threat.vy, py = threat.vx;
      if ((me.x - threat.x) * px + (me.y - threat.y) * py < 0) { px = -px; py = -py; }
      const d = dhypot(px, py) || 1;
      return [this.move(me, me.x + px / d * 220 + toCx * 120, me.y + py / d * 220 + toCy * 120)];
    }
    if (busy) return [];
    const target = this.chooseTarget(sim, me);
    if (!target) return [this.move(me, 0, 0)];
    const dist = dhypot(target.x - me.x, target.y - me.y);
    const tvx = (target.mvx + target.vx) / 0.03;
    const tvy = (target.mvy + target.vy) / 0.03;
    const aimAt = (speed: number) => {
      const t = (dist / speed) * this.p.lead;
      const ax = target.x + tvx * t;
      const ay = target.y + tvy * t;
      const a = datan2(ay - me.y, ax - me.x) + this.rng.range(-this.p.aimErr, this.p.aimErr);
      return { x: me.x + dcos(a) * Math.max(200, dist), y: me.y + dsin(a) * Math.max(200, dist) };
    };
    if (this.rng.chance(this.p.aggression)) {
      if (this.ready(me, 'scourge') && dist < 230) return [this.cast(me, 'scourge', me.x, me.y)];
      if (this.ready(me, 'freeze') && dist < 850) { const a = aimAt(900); return [this.cast(me, 'freeze', a.x, a.y)]; }
      if (this.ready(me, 'lightning') && dist < 600 * (1 + 0.15 * me.IA)) return [this.cast(me, 'lightning', target.x, target.y)];
      if (this.ready(me, 'meteor') && dist < 900) return [this.cast(me, 'meteor', target.x + tvx * 0.7, target.y + tvy * 0.7)];
      if (this.ready(me, 'displacement') && dist < 850) { const a = aimAt(1700); return [this.cast(me, 'displacement', a.x, a.y)]; }
      if (this.ready(me, 'firespray') && dist < 900) { const a = aimAt(1200); return [this.cast(me, 'firespray', a.x, a.y)]; }
      if (this.ready(me, 'bouncer') && dist < 900) { const a = aimAt(900); return [this.cast(me, 'bouncer', a.x, a.y)]; }
      if (this.ready(me, 'homing') && dist < 1100) return [this.cast(me, 'homing', target.x, target.y)];
      if (this.ready(me, 'boomerang') && dist < 900) { const a = aimAt(1500); return [this.cast(me, 'boomerang', a.x, a.y)]; }
      if (this.ready(me, 'gravity') && dist < 1000) { const a = aimAt(400); return [this.cast(me, 'gravity', a.x, a.y)]; }
      if (this.ready(me, 'link') && dist < 900) { const a = aimAt(600 + 100 * lvl('link')); return [this.cast(me, 'link', a.x, a.y)]; }
      if (this.ready(me, 'thrust') && dist < 420) return [this.cast(me, 'thrust', target.x, target.y)];
      if (this.ready(me, 'drain') && me.hp < 60 && dist < 700) { const a = aimAt(600); return [this.cast(me, 'drain', a.x, a.y)]; }
      if (this.ready(me, 'fireball') && dist < 1050) { const a = aimAt(1000); return [this.cast(me, 'fireball', a.x, a.y)]; }
      if (this.ready(me, 'windwalk') && me.hp < 35) return [this.cast(me, 'windwalk', me.x, me.y)];
      if (this.ready(me, 'rush') && me.hp < 45) return [this.cast(me, 'rush', me.x, me.y)];
    }
    if (this.rng.chance(0.08)) this.strafe *= -1;
    const want = 420 + this.rng.range(-90, 120);
    let ax = me.x - target.x, ay = me.y - target.y;
    const ad = dhypot(ax, ay) || 1; ax /= ad; ay /= ad;
    const rot = 0.75 * this.strafe;
    let gx = target.x + (ax * dcos(rot) - ay * dsin(rot)) * want;
    let gy = target.y + (ax * dsin(rot) + ay * dcos(rot)) * want;
    const gd = dhypot(gx, gy);
    if (gd > safeR) { gx *= safeR / gd; gy *= safeR / gd; }
    return [this.move(me, gx, gy)];
  }

  private chooseTarget(sim: Sim, me: Warlock): Warlock | null {
    const cur = sim.players[this.targetId];
    if (cur && cur.alive && sim.isEnemy(me, cur) && sim.isVisibleTo(cur, me.id) && !this.rng.chance(0.06)) return cur;
    let best: Warlock | null = null, bs = -Infinity;
    for (const o of sim.players) {
      if (!o.alive || !sim.isEnemy(me, o) || !sim.isVisibleTo(o, me.id)) continue;
      const edge = dhypot(o.x, o.y) / Math.max(1, sim.arenaRadius);
      const score = -dhypot(o.x - me.x, o.y - me.y) + edge * 500 + (100 - o.hp) * 2 + this.rng.range(0, 150);
      if (score > bs) { bs = score; best = o; }
    }
    this.targetId = best?.id ?? -1;
    return best;
  }

  private findThreat(sim: Sim, me: Warlock) {
    let best: { time: number; x: number; y: number; vx: number; vy: number } | null = null;
    for (const pr of sim.projectiles as Projectile[]) {
      if (pr.owner === me.id || !sim.isEnemy(pr.owner, me) || pr.kind === 'gravity') continue;
      const vx = pr.vx / 0.03, vy = pr.vy / 0.03;
      const rx = me.x - pr.x, ry = me.y - pr.y, v2 = vx * vx + vy * vy;
      if (v2 < 1) continue;
      const t = (rx * vx + ry * vy) / v2;
      if (t < 0 || t > 0.9) continue;
      const cx = pr.x + vx * t - me.x, cy = pr.y + vy * t - me.y;
      if (dhypot(cx, cy) > pr.radius + 60) continue;
      if (!best || t < best.time) best = { time: t, x: pr.x, y: pr.y, vx, vy };
    }
    for (const m of sim.meteors) if (dhypot(me.x - m.x, me.y - m.y) < 260) {
      const ax = me.x - m.x || 1, ay = me.y - m.y;
      if (!best || m.timer < best.time) best = { time: m.timer, x: m.x, y: m.y, vx: -ay, vy: ax };
    }
    return best;
  }
}
