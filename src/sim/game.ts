import {
  ARENA_MIN_RADIUS, ARENA_SHRINK_DELAY, ARENA_SHRINK_RATE, ARENA_START_RADIUS, CAST_FACING_TOLERANCE,
  COUNTDOWN_TIME, DT, GOLD_PER_KILL, GOLD_PER_ROUND, GOLD_PER_WIN, KB_HP_SCALING, KILL_CREDIT_WINDOW,
  KNOCKBACK_FRICTION, LAVA_DPS, ROUND_END_TIME, SHOP_TIME, SPELLS, SPELL_STATS as S, START_GOLD,
  WARLOCK_HP, WARLOCK_RADIUS, WARLOCK_SPEED, WARLOCK_TURN_RATE, upgradePrice, type SpellId,
} from '../config';
import { Rng } from './rng';
import type {
  Command, GameEvent, Meteor, Phase, PlayerSetup, Projectile, ProjectileKind, Warlock,
} from './types';

export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const SOLID: Record<ProjectileKind, boolean> = {
  fireball: true, homing: true, boomerang: true, swap: true, link: true, gravity: false,
};

export interface SimOptions {
  players: PlayerSetup[];
  seed: number;
  rounds: number;
}

export class Sim {
  tick = 0;
  time = 0;
  rng: Rng;
  players: Warlock[];
  projectiles: Projectile[] = [];
  meteors: Meteor[] = [];
  events: GameEvent[] = [];
  phase: Phase = 'shop';
  phaseTimer = SHOP_TIME;
  round = 1;
  totalRounds: number;
  arenaRadius = ARENA_START_RADIUS;
  roundTime = 0;
  roundWinner = -1;
  private nextId = 1;

  constructor(opts: SimOptions) {
    this.rng = new Rng(opts.seed);
    this.totalRounds = opts.rounds;
    this.players = opts.players.map((p, i) => ({
      id: i, name: p.name, color: p.color, isBot: p.isBot,
      x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, mvx: 0, mvy: 0, facing: 0, pfacing: 0,
      hp: WARLOCK_HP, alive: true, deathTime: 0, diedInLava: false,
      order: { type: 'idle' }, cast: null,
      spells: { fireball: 1 }, cooldowns: {}, gold: START_GOLD,
      shield: 0, windwalk: 0, windwalkSpeed: 1, thrust: null, link: null,
      lastHitBy: -1, lastHitTime: -99, inLava: false, lastCastTime: -99, lastCastSpell: null,
      ready: false,
      stats: { kills: 0, deaths: 0, wins: 0, damage: 0 },
    }));
    this.placePlayers();
  }

  get(pid: number): Warlock | undefined {
    return this.players[pid];
  }

  isVisibleTo(target: Warlock, viewer: number): boolean {
    return target.id === viewer || target.windwalk <= 0;
  }

  private placePlayers() {
    const n = this.players.length;
    const r = this.arenaRadius * 0.62;
    const offset = this.rng.next() * Math.PI * 2;
    this.players.forEach((p, i) => {
      const a = offset + (i / n) * Math.PI * 2;
      p.x = p.px = Math.cos(a) * r;
      p.y = p.py = Math.sin(a) * r;
      p.facing = p.pfacing = a + Math.PI;
    });
  }

  private setPhase(phase: Phase, timer: number) {
    this.phase = phase;
    this.phaseTimer = timer;
    this.events.push({ t: 'phase', phase });
  }

  private startRound() {
    this.roundTime = 0;
    this.roundWinner = -1;
    this.setPhase('countdown', COUNTDOWN_TIME);
  }

  // Revives everyone and restores the arena; done as the shop opens so players see the fresh arena.
  private resetArena() {
    this.projectiles = [];
    this.meteors = [];
    this.arenaRadius = ARENA_START_RADIUS;
    for (const p of this.players) {
      p.hp = WARLOCK_HP;
      p.alive = true;
      p.vx = p.vy = p.mvx = p.mvy = 0;
      p.order = { type: 'idle' };
      p.cast = null;
      p.cooldowns = {};
      p.shield = p.windwalk = 0;
      p.thrust = null;
      p.link = null;
      p.lastHitBy = -1;
      p.lastHitTime = -99;
      p.inLava = false;
      p.diedInLava = false;
    }
    this.placePlayers();
  }

  step(cmds: Command[]) {
    this.events = [];
    for (const p of this.players) {
      p.px = p.x;
      p.py = p.y;
      p.pfacing = p.facing;
    }
    for (const pr of this.projectiles) {
      pr.px = pr.x;
      pr.py = pr.y;
    }
    for (const c of cmds) this.applyCommand(c);

    this.phaseTimer -= DT;
    switch (this.phase) {
      case 'shop':
        if (this.phaseTimer <= 0 || this.players.every((p) => p.ready)) this.startRound();
        break;
      case 'countdown':
        if (this.phaseTimer <= 0) this.setPhase('fight', 0);
        break;
      case 'fight':
        this.updateFight();
        break;
      case 'roundEnd':
        this.updateFight();
        if (this.phaseTimer <= 0) this.endRound();
        break;
      case 'gameOver':
        break;
    }
    this.time += DT;
    this.tick++;
  }

  private endRound() {
    if (this.round >= this.totalRounds) {
      this.setPhase('gameOver', 0);
      return;
    }
    this.round++;
    for (const p of this.players) {
      p.gold += GOLD_PER_ROUND;
      p.ready = false;
    }
    this.resetArena();
    this.setPhase('shop', SHOP_TIME);
  }

  private applyCommand(c: Command) {
    const p = this.players[c.pid];
    if (!p) return;
    if (c.type === 'buy') {
      if (this.phase !== 'shop') return;
      const lvl = p.spells[c.spell] ?? 0;
      const def = SPELLS[c.spell];
      if (lvl >= def.maxLevel) return;
      const price = upgradePrice(c.spell, lvl);
      if (p.gold < price) {
        this.events.push({ t: 'error', pid: p.id, msg: 'Not enough gold.' });
        return;
      }
      p.gold -= price;
      p.spells[c.spell] = lvl + 1;
      this.events.push({ t: 'buy', pid: p.id, spell: c.spell, level: lvl + 1 });
      return;
    }
    if (c.type === 'ready') {
      if (this.phase === 'shop') p.ready = true;
      return;
    }
    // Orders given during the countdown are queued and carried out once the fight starts.
    const countdown = this.phase === 'countdown';
    if ((this.phase !== 'fight' && this.phase !== 'roundEnd' && !countdown) || !p.alive) return;
    if (p.thrust) return; // committed to the charge
    if (c.type === 'move') {
      p.order = { type: 'move', x: c.x, y: c.y };
      p.cast = null;
    } else if (c.type === 'stop') {
      p.order = { type: 'idle' };
      p.cast = null;
    } else if (c.type === 'cast') {
      const lvl = p.spells[c.spell] ?? 0;
      if (lvl <= 0) return;
      if ((p.cooldowns[c.spell] ?? 0) > 0) {
        this.events.push({ t: 'error', pid: p.id, msg: 'Spell is not ready yet.' });
        return;
      }
      const def = SPELLS[c.spell];
      if (def.targeting === 'none') {
        if (countdown) return;
        this.executeSpell(p, c.spell, p.x, p.y);
      } else {
        p.order = { type: 'cast', spell: c.spell, x: c.x, y: c.y };
        p.cast = null;
      }
    }
  }

  private updateFight() {
    this.roundTime += DT;
    if (this.roundTime > ARENA_SHRINK_DELAY) {
      this.arenaRadius = Math.max(ARENA_MIN_RADIUS, this.arenaRadius - ARENA_SHRINK_RATE * DT);
    }
    for (const p of this.players) if (p.alive) this.updateWarlock(p);
    this.collideWarlocks();
    this.updateProjectiles();
    this.updateMeteors();
    for (const p of this.players) {
      if (p.alive && p.hp <= 0) this.kill(p);
    }
    if (this.phase === 'fight') {
      const alive = this.players.filter((p) => p.alive);
      if (alive.length <= 1) {
        if (alive.length === 1) {
          const w = alive[0];
          w.stats.wins++;
          w.gold += GOLD_PER_WIN;
          this.roundWinner = w.id;
          this.events.push({ t: 'bounty', pid: w.id, gold: GOLD_PER_WIN, x: w.x, y: w.y });
        }
        this.events.push({ t: 'roundWinner', pid: alive.length === 1 ? alive[0].id : -1 });
        this.setPhase('roundEnd', ROUND_END_TIME);
      }
    }
  }

  private turnToward(p: Warlock, tx: number, ty: number): number {
    const want = Math.atan2(ty - p.y, tx - p.x);
    const d = angleDiff(p.facing, want);
    const maxTurn = WARLOCK_TURN_RATE * DT;
    p.facing += Math.max(-maxTurn, Math.min(maxTurn, d));
    return Math.abs(angleDiff(p.facing, want));
  }

  private walkToward(p: Warlock, tx: number, ty: number) {
    const dx = tx - p.x;
    const dy = ty - p.y;
    const dist = Math.hypot(dx, dy);
    const off = this.turnToward(p, tx, ty);
    const speed = WARLOCK_SPEED * (p.windwalk > 0 ? p.windwalkSpeed : 1) * Math.max(0, Math.cos(off));
    const step = Math.min(speed * DT, dist);
    p.mvx = Math.cos(p.facing) * (step / DT);
    p.mvy = Math.sin(p.facing) * (step / DT);
  }

  private updateWarlock(p: Warlock) {
    for (const k in p.cooldowns) {
      const id = k as SpellId;
      p.cooldowns[id] = Math.max(0, (p.cooldowns[id] ?? 0) - DT);
    }
    if (p.shield > 0) p.shield -= DT;
    if (p.windwalk > 0) p.windwalk -= DT;
    p.mvx = p.mvy = 0;

    if (p.thrust) {
      const t = p.thrust;
      const sp = S.thrust.speed;
      p.mvx = t.dx * sp;
      p.mvy = t.dy * sp;
      t.remaining -= sp * DT;
      for (const o of this.players) {
        if (o === p || !o.alive) continue;
        if (Math.hypot(o.x - p.x, o.y - p.y) < WARLOCK_RADIUS * 2 + 6) {
          this.applyHit(o, p.id, S.thrust.damage(t.level), t.dx, t.dy, S.thrust.kb(t.level));
          this.events.push({ t: 'thrustHit', x: (o.x + p.x) / 2, y: (o.y + p.y) / 2 });
          t.remaining = 0;
          p.mvx = p.mvy = 0;
          break;
        }
      }
      if (t.remaining <= 0) p.thrust = null;
    } else {
      const o = p.order;
      if (o.type === 'move') {
        if (Math.hypot(o.x - p.x, o.y - p.y) < 4) p.order = { type: 'idle' };
        else this.walkToward(p, o.x, o.y);
      } else if (o.type === 'cast') {
        const def = SPELLS[o.spell];
        const lvl = p.spells[o.spell] ?? 1;
        const range = def.range?.(lvl);
        const dist = Math.hypot(o.x - p.x, o.y - p.y);
        if (!p.cast && range !== undefined && dist > range) {
          this.walkToward(p, o.x, o.y);
        } else if (!p.cast) {
          const off = dist < 1 ? 0 : this.turnToward(p, o.x, o.y);
          if (off < CAST_FACING_TOLERANCE) p.cast = { spell: o.spell, x: o.x, y: o.y, timer: def.castTime };
        }
        if (p.cast) {
          p.cast.timer -= DT;
          if (p.cast.timer <= 0) {
            const c = p.cast;
            p.cast = null;
            p.order = { type: 'idle' };
            this.executeSpell(p, c.spell, c.x, c.y);
          }
        }
      }
    }

    if (p.link) {
      const l = p.link;
      const t = this.players[l.target];
      l.time -= DT;
      if (!t || !t.alive || l.time <= 0) {
        p.link = null;
      } else {
        const dx = t.x - p.x;
        const dy = t.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d > WARLOCK_RADIUS * 2.2) {
          const a = S.link.pull * DT;
          p.vx += (dx / d) * a;
          p.vy += (dy / d) * a;
          t.vx -= (dx / d) * a * 0.35;
          t.vy -= (dy / d) * a * 0.35;
        }
        const drain = S.link.damage(l.level) / S.link.duration(l.level);
        this.damage(t, p.id, drain * DT);
        p.hp = Math.min(WARLOCK_HP, p.hp + drain * DT * 0.5);
      }
    }

    p.x += (p.mvx + p.vx) * DT;
    p.y += (p.mvy + p.vy) * DT;
    const f = Math.exp(-KNOCKBACK_FRICTION * DT);
    p.vx *= f;
    p.vy *= f;
    if (Math.hypot(p.vx, p.vy) < 4) p.vx = p.vy = 0;

    p.inLava = Math.hypot(p.x, p.y) > this.arenaRadius;
    if (p.inLava) {
      p.hp -= LAVA_DPS * DT;
      if (p.hp <= 0) p.diedInLava = true;
    }
  }

  private collideWarlocks() {
    const ps = this.players;
    const min = WARLOCK_RADIUS * 2;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (!b.alive) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.001) {
          dx = 1;
          dy = 0;
          d = 1;
        }
        const nx = dx / d;
        const ny = dy / d;
        const push = (min - d) / 2;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        // Bodies bump: exchange the normal component of knockback momentum.
        const va = a.vx * nx + a.vy * ny;
        const vb = b.vx * nx + b.vy * ny;
        if (va - vb > 0) {
          const e = 0.85;
          a.vx += (vb - va) * nx * e;
          a.vy += (vb - va) * ny * e;
          b.vx += (va - vb) * nx * e;
          b.vy += (va - vb) * ny * e;
        }
      }
    }
  }

  private spawnProjectile(p: Warlock, kind: ProjectileKind, dirx: number, diry: number, speed: number,
    radius: number, maxDist: number, life: number, lvl: number): Projectile {
    const off = WARLOCK_RADIUS + radius + 2;
    const pr: Projectile = {
      id: this.nextId++, kind, owner: p.id,
      x: p.x + dirx * off, y: p.y + diry * off, px: p.x, py: p.y,
      vx: dirx * speed, vy: diry * speed, radius, life, age: 0, level: lvl,
      traveled: 0, maxDist, returning: false, hitIds: [], dead: false,
    };
    pr.px = pr.x;
    pr.py = pr.y;
    this.projectiles.push(pr);
    return pr;
  }

  private executeSpell(p: Warlock, spell: SpellId, tx: number, ty: number) {
    const lvl = p.spells[spell] ?? 1;
    const def = SPELLS[spell];
    p.cooldowns[spell] = def.cooldown(lvl);
    p.lastCastTime = this.time;
    p.lastCastSpell = spell;
    if (spell !== 'windwalk') p.windwalk = 0;
    let dx = tx - p.x;
    let dy = ty - p.y;
    let d = Math.hypot(dx, dy);
    if (d < 1) {
      dx = Math.cos(p.facing);
      dy = Math.sin(p.facing);
      d = 1;
    }
    const nx = dx / d;
    const ny = dy / d;
    this.events.push({ t: 'cast', pid: p.id, spell, x: tx, y: ty });

    switch (spell) {
      case 'fireball':
        this.spawnProjectile(p, 'fireball', nx, ny, S.fireball.speed, S.fireball.radius, S.fireball.range, 99, lvl);
        break;
      case 'homing':
        this.spawnProjectile(p, 'homing', nx, ny, S.homing.speed, S.homing.radius, 1e9, S.homing.life, lvl);
        break;
      case 'boomerang':
        this.spawnProjectile(p, 'boomerang', nx, ny, S.boomerang.speed, S.boomerang.radius, S.boomerang.out, 6, lvl);
        break;
      case 'gravity':
        this.spawnProjectile(p, 'gravity', nx, ny, S.gravity.speed, S.gravity.radius, 1e9, S.gravity.life, lvl);
        break;
      case 'link':
        this.spawnProjectile(p, 'link', nx, ny, S.link.speed, S.link.radius, S.link.range, 99, lvl);
        break;
      case 'swap':
        this.spawnProjectile(p, 'swap', nx, ny, S.swap.speed, S.swap.radius, S.swap.range, 99, lvl);
        break;
      case 'lightning':
        this.castLightning(p, nx, ny, lvl);
        break;
      case 'meteor': {
        const m: Meteor = { id: this.nextId++, owner: p.id, x: tx, y: ty, timer: S.meteor.delay, delay: S.meteor.delay, level: lvl };
        this.meteors.push(m);
        this.events.push({ t: 'meteorFall', id: m.id, x: tx, y: ty, delay: m.delay });
        break;
      }
      case 'teleport': {
        const r = S.teleport.range(lvl);
        const dist = Math.min(d, r);
        const fx = p.x;
        const fy = p.y;
        p.x = p.px = fx + nx * dist;
        p.y = p.py = fy + ny * dist;
        p.vx *= 0.3;
        p.vy *= 0.3;
        this.events.push({ t: 'teleport', pid: p.id, fx, fy, tx: p.x, ty: p.y });
        break;
      }
      case 'thrust':
        p.facing = Math.atan2(ny, nx);
        p.vx = p.vy = 0;
        p.thrust = { dx: nx, dy: ny, remaining: S.thrust.distance(lvl), level: lvl };
        break;
      case 'shield':
        p.shield = S.shield.duration(lvl);
        break;
      case 'windwalk':
        p.windwalk = S.windwalk.duration(lvl);
        p.windwalkSpeed = S.windwalk.speed(lvl);
        break;
    }
  }

  private castLightning(p: Warlock, nx: number, ny: number, lvl: number) {
    const range = S.lightning.range(lvl);
    const sx = p.x + nx * (WARLOCK_RADIUS + 4);
    const sy = p.y + ny * (WARLOCK_RADIUS + 4);
    let best = range;
    let hitW: Warlock | null = null;
    let hitP: Projectile | null = null;
    const ray = (cx: number, cy: number, r: number): number => {
      const ox = cx - sx;
      const oy = cy - sy;
      const along = ox * nx + oy * ny;
      if (along < -r) return Infinity;
      const perp2 = ox * ox + oy * oy - along * along;
      if (perp2 > r * r) return Infinity;
      return Math.max(0, along - Math.sqrt(r * r - perp2));
    };
    for (const o of this.players) {
      if (o === p || !o.alive) continue;
      const t = ray(o.x, o.y, WARLOCK_RADIUS);
      if (t < best) {
        best = t;
        hitW = o;
        hitP = null;
      }
    }
    for (const pr of this.projectiles) {
      if (pr.owner === p.id || pr.dead) continue;
      const t = ray(pr.x, pr.y, pr.radius + 6);
      if (t < best) {
        best = t;
        hitP = pr;
        hitW = null;
      }
    }
    const ex = sx + nx * best;
    const ey = sy + ny * best;
    this.events.push({ t: 'lightning', pid: p.id, x1: sx, y1: sy, x2: ex, y2: ey, hit: !!(hitW || hitP) });
    if (hitW) {
      if (hitW.shield > 0) {
        this.events.push({ t: 'reflect', pid: hitW.id, x: ex, y: ey });
      } else {
        this.applyHit(hitW, p.id, S.lightning.damage(lvl), nx, ny, S.lightning.kb(lvl));
      }
    }
    if (hitP) {
      hitP.dead = true;
      this.events.push({ t: 'explode', kind: hitP.kind, x: hitP.x, y: hitP.y });
    }
  }

  private updateProjectiles() {
    for (const pr of this.projectiles) {
      if (pr.dead) continue;
      pr.age += DT;
      const owner = this.players[pr.owner];

      if (pr.kind === 'homing') {
        let target: Warlock | null = null;
        let bd = S.homing.seek;
        for (const o of this.players) {
          if (o.id === pr.owner || !o.alive || o.windwalk > 0) continue;
          const d = Math.hypot(o.x - pr.x, o.y - pr.y);
          if (d < bd) {
            bd = d;
            target = o;
          }
        }
        if (target) {
          const cur = Math.atan2(pr.vy, pr.vx);
          const want = Math.atan2(target.y - pr.y, target.x - pr.x);
          const d = angleDiff(cur, want);
          const mt = S.homing.turn * DT;
          const na = cur + Math.max(-mt, Math.min(mt, d));
          pr.vx = Math.cos(na) * S.homing.speed;
          pr.vy = Math.sin(na) * S.homing.speed;
        }
      } else if (pr.kind === 'boomerang' && pr.returning) {
        if (!owner || !owner.alive) {
          pr.life = Math.min(pr.life, 0.8);
        } else {
          const dx = owner.x - pr.x;
          const dy = owner.y - pr.y;
          const d = Math.hypot(dx, dy);
          if (d < WARLOCK_RADIUS + pr.radius) {
            pr.dead = true;
            continue;
          }
          pr.vx = (dx / d) * S.boomerang.speed;
          pr.vy = (dy / d) * S.boomerang.speed;
        }
      }

      pr.x += pr.vx * DT;
      pr.y += pr.vy * DT;
      pr.traveled += Math.hypot(pr.vx, pr.vy) * DT;
      pr.life -= DT;
      if (pr.traveled >= pr.maxDist) {
        if (pr.kind === 'boomerang' && !pr.returning) {
          pr.returning = true;
          pr.hitIds = [];
        } else {
          pr.dead = true;
          if (pr.kind === 'fireball') this.events.push({ t: 'explode', kind: 'fireball', x: pr.x, y: pr.y });
          continue;
        }
      }
      if (pr.life <= 0) {
        pr.dead = true;
        this.events.push({ t: 'explode', kind: pr.kind, x: pr.x, y: pr.y });
        continue;
      }

      if (pr.kind === 'gravity') {
        const pullR = S.gravity.pullRadius(pr.level);
        for (const o of this.players) {
          if (o.id === pr.owner || !o.alive) continue;
          const dx = pr.x - o.x;
          const dy = pr.y - o.y;
          const d = Math.hypot(dx, dy);
          if (d > pullR || d < 1) continue;
          const strength = S.gravity.pull(pr.level) * (1.6 - d / pullR) * 2.2;
          o.vx += (dx / d) * strength * DT;
          o.vy += (dy / d) * strength * DT;
          if (d < pullR * 0.45) this.damage(o, pr.owner, S.gravity.dps(pr.level) * DT);
        }
        continue;
      }

      for (const o of this.players) {
        if (!o.alive || pr.dead) continue;
        if (o.id === pr.owner) continue;
        if (pr.hitIds.includes(o.id)) continue;
        const dx = o.x - pr.x;
        const dy = o.y - pr.y;
        const d = Math.hypot(dx, dy);
        if (d > WARLOCK_RADIUS + pr.radius) continue;
        if (o.shield > 0) {
          this.reflect(pr, o, dx / (d || 1), dy / (d || 1));
          continue;
        }
        this.projectileHit(pr, o);
      }
    }

    // Opposing missiles annihilate each other.
    const ps = this.projectiles;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.dead || !SOLID[a.kind]) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (b.dead || !SOLID[b.kind] || a.owner === b.owner) continue;
        if (Math.hypot(a.x - b.x, a.y - b.y) < a.radius + b.radius) {
          a.dead = b.dead = true;
          this.events.push({ t: 'explode', kind: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
          break;
        }
      }
    }
    this.projectiles = ps.filter((p) => !p.dead);
  }

  private reflect(pr: Projectile, o: Warlock, nx: number, ny: number) {
    // n points from missile to shield owner; bounce the missile back out.
    const vn = pr.vx * nx + pr.vy * ny;
    if (vn > 0) {
      pr.vx -= 2 * vn * nx;
      pr.vy -= 2 * vn * ny;
    }
    pr.owner = o.id;
    pr.traveled = 0;
    pr.returning = false;
    pr.hitIds = [];
    pr.x = o.x - nx * (WARLOCK_RADIUS + pr.radius + 2);
    pr.y = o.y - ny * (WARLOCK_RADIUS + pr.radius + 2);
    this.events.push({ t: 'reflect', pid: o.id, x: pr.x, y: pr.y });
  }

  private projectileHit(pr: Projectile, o: Warlock) {
    const sp = Math.hypot(pr.vx, pr.vy) || 1;
    const nx = pr.vx / sp;
    const ny = pr.vy / sp;
    const l = pr.level;
    switch (pr.kind) {
      case 'fireball':
        this.applyHit(o, pr.owner, S.fireball.damage(l), nx, ny, S.fireball.kb(l));
        pr.dead = true;
        this.events.push({ t: 'explode', kind: 'fireball', x: pr.x, y: pr.y });
        break;
      case 'homing':
        this.applyHit(o, pr.owner, S.homing.damage(l), nx, ny, S.homing.kb(l));
        pr.dead = true;
        this.events.push({ t: 'explode', kind: 'homing', x: pr.x, y: pr.y });
        break;
      case 'boomerang':
        this.applyHit(o, pr.owner, S.boomerang.damage(l), nx, ny, S.boomerang.kb(l));
        pr.hitIds.push(o.id);
        this.events.push({ t: 'explode', kind: 'boomerang', x: pr.x, y: pr.y });
        break;
      case 'link': {
        pr.dead = true;
        const owner = this.players[pr.owner];
        if (owner && owner.alive) {
          owner.link = { target: o.id, time: S.link.duration(l), level: l };
          this.events.push({ t: 'linkHit', pid: owner.id, target: o.id });
        }
        break;
      }
      case 'swap': {
        pr.dead = true;
        const owner = this.players[pr.owner];
        if (owner && owner.alive) {
          const ax = owner.x;
          const ay = owner.y;
          owner.x = owner.px = o.x;
          owner.y = owner.py = o.y;
          o.x = o.px = ax;
          o.y = o.py = ay;
          o.order = { type: 'idle' };
          o.cast = null;
          this.events.push({ t: 'swap', a: owner.id, b: o.id, ax: owner.x, ay: owner.y, bx: o.x, by: o.y });
        }
        break;
      }
      default:
        break;
    }
  }

  private updateMeteors() {
    for (const m of this.meteors) {
      m.timer -= DT;
      if (m.timer > 0) continue;
      const r = S.meteor.radius(m.level);
      this.events.push({ t: 'meteorImpact', x: m.x, y: m.y, radius: r });
      for (const o of this.players) {
        if (!o.alive) continue;
        const dx = o.x - m.x;
        const dy = o.y - m.y;
        const d = Math.hypot(dx, dy);
        if (d > r + WARLOCK_RADIUS) continue;
        const fall = 1 - 0.5 * Math.min(1, d / r);
        const nx = d < 1 ? 1 : dx / d;
        const ny = d < 1 ? 0 : dy / d;
        this.applyHit(o, m.owner, S.meteor.damage(m.level) * fall, nx, ny, S.meteor.kb(m.level) * fall);
      }
      for (const pr of this.projectiles) {
        if (Math.hypot(pr.x - m.x, pr.y - m.y) < r) pr.dead = true;
      }
    }
    this.meteors = this.meteors.filter((m) => m.timer > 0);
  }

  private damage(o: Warlock, src: number, dmg: number) {
    if (!o.alive) return;
    o.hp -= dmg;
    if (src !== o.id && src >= 0) {
      o.lastHitBy = src;
      o.lastHitTime = this.time;
      const s = this.players[src];
      if (s) s.stats.damage += dmg;
    }
  }

  private applyHit(o: Warlock, src: number, dmg: number, nx: number, ny: number, kb: number) {
    if (!o.alive) return;
    const missing = 1 - Math.max(0, o.hp) / WARLOCK_HP;
    const k = kb * (1 + KB_HP_SCALING * missing);
    o.vx += nx * k;
    o.vy += ny * k;
    this.damage(o, src, dmg);
    this.events.push({ t: 'hit', pid: o.id, src, dmg, x: o.x, y: o.y });
  }

  private kill(p: Warlock) {
    p.alive = false;
    p.hp = 0;
    p.deathTime = this.time;
    p.stats.deaths++;
    p.order = { type: 'idle' };
    p.cast = null;
    p.thrust = null;
    p.link = null;
    for (const o of this.players) if (o.link?.target === p.id) o.link = null;
    let killer = -1;
    if (p.lastHitBy >= 0 && p.lastHitBy !== p.id && this.time - p.lastHitTime < KILL_CREDIT_WINDOW) {
      killer = p.lastHitBy;
      const k = this.players[killer];
      k.stats.kills++;
      k.gold += GOLD_PER_KILL;
      this.events.push({ t: 'bounty', pid: k.id, gold: GOLD_PER_KILL, x: p.x, y: p.y });
    }
    this.events.push({ t: 'death', pid: p.id, killer, x: p.x, y: p.y, inLava: p.inLava });
  }

  ranking(): Warlock[] {
    return [...this.players].sort((a, b) =>
      b.stats.wins - a.stats.wins || b.stats.kills - a.stats.kills || b.stats.damage - a.stats.damage);
  }
}
