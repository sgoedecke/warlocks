import { SPELLS, SPELL_STATS as S, WARLOCK_RADIUS, upgradePrice, type SpellId } from '../config';
import { Rng } from '../sim/rng';
import type { Sim } from '../sim/game';
import type { Command, Warlock } from '../sim/types';

export type Difficulty = 'easy' | 'normal' | 'hard';

const PARAMS: Record<Difficulty, { think: number; aimErr: number; dodge: number; aggression: number; lead: number }> = {
  easy: { think: 0.5, aimErr: 0.32, dodge: 0.25, aggression: 0.45, lead: 0.3 },
  normal: { think: 0.28, aimErr: 0.16, dodge: 0.6, aggression: 0.75, lead: 0.75 },
  hard: { think: 0.14, aimErr: 0.06, dodge: 0.92, aggression: 1, lead: 1 },
};

const BUILDS: SpellId[][] = [
  ['lightning', 'teleport', 'fireball', 'meteor', 'shield', 'fireball', 'homing', 'lightning'],
  ['homing', 'teleport', 'boomerang', 'fireball', 'gravity', 'swap', 'fireball', 'homing'],
  ['thrust', 'shield', 'fireball', 'link', 'lightning', 'fireball', 'meteor', 'thrust'],
  ['swap', 'boomerang', 'teleport', 'fireball', 'windwalk', 'gravity', 'fireball', 'swap'],
  ['meteor', 'lightning', 'teleport', 'fireball', 'homing', 'shield', 'fireball', 'meteor'],
];

export class Bot {
  private rng: Rng;
  private p: (typeof PARAMS)[Difficulty];
  private nextThink = 0;
  private strafe = 1;
  private targetId = -1;
  private shopAt = -1;
  private build: SpellId[];

  constructor(public pid: number, seed: number, difficulty: Difficulty) {
    this.rng = new Rng(seed);
    this.p = PARAMS[difficulty];
    this.build = this.rng.pick(BUILDS);
  }

  think(sim: Sim): Command[] {
    const me = sim.players[this.pid];
    if (sim.phase === 'shop') return this.shop(sim, me);
    this.shopAt = -1;
    if ((sim.phase !== 'fight' && sim.phase !== 'roundEnd') || !me.alive) return [];
    if (sim.time < this.nextThink) return [];
    this.nextThink = sim.time + this.p.think * this.rng.range(0.7, 1.3);
    return this.fight(sim, me);
  }

  private shop(sim: Sim, me: Warlock): Command[] {
    if (me.ready) return [];
    if (this.shopAt < 0) this.shopAt = sim.time + this.rng.range(1.5, 6);
    if (sim.time < this.shopAt) return [];
    const cmds: Command[] = [];
    let gold = me.gold;
    const levels = { ...me.spells };
    for (let guard = 0; guard < 20; guard++) {
      // Repeated entries in a build mean "upgrade"; fireball starts at level 1.
      const want = this.build.find((id, i) => {
        const target = this.build.slice(0, i + 1).filter((x) => x === id).length + (id === 'fireball' ? 1 : 0);
        return (levels[id] ?? 0) < Math.min(SPELLS[id].maxLevel, target);
      });
      const pick = want ?? this.rng.pick(this.build);
      const lvl = levels[pick] ?? 0;
      if (lvl >= SPELLS[pick].maxLevel) break;
      const price = upgradePrice(pick, lvl);
      if (price > gold) break;
      gold -= price;
      levels[pick] = lvl + 1;
      cmds.push({ pid: me.id, type: 'buy', spell: pick });
    }
    // Spend leftovers on upgrades of anything owned.
    for (let guard = 0; guard < 10; guard++) {
      const owned = (Object.keys(levels) as SpellId[]).filter((id) =>
        (levels[id] ?? 0) < SPELLS[id].maxLevel && upgradePrice(id, levels[id] ?? 0) <= gold);
      if (!owned.length) break;
      const id = this.rng.pick(owned);
      gold -= upgradePrice(id, levels[id] ?? 0);
      levels[id] = (levels[id] ?? 0) + 1;
      cmds.push({ pid: me.id, type: 'buy', spell: id });
    }
    cmds.push({ pid: me.id, type: 'ready' });
    return cmds;
  }

  private ready(me: Warlock, id: SpellId): boolean {
    return (me.spells[id] ?? 0) > 0 && (me.cooldowns[id] ?? 0) <= 0;
  }

  private cast(me: Warlock, spell: SpellId, x: number, y: number): Command {
    return { pid: me.id, type: 'cast', spell, x, y };
  }

  private move(me: Warlock, x: number, y: number): Command {
    return { pid: me.id, type: 'move', x, y };
  }

  private fight(sim: Sim, me: Warlock): Command[] {
    const R = sim.arenaRadius;
    const myD = Math.hypot(me.x, me.y);
    const toCx = myD > 1 ? -me.x / myD : 0;
    const toCy = myD > 1 ? -me.y / myD : 0;
    const busy = me.order.type === 'cast' || !!me.cast || !!me.thrust;
    const lvl = (id: SpellId) => me.spells[id] ?? 1;

    // 1. Get out of (or away from) the lava.
    if (myD > R - 45) {
      if (myD > R - 5 && this.ready(me, 'teleport')) {
        const dist = Math.min(S.teleport.range(lvl('teleport')), myD - R * 0.25);
        return [this.cast(me, 'teleport', me.x + toCx * dist, me.y + toCy * dist)];
      }
      if (myD > R + 10 && this.ready(me, 'thrust')) {
        return [this.cast(me, 'thrust', me.x + toCx * 200, me.y + toCy * 200)];
      }
      if (myD > R + 20 && this.ready(me, 'swap')) {
        const t = this.nearestEnemy(sim, me, (o) => Math.hypot(o.x, o.y) < myD - 200);
        if (t) return [this.cast(me, 'swap', t.x, t.y)];
      }
      if (!busy || myD > R) return [this.move(me, toCx * R * 0.4, toCy * R * 0.4)];
    }

    // 2. Dodge incoming missiles.
    const threat = this.findThreat(sim, me);
    if (threat && this.rng.chance(this.p.dodge)) {
      if (threat.time < 0.4 && this.ready(me, 'shield')) return [this.cast(me, 'shield', me.x, me.y)];
      if (threat.time < 0.3 && me.hp < 45 && this.ready(me, 'windwalk')) {
        return [this.cast(me, 'windwalk', me.x, me.y)];
      }
      let px = -threat.vy;
      let py = threat.vx;
      const side = (me.x - threat.x) * px + (me.y - threat.y) * py;
      if (side < 0) {
        px = -px;
        py = -py;
      }
      // Prefer dodging towards the centre if both sides are similar.
      if (px * toCx + py * toCy < -0.6 && myD > R * 0.5) {
        px = -px;
        py = -py;
      }
      return [this.move(me, me.x + px * 170, me.y + py * 170)];
    }
    if (busy) return [];

    // Avoid enemy gravity wells.
    for (const pr of sim.projectiles) {
      if (pr.kind === 'gravity' && pr.owner !== me.id) {
        const d = Math.hypot(me.x - pr.x, me.y - pr.y);
        if (d < S.gravity.pullRadius(pr.level) + 40) {
          const ax = (me.x - pr.x) / (d || 1);
          const ay = (me.y - pr.y) / (d || 1);
          return [this.move(me, me.x + (ax + toCx) * 200, me.y + (ay + toCy) * 200)];
        }
      }
    }

    // 3. Pick a target and attack.
    const target = this.chooseTarget(sim, me);
    if (!target) return [this.move(me, toCx * R * 0.2, toCy * R * 0.2)];
    const dist = Math.hypot(target.x - me.x, target.y - me.y);
    const tD = Math.hypot(target.x, target.y);
    const tvx = target.mvx + target.vx;
    const tvy = target.mvy + target.vy;
    const lead = (speed: number) => {
      const t = (dist / speed) * this.p.lead;
      return { x: target.x + tvx * t, y: target.y + tvy * t };
    };
    const aim = (pt: { x: number; y: number }) => {
      const a = Math.atan2(pt.y - me.y, pt.x - me.x) + this.rng.range(-1, 1) * this.p.aimErr;
      const d = Math.max(200, Math.hypot(pt.x - me.x, pt.y - me.y));
      return { x: me.x + Math.cos(a) * d, y: me.y + Math.sin(a) * d };
    };

    if (this.rng.chance(this.p.aggression)) {
      const outward = tD > 1 ? ((target.x - me.x) * target.x + (target.y - me.y) * target.y) / (dist * tD) : 0;
      if (this.ready(me, 'swap') && myD > R * 0.72 && tD < myD - 180 && dist < S.swap.range * 0.8) {
        const a = aim(lead(S.swap.speed));
        return [this.cast(me, 'swap', a.x, a.y)];
      }
      if (this.ready(me, 'link') && myD > R * 0.7 && tD < myD - 150 && dist < S.link.range * 0.85) {
        const a = aim(lead(S.link.speed));
        return [this.cast(me, 'link', a.x, a.y)];
      }
      if (this.ready(me, 'meteor') && dist < 880 && Math.hypot(tvx, tvy) < 160) {
        const t = S.meteor.delay * 0.6 * this.p.lead;
        return [this.cast(me, 'meteor', target.x + tvx * t, target.y + tvy * t)];
      }
      if (this.ready(me, 'thrust') && dist < 380 && outward > 0.4) {
        return [this.cast(me, 'thrust', target.x, target.y)];
      }
      if (this.ready(me, 'gravity') && tD > R * 0.55 && dist < 700) {
        const a = aim(lead(S.gravity.speed));
        return [this.cast(me, 'gravity', a.x, a.y)];
      }
      if (this.ready(me, 'lightning') && dist < S.lightning.range(lvl('lightning')) - 20) {
        const a = aim(target);
        return [this.cast(me, 'lightning', a.x, a.y)];
      }
      if (this.ready(me, 'homing') && dist < 900) {
        return [this.cast(me, 'homing', target.x, target.y)];
      }
      if (this.ready(me, 'boomerang') && dist < S.boomerang.out) {
        const a = aim(lead(S.boomerang.speed));
        return [this.cast(me, 'boomerang', a.x, a.y)];
      }
      if (this.ready(me, 'fireball') && dist < 1000) {
        const a = aim(lead(S.fireball.speed));
        return [this.cast(me, 'fireball', a.x, a.y)];
      }
      if (this.ready(me, 'windwalk') && me.hp < 35 && this.rng.chance(0.2)) {
        return [this.cast(me, 'windwalk', me.x, me.y)];
      }
    }

    // 4. Reposition: orbit the target at a comfortable distance, staying near the centre.
    if (this.rng.chance(0.08)) this.strafe *= -1;
    const want = 380 + this.rng.range(-60, 120);
    let ax = me.x - target.x;
    let ay = me.y - target.y;
    const ad = Math.hypot(ax, ay) || 1;
    ax /= ad;
    ay /= ad;
    const rot = 0.6 * this.strafe;
    const rx = ax * Math.cos(rot) - ay * Math.sin(rot);
    const ry = ax * Math.sin(rot) + ay * Math.cos(rot);
    let gx = target.x + rx * want;
    let gy = target.y + ry * want;
    const gd = Math.hypot(gx, gy);
    const lim = R * 0.55;
    if (gd > lim) {
      gx *= lim / gd;
      gy *= lim / gd;
    }
    return [this.move(me, gx, gy)];
  }

  private nearestEnemy(sim: Sim, me: Warlock, filter: (o: Warlock) => boolean): Warlock | null {
    let best: Warlock | null = null;
    let bd = Infinity;
    for (const o of sim.players) {
      if (o.id === me.id || !o.alive || !sim.isVisibleTo(o, me.id) || !filter(o)) continue;
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    return best;
  }

  private chooseTarget(sim: Sim, me: Warlock): Warlock | null {
    const cur = sim.players[this.targetId];
    if (cur && cur.alive && cur.id !== me.id && sim.isVisibleTo(cur, me.id) && !this.rng.chance(0.06)) return cur;
    let best: Warlock | null = null;
    let bs = -Infinity;
    for (const o of sim.players) {
      if (o.id === me.id || !o.alive || !sim.isVisibleTo(o, me.id)) continue;
      const d = Math.hypot(o.x - me.x, o.y - me.y);
      const edge = Math.hypot(o.x, o.y) / sim.arenaRadius;
      const score = -d + edge * 300 + (100 - o.hp) * 2 + this.rng.range(0, 150);
      if (score > bs) {
        bs = score;
        best = o;
      }
    }
    this.targetId = best ? best.id : -1;
    return best;
  }

  private findThreat(sim: Sim, me: Warlock) {
    let best: { time: number; x: number; y: number; vx: number; vy: number } | null = null;
    for (const pr of sim.projectiles) {
      if (pr.owner === me.id || pr.kind === 'gravity') continue;
      const rx = me.x - pr.x;
      const ry = me.y - pr.y;
      const v2 = pr.vx * pr.vx + pr.vy * pr.vy;
      if (v2 < 1) continue;
      const t = (rx * pr.vx + ry * pr.vy) / v2;
      if (t < 0 || t > 0.9) continue;
      const cx = pr.x + pr.vx * t - me.x;
      const cy = pr.y + pr.vy * t - me.y;
      if (Math.hypot(cx, cy) > WARLOCK_RADIUS + pr.radius + 22) continue;
      if (!best || t < best.time) best = { time: t, x: pr.x, y: pr.y, vx: pr.vx, vy: pr.vy };
    }
    for (const m of sim.meteors) {
      if (Math.hypot(me.x - m.x, me.y - m.y) < S.meteor.radius(m.level) + WARLOCK_RADIUS + 20) {
        const ax = me.x - m.x || 1;
        const ay = me.y - m.y;
        // Treat as a missile travelling perpendicular to the escape direction.
        if (!best || m.timer < best.time) best = { time: m.timer, x: m.x, y: m.y, vx: -ay, vy: ax };
      }
    }
    return best;
  }
}
