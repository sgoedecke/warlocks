import {
  ARENA_MB_BASE, CAST_POINT, COUNTDOWN_TIME, DEATHMATCH_REFRESH, DT, GOLD_MOST_DAMAGE,
  GOLD_PER_ASSIST, GOLD_PER_KILL, GOLD_PER_ROUND, GOLD_PER_WIN, ICE_TILE, ITEMS, LAVA_DAMAGE_PER_TICK,
  LAVA_INCREASE_PER_ROUND, LAVA_TICK, MAP_MAX, MAP_MIN, MODEL_PATHS, OBSTACLE_RADIUS, POINT_PER_ASSIST,
  POINT_PER_KILL, POINT_PER_WIN, RESPAWN_TIME, ROUND_END_TIME, SHOP_TIME, SHRINK_CR, SOUND_PATHS,
  SPAWN_PROTECTION, SPELLS, START_GOLD, TERRAIN_MIN, TERRAIN_THEMES, TILE_COUNT, TILE_SIZE, WARLOCK_BASE_SPEED,
  WARLOCK_HP, WARLOCK_RADIUS, WARLOCK_TURN_RATE, spellCooldown, spellPrice, type ItemId, type ProductId, type SpellId,
} from '../config';
import { Rng } from './rng';
import { decodeState, encodeState } from './snapshot';
import { dcos, datan2, dhypot, dsin } from './dmath';
import type {
  ArenaShape, Command, FreezeState, GameEvent, Meteor, Obstacle, Phase, PlayerSetup, Projectile,
  ProjectileKind, SimRules, TerrainThemeState, TimeShiftSnapshot, Warlock,
} from './types';

export function angleDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const DEFAULT_RULES: SimRules = {
  mode: 'round', rounds: 10, pointLimit: 20, teams: 'ffa', arenaShape: 'square', startingGold: START_GOLD,
};

const PROJ_MODELS: Partial<Record<ProjectileKind, string>> = {
  fireball: SPELLS.fireball.modelPath!, homing: SPELLS.homing.modelPath!, boomerang: SPELLS.boomerang.modelPath!,
  splitter: SPELLS.splitter.modelPath!, splitterShard: 'Abilities\\Spells\\Undead\\AbsorbMana\\AbsorbManaBirthMissile.mdl',
  displacement: SPELLS.displacement.modelPath!, drain: SPELLS.drain.modelPath!, drainReturn: 'Abilities\\Weapons\\FaerieDragonMissile\\FaerieDragonMissile.mdl',
  firespray: SPELLS.firespray.modelPath!, firesprayBolt: SPELLS.firespray.modelPath!, bouncer: SPELLS.bouncer.modelPath!,
  freeze: SPELLS.freeze.modelPath!, gravity: SPELLS.gravity.modelPath!, link: SPELLS.link.modelPath!,
};

// Obstacle unit types obs0..obs9 (model, usca) from war3map.w3u. DJ picks a pair obs(2i)/obs(2i+1).
const MULTIKILL_LABELS = ['', '', 'Double Kill', 'Multi Kill', 'Mega Kill', 'Ultra Kill', 'Monster Kill'];
const MULTIKILL_SOUNDS = ['', '', SOUND_PATHS.doubleKill, SOUND_PATHS.multiKill, SOUND_PATHS.megaKill, SOUND_PATHS.ultraKill, SOUND_PATHS.monsterKill];
const SPREE: [string, string][] = [['', ''], ['', ''], ['', ''],
  ['Killing Spree', SOUND_PATHS.killingSpree], ['Dominating', SOUND_PATHS.dominating], ['Ownage', SOUND_PATHS.ownage],
  ['Rampage', SOUND_PATHS.rampage], ['Unstoppable', SOUND_PATHS.unstoppable], ['Wicked Sick', SOUND_PATHS.wickedSick],
  ['Godlike', SOUND_PATHS.godLike], ['Holy Shit', SOUND_PATHS.holyShit]];
const OBSTACLE_TYPES: [string, number][] = [
  ['Doodads\\Cityscape\\Structures\\City_ColumnSingle1_Ruined\\City_ColumnSingle1_Ruined.mdl', 1],
  ['Doodads\\Cityscape\\Structures\\City_ColumnSingle\\City_ColumnSingle.mdl', 1],
  ['Doodads\\Barrens\\Rocks\\RockPillar\\RockPillar1.mdl', 1.8],
  ['Doodads\\Barrens\\Rocks\\RockPillar\\RockPillar0.mdl', 1.8],
  ['Doodads\\Barrens\\Plants\\Barrens_TreeDoodad\\Barrens_TreeDoodad1.mdl', 1.6],
  ['Doodads\\Barrens\\Plants\\Barrens_TreeDoodad\\Barrens_TreeDoodad0.mdl', 1.6],
  ['Doodads\\Ruins\\Props\\RuinsPillar\\RuinsPillar0.mdl', 1.6],
  ['Doodads\\Ruins\\Props\\RuinsPillar\\RuinsPillar2.mdl', 1.6],
  ['Doodads\\Outland\\Props\\Obstacle\\Obstacle3.mdl', 1.8],
  ['Doodads\\Outland\\Props\\Obstacle\\Obstacle2.mdl', 1.6],
];


export interface SimOptions { players: PlayerSetup[]; seed: number; rounds?: number; rules?: Partial<SimRules> }

function statBlock() {
  return { points: 0, kills: 0, deaths: 0, assists: 0, wins: 0, damage: 0, roundDamage: 0, fireballCasts: 0, fireballHits: 0 };
}

function itemCapacity(invLevel: number): number { return Math.floor(0.5 * (invLevel * invLevel + invLevel)); }
function clamp(v: number, a: number, b: number) { return Math.max(a, Math.min(b, v)); }
function norm(dx: number, dy: number): [number, number, number] {
  const d = dhypot(dx, dy);
  return d > 1e-6 ? [dx / d, dy / d, d] : [1, 0, 0];
}
function textSize(dmg: number): number { return 0.007 * Math.sqrt(Math.max(0, dmg) + 3.5); }
function terrainAtGrid(tiles: string[], gx: number, gy: number) { return tiles[gy * TILE_COUNT + gx] ?? ''; }

export class Sim {
  tick = 0;
  time = 0;
  rng: Rng;
  players: Warlock[];
  projectiles: Projectile[] = [];
  meteors: Meteor[] = [];
  obstacles: Obstacle[] = [];
  obstacleSets: Obstacle[][] = [];
  events: GameEvent[] = [];
  phase: Phase = 'shop';
  phaseTimer = SHOP_TIME;
  round = 1;
  totalRounds: number;
  rules: SimRules;
  roundTime = 0;
  roundWinner = -1;
  firstBlood = false;
  terrainVersion = 0;
  terrainTiles: string[] = [];
  theme: TerrainThemeState;
  ice: { x: number; y: number; square: boolean; size: number } | null = null;
  arenaMB = ARENA_MB_BASE;
  arenaShape: ArenaShape = 'square';
  lavaTimer = LAVA_TICK;
  shrinkTimer = 999;
  deathmatchRefreshTimer = DEATHMATCH_REFRESH;
  /** Deathmatch terrain refreshes so far, each of which paid out gold. */
  refreshes = 0;
  private nextId = 1;

  constructor(opts: SimOptions) {
    this.rng = new Rng(opts.seed);
    this.rules = { ...DEFAULT_RULES, rounds: opts.rounds ?? DEFAULT_RULES.rounds, ...(opts.rules ?? {}) };
    this.totalRounds = this.rules.rounds;
    this.arenaShape = this.rules.arenaShape;
    this.theme = this.pickTheme();
    this.terrainTiles = Array.from({ length: TILE_COUNT * TILE_COUNT }, () => this.theme.lava);
    this.players = opts.players.map((p, i) => this.makeWarlock(i, p));
    for (const p of this.players) p.contributions = Array.from({ length: this.players.length }, () => 0);
    this.toShopPositions();
    this.paintArena(ARENA_MB_BASE + this.players.length / 2, true);
    if (this.rules.mode === 'deathmatch') {
      this.phase = 'fight';
      this.phaseTimer = 0;
      this.startCombatRound(true);
    }
  }

  private makeWarlock(id: number, p: PlayerSetup): Warlock {
    const team = this.rules.teams === '2teams' ? id % 2 : (p.team ?? id);
    return {
      id, name: p.name, color: p.color, team, isBot: p.isBot,
      x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, mvx: 0, mvy: 0, facing: 0, pfacing: 0,
      hp: WARLOCK_HP, maxHp: WARLOCK_HP, damagePoints: 0, alive: true, left: false, deathTime: 0, respawn: 0, diedInLava: false,
      order: { type: 'idle' }, cast: null, spells: { fireball: 1, scourge: 1 }, chosen: {}, cooldowns: {}, gold: this.rules.startingGold, ready: false,
      spawnProtection: SPAWN_PROTECTION, shield: 0, windwalk: 0, windwalkSpeed: 1, thrust: null, link: null, frozen: null, timeshift: null, rush: null,
      inLava: false, terrain: this.theme.safe, lastHitBy: -1, lastHitTime: -99, contributions: [], lastCastTime: -99, lastCastSpell: null,
      moveSpeed: WARLOCK_BASE_SPEED, BC: 1, CC: 1, DC: 1, NR: 1, RA: 0, AA: 0, IA: 0, OA: 0,
      inventoryLevel: 1, itemSlots: [], soj: false, fireSprayFan: false, splitterContinuous: false,
      multikillCount: 0, lastKillTime: -99, spree: 0, stats: statBlock(),
    };
  }

  /**
   * A player joining mid-game. They get the gold and lava scaling everyone else has been given over
   * time; in deathmatch they spawn straight away, in round mode they wait for the next round.
   */
  private addPlayer(c: Extract<Command, { type: 'join' }>) {
    if (c.pid !== this.players.length) return;
    const p = this.makeWarlock(c.pid, { name: c.name, color: c.color, isBot: false });
    const periods = this.rules.mode === 'deathmatch' ? this.refreshes : this.round - 1;
    p.gold += periods * GOLD_PER_ROUND;
    p.NR += periods * LAVA_INCREASE_PER_ROUND;
    for (const o of this.players) o.contributions.push(0);
    p.contributions = Array.from({ length: this.players.length + 1 }, () => 0);
    this.players.push(p);
    if (this.rules.mode === 'deathmatch') this.respawn(p);
    else if (this.phase === 'shop') {
      p.x = p.px = 128 * (p.id - 6) - 64;
      p.y = p.py = -64;
      p.facing = p.pfacing = -Math.PI / 2;
    } else {
      p.alive = false;
      p.ready = true;
    }
    this.events.push({ t: 'joined', pid: p.id });
  }

  /** The whole sim state, for a player joining a game in progress. */
  snapshot(): string {
    const { rng, obstacles, events, ...rest } = this as unknown as Record<string, unknown> & { rng: Rng; obstacles: Obstacle[] };
    void events;
    // The live obstacles are one of the sets, by reference.
    const set = this.obstacleSets.indexOf(obstacles);
    return encodeState({ ...rest, rng: rng.state, obstacleSet: set, obstacles: set < 0 ? obstacles : null });
  }

  static restore(state: string): Sim {
    const { rng, obstacleSet, obstacles, ...rest } = decodeState<Record<string, unknown> & { rng: number; obstacleSet: number; obstacles: Obstacle[] | null }>(state);
    const sim = Object.assign(Object.create(Sim.prototype) as Sim, rest);
    sim.rng = new Rng(0);
    sim.rng.state = rng;
    sim.obstacles = obstacleSet >= 0 ? sim.obstacleSets[obstacleSet] : obstacles ?? [];
    sim.events = [];
    return sim;
  }

  get arenaRadius(): number { return this.arenaMB * TILE_SIZE; }
  get(pid: number): Warlock | undefined { return this.players[pid]; }
  isEnemy(a: number | Warlock, b: number | Warlock) {
    const pa = typeof a === 'number' ? this.players[a] : a;
    const pb = typeof b === 'number' ? this.players[b] : b;
    return !!pa && !!pb && pa.id !== pb.id && pa.team !== pb.team;
  }
  isVisibleTo(target: Warlock, viewer: number): boolean { return target.id === viewer || target.windwalk <= 0 || target.team === this.players[viewer]?.team; }

  private pickTheme(): TerrainThemeState {
    const total = TERRAIN_THEMES.reduce((s, t) => s + t.weight, 0);
    let r = this.rng.range(0, total);
    for (const t of TERRAIN_THEMES) if ((r -= t.weight) <= 0) return { ...t };
    return { ...TERRAIN_THEMES[0] };
  }

  private setPhase(phase: Phase, timer: number) {
    this.phase = phase;
    this.phaseTimer = timer;
    this.events.push({ t: 'phase', phase });
    if (phase === 'gameOver') this.events.push({ t: 'gameOver' });
  }

  private terrainIndex(x: number, y: number): [number, number] {
    const gx = clamp(Math.round((x - TERRAIN_MIN) / TILE_SIZE), 0, TILE_COUNT - 1);
    const gy = clamp(Math.round((y - TERRAIN_MIN) / TILE_SIZE), 0, TILE_COUNT - 1);
    return [gx, gy];
  }
  terrainAt(x: number, y: number): string {
    const [gx, gy] = this.terrainIndex(x, y);
    return terrainAtGrid(this.terrainTiles, gx, gy);
  }
  isSafePoint(x: number, y: number): boolean { return this.terrainAt(x, y) !== this.theme.lava; }

  /** Mirrors JASS RM(): lava square of MB+1, safe brush of MB, then the round's ice patch on top. */
  private paintArena(mb: number, newRound = false, fill = true) {
    this.arenaMB = Math.max(0, mb);
    if (newRound) {
      this.theme = this.pickTheme();
      this.ice = this.rng.chance(0.5)
        ? { x: this.rng.range(-750, 750), y: this.rng.range(-750, 750), square: this.rng.int(2) === 1, size: this.rng.int(2) + 2 }
        : null;
    }
    const brush = (cx: number, cy: number, area: number, square: boolean, code: string) => {
      if (area <= 0) return;
      const [gx0, gy0] = this.terrainIndex(cx, cy);
      const r = Math.ceil(area);
      for (let gy = gy0 - r; gy <= gy0 + r; gy++) for (let gx = gx0 - r; gx <= gx0 + r; gx++) {
        if (gx < 0 || gy < 0 || gx >= TILE_COUNT || gy >= TILE_COUNT) continue;
        const dx = gx - gx0, dy = gy - gy0;
        if (square ? Math.max(Math.abs(dx), Math.abs(dy)) < area : dhypot(dx, dy) < area) this.terrainTiles[gy * TILE_COUNT + gx] = code;
      }
    };
    // A1/WK first flood the whole map with the theme's lava (SetTerrainType(...,'d',1)); shrink steps don't.
    if (fill) this.terrainTiles.fill(this.theme.lava);
    brush(0, 0, this.arenaMB + 1, true, this.theme.lava);
    brush(0, 0, this.arenaMB, this.arenaShape !== 'circle', this.theme.safe);
    if (this.ice) brush(this.ice.x, this.ice.y, this.ice.size, this.ice.square, ICE_TILE);
    this.terrainVersion++;
    this.events.push({ t: 'terrain', version: this.terrainVersion });
  }

  /** DJ: all obstacle sets are created once at map init (set 1 is empty); each round shows one. */
  private createObstacleSets() {
    this.obstacleSets = [[], [], [], [], [], [], []];
    const pickPair = () => { let i = this.rng.int(4); if (this.rng.int(1000) + 1 > 997) i = 4; return i; };
    const add = (set: number, x: number, y: number, i: number) => {
      const type = 2 * i + this.rng.int(2);
      const [modelPath, scale] = OBSTACLE_TYPES[type];
      this.obstacleSets[set].push({ id: this.nextId++, x, y, radius: OBSTACLE_RADIUS, modelPath, variant: `obs${type}`, scale, facing: this.rng.range(0, Math.PI * 2) });
    };
    let i = pickPair();
    for (const [x, y] of [[896, 384], [-896, 384], [896, -384], [-896, -384], [384, 896], [-384, 896], [384, -896], [-384, -896]]) add(2, x, y, i);
    pickPair();
    const lim = 768 + 64 * this.players.length;
    i = pickPair();
    for (let n = 0; n < 3; n++) add(3, this.rng.range(-lim, lim), this.rng.range(-lim, lim), i);
    i = pickPair();
    for (const [x, y] of [[896, 896], [-896, -896], [896, -896], [-896, 896]]) add(4, x, y, i);
    i = pickPair();
    for (const [x, y] of [[896, 0], [-896, 0], [0, -896], [0, 896]]) add(5, x, y, i);
    i = pickPair();
    add(6, 0, 0, i);
  }

  private placeObstacles() {
    if (!this.obstacleSets.length) this.createObstacleSets();
    this.obstacles = this.obstacleSets[this.rng.int(6) + 1];
  }

  private toShopPositions() {
    for (const p of this.players) {
      const x = 128 * (p.id - 6) - 64;
      p.x = p.px = x;
      p.y = p.py = -64;
      p.facing = p.pfacing = -Math.PI / 2;
      p.vx = p.vy = p.mvx = p.mvy = 0;
      p.alive = !p.left;
      p.hp = p.maxHp;
      p.damagePoints = 0;
      p.spawnProtection = 0;
      p.order = { type: 'idle' };
      p.cast = null;
      p.ready = p.left;
    }
  }

  private spawnCircle() {
    const active = this.players.filter((p) => p.alive);
    const n = active.length;
    const r = 768 + 64 * this.players.length;
    const off = this.rng.range(0, Math.PI * 2);
    active.forEach((p, i) => {
      const angle = this.rules.teams === '2teams' ? off + (p.team % 2) * Math.PI : off + (i / n) * Math.PI * 2;
      p.x = p.px = dcos(angle) * r;
      p.y = p.py = dsin(angle) * r;
      p.facing = p.pfacing = angle + Math.PI;
    });
  }

  private resetFighter(p: Warlock, fullReset: boolean) {
    p.hp = p.maxHp;
    p.damagePoints = 0;
    p.alive = !p.left;
    p.respawn = 0;
    p.spree = 0;
    p.multikillCount = 0;
    p.vx = p.vy = p.mvx = p.mvy = 0;
    p.order = { type: 'idle' };
    p.cast = null;
    p.cooldowns = fullReset ? {} : p.cooldowns;
    p.shield = p.windwalk = 0;
    p.windwalkSpeed = 1;
    p.thrust = null;
    p.link = null;
    p.frozen = null;
    p.timeshift = null;
    p.rush = null;
    p.spawnProtection = SPAWN_PROTECTION;
    p.lastHitBy = -1;
    p.lastHitTime = -99;
    p.diedInLava = false;
    p.inLava = false;
    p.stats.roundDamage = 0;
    p.contributions.fill(0);
  }

  private startCombatRound(fromConstructor = false) {
    this.roundTime = 0;
    this.roundWinner = -1;
    this.projectiles = [];
    this.meteors = [];
    this.firstBlood = this.firstBlood && this.rules.mode === 'deathmatch';
    this.paintArena(ARENA_MB_BASE + this.players.length / 2);
    this.placeObstacles();
    for (const p of this.players) this.resetFighter(p, true);
    this.spawnCircle();
    this.lavaTimer = LAVA_TICK;
    this.shrinkTimer = SHRINK_CR * Math.sqrt(Math.max(1, this.livingTeamsOrPlayers()));
    this.deathmatchRefreshTimer = DEATHMATCH_REFRESH;
    if (!fromConstructor && this.rules.mode === 'round') this.setPhase('countdown', COUNTDOWN_TIME);
  }

  step(cmds: Command[]) {
    this.events = [];
    for (const p of this.players) { p.px = p.x; p.py = p.y; p.pfacing = p.facing; }
    for (const pr of this.projectiles) { pr.px = pr.x; pr.py = pr.y; }
    for (const c of cmds) this.applyCommand(c);

    this.phaseTimer -= DT;
    if (this.phase === 'shop') {
      if (this.phaseTimer <= 0 || this.players.every((p) => p.ready || p.left)) this.startCombatRound();
    } else if (this.phase === 'countdown') {
      if (this.phaseTimer <= 0) this.setPhase('fight', 0);
      this.updateCooldownsAndStatuses();
    } else if (this.phase === 'fight' || this.phase === 'roundEnd') {
      this.updateFight();
      if (this.phase === 'roundEnd' && this.phaseTimer <= 0) this.afterRoundEnd();
    }
    this.time += DT;
    this.tick++;
  }

  private afterRoundEnd() {
    if (this.rules.mode === 'deathmatch') return;
    if (this.round >= this.totalRounds) {
      const best = Math.max(...this.players.map((p) => p.stats.points));
      if (this.players.filter((p) => p.stats.points === best).length === 1) {
        this.setPhase('gameOver', 0);
        return;
      }
      this.totalRounds++;
      this.events.push({ t: 'announcement', text: 'Tie score — duel round!' });
    }
    this.round++;
    for (const p of this.players) {
      p.gold += GOLD_PER_ROUND;
      p.NR += LAVA_INCREASE_PER_ROUND;
      p.ready = p.left;
    }
    this.toShopPositions();
    this.paintArena(8 + this.players.length / 2, true);
    this.setPhase('shop', SHOP_TIME);
  }

  private applyCommand(c: Command) {
    if (c.type === 'join') { this.addPlayer(c); return; }
    const p = this.players[c.pid];
    if (!p || p.left) return;
    if (c.type === 'leave') { this.leave(p); return; }
    if (c.type === 'buy') { this.buy(p, c.product); return; }
    if (c.type === 'sell') { this.sell(p, c.slot); return; }
    if (c.type === 'ready') { if (this.phase === 'shop') p.ready = true; return; }
    if (c.type === 'toggle') { if (c.spell === 'firespray') p.fireSprayFan = !p.fireSprayFan; else p.splitterContinuous = !p.splitterContinuous; return; }
    const countdown = this.phase === 'countdown';
    if ((this.phase !== 'fight' && this.phase !== 'roundEnd' && !countdown) || !p.alive) return;
    if (p.frozen || p.thrust) return;
    if (c.type === 'move') { p.order = { type: 'move', x: c.x, y: c.y }; p.cast = null; }
    else if (c.type === 'stop') { p.order = { type: 'idle' }; p.cast = null; }
    else if (c.type === 'cast') {
      const lvl = p.spells[c.spell] ?? 0;
      if (lvl <= 0) return;
      if ((p.cooldowns[c.spell] ?? 0) > 0) { this.events.push({ t: 'error', pid: p.id, msg: 'Spell is not ready yet.' }); return; }
      if (SPELLS[c.spell].targeting === 'none') {
        if (!countdown) this.executeSpell(p, c.spell, p.x, p.y);
      } else {
        p.order = { type: 'cast', spell: c.spell, x: c.x, y: c.y };
        p.cast = null;
      }
    }
  }

  private masteryPrice(kind: 'rangeMastery' | 'aoeMastery' | 'lifestealMastery', level: number) { void kind; return 8 + 2 * level; }
  private buy(p: Warlock, product: ProductId) {
    if (this.phase !== 'shop' && this.rules.mode !== 'deathmatch') return;
    if (product === 'rangeMastery' || product === 'aoeMastery' || product === 'lifestealMastery') {
      const level = product === 'rangeMastery' ? p.IA : product === 'aoeMastery' ? p.AA : p.RA;
      const price = this.masteryPrice(product, level);
      if (p.gold < price) return this.error(p, 'Not enough gold.');
      p.gold -= price;
      if (product === 'rangeMastery') p.IA++; else if (product === 'aoeMastery') p.AA++; else p.RA++;
      this.events.push({ t: 'buy', pid: p.id, product, level: level + 1, gold: price });
      return;
    }
    if (product === 'inventory') {
      const price = 3;
      if (p.inventoryLevel >= 3) return this.error(p, 'Inventory is already full size.');
      if (p.gold < price) return this.error(p, 'Not enough gold.');
      p.gold -= price; p.inventoryLevel++;
      this.events.push({ t: 'buy', pid: p.id, product, level: p.inventoryLevel, gold: price });
      return;
    }
    if (product in ITEMS) { this.buyItem(p, product as ItemId); return; }
    const id = product as SpellId;
    const def = SPELLS[id];
    if (!def) return;
    const current = p.spells[id] ?? 0;
    const chosen = p.chosen[def.column];
    if (def.column !== 'core' && chosen && chosen !== id && current <= 0) {
      // The original can spend with no refund when a locked column slips through.
      const lost = spellPrice(id, 0);
      if (p.gold >= lost) p.gold -= lost;
      this.events.push({ t: 'error', pid: p.id, msg: 'Buying two spells of same hotkey is waste of money' });
      return;
    }
    const max = def.maxLevel + (p.soj && current >= def.maxLevel ? 2 : 0);
    if (current >= max) return this.error(p, 'Maximum level reached.');
    const price = spellPrice(id, current);
    if (p.gold < price) return this.error(p, 'Not enough gold.');
    p.gold -= price;
    p.spells[id] = current + 1;
    if (def.column !== 'core') p.chosen[def.column] = id;
    if (id === 'scourge') p.OA = Math.min(2, p.OA + 1);
    if (p.soj && current >= def.maxLevel) p.soj = false;
    this.events.push({ t: 'buy', pid: p.id, product: id, level: current + 1, gold: price });
  }

  private buyItem(p: Warlock, id: ItemId) {
    const def = ITEMS[id];
    const stack = p.itemSlots.find((it) => it.id === id);
    const lvl = stack?.level ?? 0;
    if (lvl >= def.max) return this.error(p, 'Item is already maxed.');
    if (!stack && p.itemSlots.length >= itemCapacity(p.inventoryLevel)) return this.error(p, 'Not enough inventory space.');
    const price = def.costs[lvl];
    if (p.gold < price) return this.error(p, 'Not enough gold.');
    p.gold -= price;
    if (stack) stack.level++; else p.itemSlots.push({ id, level: 1 });
    this.applyItemStats(p, id, lvl, lvl + 1);
    this.events.push({ t: 'buy', pid: p.id, product: id, level: lvl + 1, gold: price });
  }

  private sell(p: Warlock, slot: number) {
    const it = p.itemSlots[slot];
    if (!it || it.id === 'soj') return;
    const def = ITEMS[it.id];
    p.gold += def.sell[it.level - 1] ?? 0;
    this.applyItemStats(p, it.id, it.level, 0);
    p.itemSlots.splice(slot, 1);
  }

  private applyItemStats(p: Warlock, id: ItemId, oldLevel: number, newLevel: number) {
    const spd = (lvl: number) => id === 'boots' ? [0, 20, 30, 40][lvl] : id === 'cape' ? [0, -8, -12, -16][lvl] : id === 'helm' ? [0, -5, -10, -15][lvl] : id === 'mask' ? [0, -22][lvl] : id === 'aegis' ? [0, -10, -20][lvl] : 0;
    p.moveSpeed += (spd(newLevel) ?? 0) - (spd(oldLevel) ?? 0);
    if (id === 'pendant') p.maxHp += [0, 10, 20, 30][newLevel] - [0, 10, 20, 30][oldLevel];
    if (id === 'helm') p.DC *= ([1, 0.84, 0.76, 0.68][newLevel] ?? 1) / ([1, 0.84, 0.76, 0.68][oldLevel] ?? 1);
    if (id === 'cape') p.NR *= ([1, 0.85, 0.8, 0.75][newLevel] ?? 1) / ([1, 0.85, 0.8, 0.75][oldLevel] ?? 1);
    if (id === 'mask') { p.RA += (newLevel ? 4 : 0) - (oldLevel ? 4 : 0); p.DC *= (newLevel ? 1.06 : 1) / (oldLevel ? 1.06 : 1); }
    if (id === 'staff') p.spells.fireball = Math.max(1, (p.spells.fireball ?? 1) + (oldLevel ? 2 : 0) - (newLevel ? 2 : 0));
    if (id === 'sword') { p.OA += newLevel - oldLevel; p.spells.scourge = 1 + p.OA; }
    if (id === 'aegis') p.CC *= ([1, 0.9, 0.8][newLevel] ?? 1) / ([1, 0.9, 0.8][oldLevel] ?? 1);
    if (id === 'soj' && newLevel > oldLevel) p.soj = true;
    p.hp = clamp(p.hp, 0, p.maxHp);
  }

  private error(p: Warlock, msg: string) { this.events.push({ t: 'error', pid: p.id, msg }); }

  private updateCooldownsAndStatuses() {
    for (const p of this.players) {
      for (const key of Object.keys(p.cooldowns) as SpellId[]) p.cooldowns[key] = Math.max(0, (p.cooldowns[key] ?? 0) - DT);
      p.spawnProtection = Math.max(0, p.spawnProtection - DT);
      if (p.shield > 0) p.shield = Math.max(0, p.shield - DT);
      if (p.windwalk > 0) p.windwalk = Math.max(0, p.windwalk - DT);
    }
  }

  private updateFight() {
    this.roundTime += DT;
    this.updateCooldownsAndStatuses();
    if (this.rules.mode === 'deathmatch') this.updateDeathmatchTimers();
    this.updateShrink();
    for (const p of this.players) if (p.alive) this.updateWarlock(p);
    this.collideWarlocks();
    this.collideObstaclesWithWarlocks();
    this.updateProjectiles();
    this.updateMeteors();
    this.lavaTimer -= DT;
    if (this.lavaTimer <= 0) { this.lavaTimer += LAVA_TICK; this.lavaCheck(); }
    for (const p of this.players) if (p.alive && p.hp <= 0) this.kill(p);
    if (this.phase === 'fight') this.checkWinCondition();
  }

  private updateDeathmatchTimers() {
    this.deathmatchRefreshTimer -= DT;
    if (this.deathmatchRefreshTimer <= 0) {
      this.deathmatchRefreshTimer += DEATHMATCH_REFRESH;
      this.refreshes++;
      this.paintArena(ARENA_MB_BASE + this.players.length / 2, true);
      this.placeObstacles();
      for (const p of this.players) { p.gold += GOLD_PER_ROUND; p.NR += LAVA_INCREASE_PER_ROUND; }
      this.events.push({ t: 'announcement', text: 'Terrain refreshed!', soundPath: SOUND_PATHS.rescue });
    }
    for (const p of this.players) if (!p.alive && p.respawn > 0) {
      p.respawn -= DT;
      if (p.respawn <= 0) this.respawn(p);
    }
  }

  private updateShrink() {
    if (this.rules.mode !== 'round' && this.rules.mode !== 'deathmatch') return;
    this.shrinkTimer -= DT;
    if (this.shrinkTimer <= 0 && this.arenaMB > 0) {
      this.paintArena(this.arenaMB - 1, false, false);
      this.shrinkTimer = SHRINK_CR * Math.sqrt(Math.max(1, this.livingTeamsOrPlayers()));
    }
  }

  private turnToward(p: Warlock, tx: number, ty: number): number {
    const want = datan2(ty - p.y, tx - p.x);
    const d = angleDiff(p.facing, want);
    const max = WARLOCK_TURN_RATE * DT;
    p.facing += clamp(d, -max, max);
    return Math.abs(angleDiff(p.facing, want));
  }
  private controlledToward(p: Warlock, tx: number, ty: number) {
    const dx = tx - p.x, dy = ty - p.y;
    const dist = dhypot(dx, dy);
    if (dist < 1) { p.mvx = p.mvy = 0; return; }
    const off = this.turnToward(p, tx, ty);
    const speed = Math.max(0, p.moveSpeed + (p.rush?.speedBonus ?? 0)) * (p.windwalk > 0 ? p.windwalkSpeed : 1) * Math.max(0, dcos(off));
    const step = Math.min(speed * DT, dist);
    p.mvx = dcos(p.facing) * step;
    p.mvy = dsin(p.facing) * step;
  }

  private updateWarlock(p: Warlock) {
    p.mvx = p.mvy = 0;
    if (p.timeshift) {
      p.timeshift.time -= DT;
      if (p.timeshift.time <= 0) this.restoreTimeShift(p);
    }
    if (p.frozen) {
      p.frozen.time -= DT;
      p.vx *= 0.98; p.vy *= 0.98;
      if (p.frozen.time <= 0) this.unfreeze(p);
    } else if (p.thrust) {
      const t = p.thrust;
      p.vx += t.dx * 1.56; p.vy += t.dy * 1.56;
      t.remainingTicks -= dhypot(p.vx, p.vy);
      if (this.tick % 3 === 0) this.events.push({ t: 'effect', name: 'thrustAfterimage', x: p.x, y: p.y, modelPath: 'BloodelfWizard.mdl', scale: 0.92 });
      const tx = p.x + p.vx + p.mvx;
      const ty = p.y + p.vy + p.mvy;
      for (const o of this.players) if (this.isEnemy(p, o) && o.alive && this.sweptHit(p.x, p.y, tx, ty, o.x, o.y, WARLOCK_RADIUS * 2)) {
        const dmg = 5.4 + 0.6 * t.level + (p.windwalk > 0 ? 6 + (p.spells.windwalk ?? 1) : 0);
        this.damageTL(p.id, o, dmg, p.windwalk > 0 ? 0.6 : 1);
        p.windwalk = 0;
        p.thrust = null;
        p.vx = p.vy = 0;
        this.events.push({ t: 'thrustHit', x: (p.x + o.x) / 2, y: (p.y + o.y) / 2, modelPath: 'Abilities\\Spells\\Human\\Thunderclap\\ThunderClapCaster.mdl' });
        break;
      }
      if (p.thrust && t.remainingTicks <= 0) { p.thrust = null; p.vx *= 0.2; p.vy *= 0.2; this.events.push({ t: 'effect', name: 'thrustEnd', x: p.x, y: p.y, modelPath: 'Abilities\\Spells\\Undead\\FreezingBreath\\FreezingBreathMissile.mdl' }); }
    } else {
      const o = p.order;
      if (o.type === 'move') {
        if (dhypot(o.x - p.x, o.y - p.y) < 4) p.order = { type: 'idle' };
        else this.controlledToward(p, o.x, o.y);
      } else if (o.type === 'cast') {
        const off = this.turnToward(p, o.x, o.y);
        if (!p.cast && off < 0.35) p.cast = { spell: o.spell, x: o.x, y: o.y, timer: CAST_POINT };
        if (p.cast) {
          p.cast.timer -= DT;
          if (p.cast.timer <= 0) { const c = p.cast; p.cast = null; p.order = { type: 'idle' }; this.executeSpell(p, c.spell, c.x, c.y); }
        }
      }
    }
    this.updateLinks(p);
    const terrain = this.terrainAt(p.x, p.y);
    p.terrain = terrain;
    if (terrain === ICE_TILE && !p.frozen) {
      if (dhypot(p.mvx, p.mvy) > 0.001) {
        const [nx, ny] = norm(p.mvx, p.mvy);
        const along = p.vx * nx + p.vy * ny;
        if (along <= (p.moveSpeed * DT)) { p.vx += nx * 0.315 * (p.moveSpeed / WARLOCK_BASE_SPEED); p.vy += ny * 0.315 * (p.moveSpeed / WARLOCK_BASE_SPEED); }
      }
      p.mvx = p.mvy = 0;
      p.vx *= 0.98; p.vy *= 0.98;
    } else if (!p.frozen) {
      p.vx = (p.vx) * 0.96; p.vy = (p.vy) * 0.96;
    }
    p.x += p.vx + p.mvx;
    p.y += p.vy + p.mvy;
    this.clampBounds(p);
  }

  private updateLinks(p: Warlock) {
    if (!p.link) return;
    const t = this.players[p.link.target];
    p.link.time -= DT;
    if (!t || !t.alive || p.link.time <= 0) { p.link = null; return; }
    const dx = t.x - p.x, dy = t.y - p.y;
    const [nx, ny, d] = norm(dx, dy);
    if (d <= 100) { p.link = null; return; }
    t.vx -= nx * 1.5; t.vy -= ny * 1.5;
    if (this.tick % 5 === 0) {
      this.damageUL(p.id, t, 0.2 + 0.1 * p.link.level);
      this.events.push({ t: 'lightning', pid: p.id, x1: p.x, y1: p.y, x2: t.x, y2: t.y, hit: true, code: 'DRAM' });
    }
  }

  private clampBounds(e: { x: number; y: number; vx: number; vy: number }) {
    if (e.x < MAP_MIN) { e.x = MAP_MIN; e.vx *= -0.5; } else if (e.x > MAP_MAX) { e.x = MAP_MAX; e.vx *= -0.5; }
    if (e.y < MAP_MIN) { e.y = MAP_MIN; e.vy *= -0.5; } else if (e.y > MAP_MAX) { e.y = MAP_MAX; e.vy *= -0.5; }
  }

  private collideWarlocks() {
    for (let i = 0; i < this.players.length; i++) {
      const a = this.players[i]; if (!a.alive) continue;
      for (let j = i + 1; j < this.players.length; j++) {
        const b = this.players[j]; if (!b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y; const d = dhypot(dx, dy) || 1; const min = WARLOCK_RADIUS * 2;
        if (d >= min) continue;
        const nx = dx / d, ny = dy / d, push = (min - d) / 2;
        a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        const rvx = b.vx - a.vx, rvy = b.vy - a.vy;
        const s = ((dx * rvx + dy * rvy) / (d * d + 0.01)) * 0.75;
        b.vx += s * dx; b.vy += s * dy; a.vx -= s * dx; a.vy -= s * dy;
      }
    }
  }

  private collideObstaclesWithWarlocks() { for (const o of this.obstacles) for (const p of this.players) if (p.alive) this.resolveObstacle(o, p); }
  private resolveObstacle(o: Obstacle, e: { x: number; y: number; vx: number; vy: number }, radius = WARLOCK_RADIUS, g = 0.5) {
    const dx = e.x - o.x, dy = e.y - o.y; const d = dhypot(dx, dy) || 1; const min = radius + o.radius;
    if (d >= min) return;
    const nx = dx / d, ny = dy / d;
    e.x = o.x + nx * min; e.y = o.y + ny * min;
    const normal = e.vx * nx + e.vy * ny;
    if (normal < 1.1 * (WARLOCK_BASE_SPEED * DT)) { e.vx -= (1 + g) * normal * nx; e.vy -= (1 + g) * normal * ny; }
  }

  private lavaCheck() {
    for (const p of this.players) {
      if (!p.alive) continue;
      const terrain = this.terrainAt(p.x, p.y);
      p.inLava = terrain === this.theme.lava;
      if (!p.inLava) continue;
      const amount = LAVA_DAMAGE_PER_TICK * p.NR;
      p.hp -= amount;
      p.damagePoints += amount;
      if (p.lastHitBy >= 0 && p.lastHitBy !== p.id) {
        p.contributions[p.lastHitBy] += amount;
        this.players[p.lastHitBy].stats.damage += amount;
        this.players[p.lastHitBy].stats.roundDamage += amount;
      }
      if (p.hp <= 0) p.diedInLava = true;
    }
  }

  private executeSpell(p: Warlock, spell: SpellId, tx: number, ty: number) {
    const lvl = p.spells[spell] ?? 1;
    p.cooldowns[spell] = spellCooldown(spell, lvl);
    p.lastCastTime = this.time;
    p.lastCastSpell = spell;
    if (spell !== 'windwalk') p.windwalk = 0;
    const [nx, ny, dist] = norm(tx - p.x, ty - p.y);
    this.events.push({ t: 'cast', pid: p.id, spell, x: tx, y: ty, modelPath: SPELLS[spell].modelPath });
    switch (spell) {
      case 'fireball': p.stats.fireballCasts++; this.spawnProjectile(p, 'fireball', nx, ny, 1000 * DT, 25, 1000 * (1 + 0.1 * p.IA), 1 + 0.1 * p.IA, lvl); break;
      case 'scourge': this.castScourge(p); break;
      case 'lightning': this.castLightning(p, nx, ny, lvl); break;
      case 'homing': this.spawnProjectile(p, 'homing', nx, ny, 700 * DT, 25, Infinity, (4.5 + 0.5 * lvl) * (1 + 0.1 * p.IA), lvl); break;
      case 'boomerang': this.spawnBoomerang(p, nx, ny, lvl, Math.max(300, Math.min(dist, 800 + 50 * lvl))); break;
      case 'meteor': this.spawnMeteor(p, tx, ty, lvl); break;
      case 'splitter': this.spawnProjectile(p, 'splitter', nx, ny, (p.splitterContinuous ? 475 : 700) * DT, p.splitterContinuous ? 30 : 50, 700 * (1 + 0.1 * p.IA), p.splitterContinuous ? 700 * (1 + 0.1 * p.IA) / 475 : Math.min(dist, 700 * (1 + 0.1 * p.IA)) / 700 + 0.03, lvl); break;
      case 'windwalk': p.windwalk = [3, 3.25, 3.5, 3.75, 4, 4.25, 4.5, 5][Math.min(7, lvl - 1)]; p.windwalkSpeed = (p.moveSpeed + 200) / p.moveSpeed; break;
      case 'teleport': this.teleport(p, nx, ny, Math.min(dist, 700 + 70 * lvl)); break;
      case 'thrust': p.facing = datan2(ny, nx); p.thrust = { dx: nx, dy: ny, remainingTicks: ((620 + 80 * lvl) * (1 + 0.1 * p.IA)), level: lvl }; p.vx = nx * 39; p.vy = ny * 39; break;
      case 'displacement': this.spawnProjectile(p, 'displacement', nx, ny, 1700 * DT, 40, (600 + 100 * lvl) * (1 + 0.1 * p.IA), Math.min(dist, (600 + 100 * lvl) * (1 + 0.1 * p.IA)) / 1700 + 0.03, lvl); break;
      case 'drain': this.spawnProjectile(p, 'drain', nx, ny, 600 * DT, 22, 700 * (1 + 0.1 * p.IA), Math.min(dist, 700 * (1 + 0.1 * p.IA)) / 700 * 7 / 6, lvl); break;
      case 'firespray': this.castFireSpray(p, nx, ny, lvl); break;
      case 'bouncer': this.spawnProjectile(p, 'bouncer', nx, ny, 900 * DT, 33, (750 + 150 * lvl) * (1 + 0.1 * p.IA), (750 + 150 * lvl) * (1 + 0.1 * p.IA) / 900, lvl); break;
      case 'shield': p.shield = 2.5 + 0.5 * lvl; this.events.push({ t: 'effect', name: 'shield', x: p.x, y: p.y, modelPath: 'shld', soundPath: SOUND_PATHS.shield }); break;
      case 'timeshift': this.timeShift(p); break;
      case 'rush': p.rush = { time: 6.2 + 0.8 * lvl, speedBonus: (7 + 1.5 * lvl) * 10, level: lvl }; break;
      case 'freeze': this.spawnProjectile(p, 'freeze', nx, ny, 900 * DT, 40, 900 * (1 + 0.1 * p.IA), 1 + 0.1 * p.IA, lvl); break;
      case 'gravity': this.spawnProjectile(p, 'gravity', nx, ny, 400 * DT, 35, 800 * (1 + 0.1 * p.IA), 2 * (1 + 0.1 * p.IA), lvl, false, false, true); break;
      case 'link': this.spawnProjectile(p, 'link', nx, ny, (600 + 100 * lvl) * DT, 35, (600 + 100 * lvl) * (1 + 0.1 * p.IA), 99, lvl, true, false, true); break;
    }
  }

  private spawnProjectile(owner: Warlock, kind: ProjectileKind, nx: number, ny: number, speedTick: number, radius: number, maxDist: number, life: number, lvl: number, cw = true, cp = true, co = true) {
    const off = WARLOCK_RADIUS + radius + 2;
    const pr: Projectile = { id: this.nextId++, kind, owner: owner.id, x: owner.x + nx * off, y: owner.y + ny * off, px: owner.x, py: owner.y, vx: nx * speedTick, vy: ny * speedTick, ax: 0, ay: 0, radius, life, age: 0, level: lvl, traveled: 0, maxDist, returning: false, dead: false, hitIds: [], targetId: -1, damageScale: 1, splitAngle: datan2(ny, nx), modelPath: PROJ_MODELS[kind] ?? SPELLS.fireball.modelPath!, scale: SPELLS[kind as SpellId]?.scale ?? 1, collidesWarlock: cw, collidesProjectile: cp, collidesObstacle: co };
    this.projectiles.push(pr);
    this.events.push({ t: 'spawnProjectile', id: pr.id, kind, owner: owner.id, x: pr.x, y: pr.y, modelPath: pr.modelPath, scale: pr.scale });
    return pr;
  }

  private spawnBoomerang(p: Warlock, nx: number, ny: number, lvl: number, distance: number) {
    const side = p.id % 2 ? -1 : 1;
    const sx = -ny * side, sy = nx * side;
    const pr = this.spawnProjectile(p, 'boomerang', nx, ny, 45, 40, distance, distance / 1500 + 0.03, lvl, true, false, true);
    pr.vx = nx * 45 + sx * 9; pr.vy = ny * 45 + sy * 9;
    pr.ax = nx * (-(45 * 45) / (2 * distance)); pr.ay = ny * (-(45 * 45) / (2 * distance));
  }

  private spawnMeteor(p: Warlock, x: number, y: number, lvl: number) {
    const m: Meteor = { id: this.nextId++, owner: p.id, x: p.x, y: p.y, px: p.x, py: p.y, vx: (x - p.x) / 1.35 * DT, vy: (y - p.y) / 1.35 * DT, timer: 1.35, delay: 1.35, level: lvl, modelPath: SPELLS.meteor.modelPath!, scale: 0.8 + 0.1 * p.AA + 0.1 * lvl };
    this.meteors.push(m);
    this.events.push({ t: 'meteorFall', id: m.id, x, y, delay: m.delay, modelPath: m.modelPath, scale: m.scale });
  }

  private castScourge(p: Warlock) {
    const base = [10, 12, 13][Math.min(2, p.OA)] ?? 10;
    let hits = 0;
    this.events.push({ t: 'effect', name: 'scourge', x: p.x, y: p.y, modelPath: MODEL_PATHS.darkPortal });
    this.events.push({ t: 'effect', name: 'scourgeNova', x: p.x, y: p.y, modelPath: MODEL_PATHS.novaYellow });
    for (const o of this.players) if (this.isEnemy(p, o) && o.alive) {
      const d = dhypot(o.x - p.x, o.y - p.y);
      if (d <= 250) { hits++; this.damageTL(p.id, o, base, 1 - d / 1000); }
    }
    if (hits >= 3) this.events.push({ t: 'announcement', text: 'Hattrick!', soundPath: SOUND_PATHS.hattrick });
    p.hp = Math.max(0.5, p.hp - base);
  }

  private castLightning(p: Warlock, nx: number, ny: number, lvl: number) {
    const range = (1 + 0.15 * p.IA) * 600;
    const sx = p.x, sy = p.y;
    let best = range, hitW: Warlock | null = null, hitP: Projectile | null = null;
    const ray = (x: number, y: number, r: number) => {
      const ox = x - sx, oy = y - sy, along = ox * nx + oy * ny;
      if (along < 0) return Infinity;
      const perp = Math.abs(ox * ny - oy * nx);
      return perp <= 50 + r ? along - r : Infinity;
    };
    for (const o of this.players) if (this.isEnemy(p, o) && o.alive) { const t = ray(o.x, o.y, WARLOCK_RADIUS); if (t < best) { best = t; hitW = o; hitP = null; } }
    for (const pr of this.projectiles) if (!pr.dead && pr.owner !== p.id) { const t = ray(pr.x, pr.y, pr.radius); if (t < best) { best = t; hitP = pr; hitW = null; } }
    const ex = sx + nx * best, ey = sy + ny * best;
    this.events.push({ t: 'lightning', pid: p.id, x1: sx, y1: sy, x2: ex, y2: ey, hit: !!(hitW || hitP), code: 'CLSB' });
    if (hitW) this.damageTL(p.id, hitW, 7 + lvl, 1);
    if (hitP) { hitP.dead = true; this.events.push({ t: 'explode', kind: hitP.kind, x: hitP.x, y: hitP.y, modelPath: MODEL_PATHS.thunderclapNoSplat }); }
    for (const pr of this.projectiles) if (pr.owner === p.id && pr.kind === 'fireball' && dhypot(pr.x - ex, pr.y - ey) < 230) {
      pr.dead = true;
      this.areaDamage(p.id, pr.x, pr.y, 230, 7 + lvl + 6.3 + 0.7 * (pr.level), 1, 0.5);
      this.events.push({ t: 'effect', name: 'lightningFireballCombo', x: pr.x, y: pr.y, modelPath: MODEL_PATHS.lightningCombo });
      break;
    }
  }

  private castFireSpray(p: Warlock, nx: number, ny: number, lvl: number) {
    const base = datan2(ny, nx);
    const angles = p.fireSprayFan ? [-11, -5.5, 0, 5.5, 11] : Array.from({ length: 5 + lvl }, () => this.rng.range(-12, 12));
    for (const deg of angles) {
      const a = base + deg * Math.PI / 180;
      const speed = (p.fireSprayFan ? 800 : 1200) * DT;
      const pr = this.spawnProjectile(p, 'firesprayBolt', dcos(a), dsin(a), speed, p.fireSprayFan ? 23 : 22, (p.fireSprayFan ? 800 : 1000) * (1 + 0.1 * p.IA), (p.fireSprayFan ? 800 * (1 + 0.1 * p.IA) / 900 : 1000 * (1 + 0.1 * p.IA) / 1200), lvl);
      pr.scale = p.fireSprayFan ? 0.8 : 0.73;
      // RW/BW pick the missile art per bolt: RedDragonMissile or the map's white fb2.
      if (this.rng.int(2) === 1) pr.modelPath = 'fb2.mdl';
    }
  }

  private teleport(p: Warlock, nx: number, ny: number, dist: number) {
    const fx = p.x, fy = p.y;
    const wasLava = p.inLava;
    p.x = p.px = fx + nx * dist; p.y = p.py = fy + ny * dist;
    p.vx *= 0.3; p.vy *= 0.3;
    this.events.push({ t: 'teleport', pid: p.id, fx, fy, tx: p.x, ty: p.y, modelPath: 'Abilities\\Spells\\Undead\\DeathCoil\\DeathCoilSpecialArt.mdl' });
    if (wasLava && this.isSafePoint(p.x, p.y) && p.hp <= 6 * p.NR + 0.5) this.events.push({ t: 'announcement', text: 'Last Second Save!', soundPath: SOUND_PATHS.lastSecondSave });
  }

  private timeShift(p: Warlock) {
    if (p.timeshift) return this.error(p, 'Previous cast detected, aborting TimeShift');
    const snap: TimeShiftSnapshot = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, hp: p.hp, damagePoints: p.damagePoints, facing: p.facing, order: p.order, thrust: p.thrust ? { ...p.thrust } : null, frozen: p.frozen ? { ...p.frozen } : null };
    p.timeshift = { time: 3.6, snap };
    this.events.push({ t: 'effect', name: 'timeshiftDummy', x: p.x, y: p.y, modelPath: 'BloodelfWizard.mdl', scale: 0.92 });
  }
  private restoreTimeShift(p: Warlock) {
    const s = p.timeshift?.snap; if (!s) return;
    p.x = p.px = s.x; p.y = p.py = s.y; p.vx = s.vx; p.vy = s.vy; p.hp = s.hp; p.damagePoints = s.damagePoints + (0.8 - (p.spells.timeshift ?? 1) / 10) * (p.damagePoints - s.damagePoints); p.facing = s.facing; p.order = s.order; p.thrust = s.thrust; p.frozen = s.frozen; p.timeshift = null; p.link = null;
    for (const o of this.players) if (o.link?.target === p.id) o.link = null;
    this.events.push({ t: 'effect', name: 'timeshiftRestore', x: p.x, y: p.y, modelPath: 'Abilities\\Spells\\Human\\MassTeleport\\MassTeleportTarget.mdl' });
  }

  private updateProjectiles() {
    for (const pr of this.projectiles) {
      if (pr.dead) continue;
      pr.age += DT;
      pr.life -= DT;
      if (pr.kind === 'homing') this.updateHoming(pr);
      if (pr.kind === 'boomerang') this.updateBoomerang(pr);
      if (pr.kind === 'gravity') this.updateGravity(pr);
      if (pr.kind === 'link') this.updateLinkProjectile(pr);
      if (pr.kind === 'splitter' && this.players[pr.owner]?.splitterContinuous && this.tick % 5 === 0) this.splitterBurst(pr, false);
      pr.vx += pr.ax; pr.vy += pr.ay;
      pr.x += pr.vx; pr.y += pr.vy;
      pr.traveled += dhypot(pr.vx, pr.vy);
      this.clampBounds(pr);
      if (pr.traveled >= pr.maxDist || pr.life <= 0) this.expireProjectile(pr);
      if (!pr.dead) this.projectileCollisions(pr);
    }
    this.projectileProjectileCollisions();
    this.projectiles = this.projectiles.filter((p) => !p.dead);
  }

  private updateHoming(pr: Projectile) {
    let target = pr.targetId >= 0 ? this.players[pr.targetId] : null;
    if (!target || !target.alive || !this.isEnemy(pr.owner, target)) {
      let bd = 700;
      for (const o of this.players) if (this.isEnemy(pr.owner, o) && o.alive && o.windwalk <= 0) { const d = dhypot(o.x - pr.x, o.y - pr.y); if (d < bd) { bd = d; target = o; } }
      pr.targetId = target?.id ?? -1;
    }
    if (target) {
      const [nx, ny] = norm(target.x - pr.x, target.y - pr.y);
      pr.vx = pr.vx * 0.97 + nx * 21 * 0.03;
      pr.vy = pr.vy * 0.97 + ny * 21 * 0.03;
    }
  }
  private updateBoomerang(pr: Projectile) {
    if (!pr.returning && (pr.vx * pr.vx + pr.vy * pr.vy < 9 || pr.age > 0.8)) { pr.returning = true; pr.ax = pr.ay = 0; pr.hitIds = []; }
    if (pr.returning) {
      const owner = this.players[pr.owner]; if (!owner || !owner.alive) return;
      const [nx, ny, d] = norm(owner.x - pr.x, owner.y - pr.y);
      pr.vx += nx * 0.9; pr.vy += ny * 0.9;
      if (d < 75) pr.dead = true;
    }
  }
  private updateGravity(pr: Projectile) {
    for (const o of this.players) if (this.isEnemy(pr.owner, o) && o.alive) {
      const dx = pr.x - o.x, dy = pr.y - o.y, d2 = dx * dx + dy * dy;
      if (d2 < 360000 && d2 > 1) { const f = (0.7 + 0.1 * pr.level) * (1 - d2 / 360000); const d = Math.sqrt(d2); o.vx += dx / d * f; o.vy += dy / d * f; }
      if (this.tick % 5 === 0 && d2 < 90000) this.damageUL(pr.owner, o, 0.2 + 0.2 * pr.level);
    }
    for (const other of this.projectiles) if (other !== pr && !other.dead) {
      const dx = pr.x - other.x, dy = pr.y - other.y, d2 = dx * dx + dy * dy;
      if (d2 < 390625 && d2 > 1) { const d = Math.sqrt(d2); const f = 2 * (1 - d2 / 390625); other.vx += dx / d * f; other.vy += dy / d * f; }
    }
  }
  private updateLinkProjectile(pr: Projectile) {
    const owner = this.players[pr.owner]; if (!owner) return;
    this.events.push({ t: 'lightning', pid: owner.id, x1: owner.x, y1: owner.y, x2: pr.x, y2: pr.y, hit: false, code: 'DRAM' });
    if (!pr.returning && pr.traveled >= pr.maxDist) { pr.returning = true; pr.vx = pr.vy = 0; }
    if (pr.returning) { const [nx, ny, d] = norm(owner.x - pr.x, owner.y - pr.y); pr.vx = nx * 20; pr.vy = ny * 20; if (d < 100) pr.dead = true; }
  }

  private projectileCollisions(pr: Projectile) {
    if (pr.collidesObstacle) for (const o of this.obstacles) if (dhypot(o.x - pr.x, o.y - pr.y) < o.radius + pr.radius) { this.resolveObstacle(o, pr, pr.radius, 1); if (pr.kind !== 'boomerang') this.expireProjectile(pr); return; }
    if (!pr.collidesWarlock) return;
    for (const o of this.players) {
      if (!o.alive || o.id === pr.owner || pr.hitIds.includes(o.id) || !this.isEnemy(pr.owner, o)) continue;
      if (!this.sweptHit(pr.px, pr.py, pr.x, pr.y, o.x, o.y, pr.radius + WARLOCK_RADIUS)) continue;
      if (o.shield > 0 && pr.kind !== 'gravity') { this.reflect(pr, o); continue; }
      this.projectileHit(pr, o); if (pr.dead) return;
    }
  }
  private sweptHit(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, r: number) {
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? clamp(((cx - x0) * dx + (cy - y0) * dy) / len2, 0, 1) : 0;
    const px = x0 + dx * t, py = y0 + dy * t;
    return dhypot(px - cx, py - cy) <= r;
  }
  private projectileProjectileCollisions() {
    for (let i = 0; i < this.projectiles.length; i++) { const a = this.projectiles[i]; if (a.dead || !a.collidesProjectile) continue;
      for (let j = i + 1; j < this.projectiles.length; j++) { const b = this.projectiles[j]; if (b.dead || !b.collidesProjectile || a.owner === b.owner) continue;
        if (dhypot(a.x - b.x, a.y - b.y) < a.radius + b.radius) { a.dead = b.dead = true; this.events.push({ t: 'explode', kind: 'clash', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, modelPath: MODEL_PATHS.thunderclapNoSplat }); break; }
      }
    }
  }
  private reflect(pr: Projectile, shieldOwner: Warlock) {
    const [nx, ny] = norm(pr.x - shieldOwner.x, pr.y - shieldOwner.y);
    const dot = pr.vx * nx + pr.vy * ny;
    pr.vx -= 2 * dot * nx; pr.vy -= 2 * dot * ny;
    if (pr.kind !== 'boomerang') pr.owner = shieldOwner.id;
    pr.returning = false; pr.targetId = -1; pr.hitIds = []; pr.traveled = 0;
    this.events.push({ t: 'reflect', pid: shieldOwner.id, x: pr.x, y: pr.y, modelPath: MODEL_PATHS.shieldReflect, soundPath: SOUND_PATHS.shield });
  }

  private projectileHit(pr: Projectile, o: Warlock) {
    const owner = this.players[pr.owner]; if (!owner) return;
    switch (pr.kind) {
      case 'fireball': owner.stats.fireballHits++; this.damageTL(pr.owner, o, 7 + 0.7 * (pr.level - 1), 1, pr); this.areaDamage(pr.owner, pr.x, pr.y, 160 * (1 + 0.12 * owner.AA), 6.3 + 0.7 * pr.level, 1, 0.15 * owner.AA, o.id); this.expireProjectile(pr); break;
      case 'homing': this.damageTL(pr.owner, o, 7 + pr.level, 0.9, pr); this.expireProjectile(pr); break;
      case 'boomerang': this.damageTL(pr.owner, o, 6.4 + 0.8 * pr.level, 1, pr); pr.hitIds.push(o.id); this.events.push({ t: 'explode', kind: pr.kind, x: pr.x, y: pr.y, modelPath: 'Abilities\\Weapons\\BallistaMissile\\BallistaImpact.mdl' }); break;
      case 'splitter': this.damageTL(pr.owner, o, 7 + pr.level, 0.8, pr); this.splitterBurst(pr, true); pr.dead = true; break;
      case 'splitterShard': this.damageTL(pr.owner, o, 3.5 + 0.5 * pr.level, 0.8, pr); this.expireProjectile(pr); break;
      case 'displacement': this.swap(owner, o); pr.dead = true; break;
      case 'drain': this.drainHit(pr, o); break;
      case 'firesprayBolt': this.damageDL(pr.owner, o, owner.fireSprayFan ? 3 + 0.4 * pr.level : 2.4 + 0.2 * pr.level, owner.fireSprayFan ? 0.7 : 0.6, pr); this.expireProjectile(pr); break;
      case 'bouncer': this.damageTL(pr.owner, o, pr.damageScale * (6 + pr.level), 1, pr); pr.damageScale = Math.max(0.2, pr.damageScale * 0.8); pr.hitIds = [o.id]; this.retargetBouncer(pr); break;
      case 'freeze': this.freeze(o, pr.owner, pr.level); this.expireProjectile(pr); break;
      case 'link': owner.link = { target: o.id, time: 99, level: pr.level }; this.events.push({ t: 'linkHit', pid: owner.id, target: o.id, code: 'DRAM' }); pr.dead = true; break;
      default: break;
    }
  }

  private expireProjectile(pr: Projectile) {
    if (pr.dead) return;
    if (pr.kind === 'splitter') this.splitterBurst(pr, true);
    if (pr.kind === 'displacement') { const owner = this.players[pr.owner]; if (owner?.alive) this.teleport(owner, ...(norm(pr.x - owner.x, pr.y - owner.y).slice(0, 2) as [number, number]), dhypot(pr.x - owner.x, pr.y - owner.y)); }
    pr.dead = true;
    const modelPath = pr.kind === 'fireball' ? MODEL_PATHS.fireballImpact : pr.kind === 'homing' ? 'Abilities\\Spells\\Human\\StormBolt\\StormBoltMissile.mdl' : pr.kind === 'freeze' ? 'Abilities\\Weapons\\FrostWyrmMissile\\FrostWyrmMissile.mdl' : pr.modelPath;
    this.events.push({ t: 'explode', kind: pr.kind, x: pr.x, y: pr.y, modelPath });
  }

  private splitterBurst(pr: Projectile, death: boolean) {
    const owner = this.players[pr.owner]; if (!owner) return;
    if (death) this.areaDamage(pr.owner, pr.x, pr.y, 160 * (1 + 0.12 * owner.AA), 7 + pr.level, 0.8, 0.15 * owner.AA);
    for (const deg of [-18, -12, -6, 0, 6, 12, 18]) {
      const a = pr.splitAngle + deg * Math.PI / 180;
      this.spawnProjectile(owner, 'splitterShard', dcos(a), dsin(a), 750 * DT, 20, 750, 1, pr.level, true, false, true);
    }
    this.events.push({ t: 'effect', name: 'splitterBurst', x: pr.x, y: pr.y, modelPath: MODEL_PATHS.blueWarStomp });
  }

  private retargetBouncer(pr: Projectile) {
    let best: Warlock | null = null, bd = Infinity;
    for (const o of this.players) if (this.isEnemy(pr.owner, o) && o.alive && !pr.hitIds.includes(o.id)) { const d = dhypot(o.x - pr.x, o.y - pr.y); if (d < bd) { bd = d; best = o; } }
    if (!best || pr.damageScale <= 0.2) { this.expireProjectile(pr); return; }
    const [nx, ny] = norm(best.x - pr.x, best.y - pr.y); pr.vx = nx * 900 * DT; pr.vy = ny * 900 * DT; pr.life = (750 + 150 * pr.level + 0.1 * (this.players[pr.owner]?.IA ?? 0)) / 900;
  }

  private drainHit(pr: Projectile, o: Warlock) {
    const owner = this.players[pr.owner]; if (!owner) return;
    const amt = 5 + pr.level;
    if (!this.isEnemy(owner, o)) { this.heal(o, pr.owner, amt); o.moveSpeed += 100; }
    else { this.damageTL(pr.owner, o, amt, 0.2, pr); o.moveSpeed = Math.max(0, o.moveSpeed - 100); const ret = this.spawnProjectile(o, 'drainReturn', 1, 0, 20, 15, Infinity, 5, pr.level, false, false, false); ret.owner = pr.owner; ret.targetId = owner.id; }
    this.expireProjectile(pr);
  }

  private swap(a: Warlock, b: Warlock) {
    const ax = a.x, ay = a.y, bx = b.x, by = b.y;
    a.x = a.px = bx; a.y = a.py = by; b.x = b.px = ax; b.y = b.py = ay; a.order = b.order = { type: 'idle' };
    this.events.push({ t: 'swap', a: a.id, b: b.id, ax: a.x, ay: a.y, bx: b.x, by: b.y, modelPath: 'Abilities\\Spells\\Items\\AIil\\AIilTarget.mdl' });
  }

  private updateMeteors() {
    for (const m of this.meteors) {
      m.px = m.x; m.py = m.y; m.timer -= DT; m.x += m.vx; m.y += m.vy;
      if (m.timer > 0) continue;
      const r = 200 + 20 * (this.players[m.owner]?.AA ?? 0);
      this.events.push({ t: 'meteorImpact', x: m.x, y: m.y, radius: r, modelPath: m.modelPath });
      for (const o of this.players) if (o.alive && this.isEnemy(m.owner, o)) { const d = dhypot(o.x - m.x, o.y - m.y); if (d <= r + WARLOCK_RADIUS) this.damageTL(m.owner, o, (10 + 2 * m.level) * (1 - Math.min(1, d / r) / 2), 0.8); }
      m.timer = -999;
    }
    this.meteors = this.meteors.filter((m) => m.timer > -900);
  }

  private freeze(o: Warlock, src: number, lvl: number) {
    if (o.spawnProtection > 0) return;
    o.thrust = null; o.frozen = { time: 2 + 0.5 * lvl } satisfies FreezeState; o.CC *= 0.8; o.DC *= 0.5; o.NR *= 0.25; o.lastHitBy = src; o.lastHitTime = this.time;
    this.events.push({ t: 'effect', name: 'freeze', x: o.x, y: o.y, modelPath: 'Abilities\\Spells\\Undead\\FrostNova\\FrostNovaTarget.mdl' });
  }
  private unfreeze(o: Warlock) { o.frozen = null; o.CC *= 1.25; o.DC *= 2; o.NR *= 4; this.events.push({ t: 'effect', name: 'unfreeze', x: o.x, y: o.y, modelPath: 'Abilities\\Spells\\Undead\\FreezingBreath\\FreezingBreathMissile.mdl' }); }

  private damageTL(src: number, target: Warlock, dmg: number, kf: number, sourceEntity?: { x: number; y: number }) { const s = sourceEntity ?? this.players[src]; const [nx, ny] = norm(target.x - s.x, target.y - s.y); this.applyDamage(src, target, dmg, nx, ny, kf, true); }
  private damageDL(src: number, target: Warlock, dmg: number, kf: number, pr: Projectile) { const [nx, ny] = norm(pr.vx, pr.vy); this.applyDamage(src, target, dmg, nx, ny, kf, true); }
  private damageUL(src: number, target: Warlock, dmg: number) { this.applyDamage(src, target, dmg, 0, 0, 0, false); }
  private applyDamage(src: number, target: Warlock, raw: number, nx: number, ny: number, kf: number, knock: boolean) {
    if (!target.alive) return;
    const attacker = this.players[src];
    const eff = raw * (attacker?.BC ?? 1) * target.CC;
    const prot = target.spawnProtection > 0;
    this.damageText(target, src, eff, prot ? 'cyan' : 'yellow');
    this.events.push({ t: 'hit', pid: target.id, src, dmg: eff, x: target.x, y: target.y, protected: prot });
    if (prot) return;
    if (target.rush && knock) this.addRushSpeed(target, eff);
    else if (knock && kf !== 0) { const kb = (100 + target.damagePoints) * eff * DT * target.DC * kf; target.vx += nx * kb; target.vy += ny * kb; }
    target.hp -= eff; target.damagePoints += eff; target.lastHitBy = src; target.lastHitTime = this.time;
    if (attacker && attacker.id !== target.id) { attacker.stats.damage += eff; attacker.stats.roundDamage += eff; target.contributions[attacker.id] += eff; if (attacker.RA > 0) this.heal(attacker, src, eff * 0.08 * attacker.RA, true); }
  }
  private heal(target: Warlock, src: number, amt: number, lifesteal = false) { target.hp = Math.min(target.maxHp, target.hp + amt); target.damagePoints = Math.max(0, target.damagePoints - amt / 2); this.events.push({ t: 'damageText', pid: target.id, src, text: `+${amt.toFixed(1)}`, color: 'green', size: lifesteal ? 0.02 : textSize(amt), x: target.x, y: target.y, amount: amt }); }
  private damageText(target: Warlock, src: number, amount: number, color: 'yellow' | 'cyan' | 'green' | 'red') { this.events.push({ t: 'damageText', pid: target.id, src, text: amount.toFixed(amount >= 10 ? 0 : 1), color, size: textSize(amount), x: target.x, y: target.y, amount }); }
  private areaDamage(src: number, x: number, y: number, radius: number, dmg: number, kf: number, minFrac: number, skip = -1) { for (const o of this.players) if (o.id !== skip && this.isEnemy(src, o) && o.alive) { const d = dhypot(o.x - x, o.y - y); if (d <= radius) this.damageTL(src, o, dmg * Math.max(minFrac, 1 - d / radius), kf, { x, y }); } }
  private addRushSpeed(p: Warlock, dmg: number) { if (!p.rush) return; const add = (7 + 1.5 * p.rush.level) * dmg; p.rush.speedBonus += p.rush.speedBonus < 250 ? add : add / 8; }

  private kill(p: Warlock) {
    p.alive = false; p.hp = 0; p.deathTime = this.time; p.stats.deaths++; p.order = { type: 'idle' }; p.cast = null; p.thrust = null; p.link = null; for (const o of this.players) if (o.link?.target === p.id) o.link = null;
    const killer = p.lastHitBy >= 0 && p.lastHitBy !== p.id ? p.lastHitBy : -1;
    let assist = -1, assistDamage = 0;
    p.contributions.forEach((d, i) => { if (i !== killer && i !== p.id && d > assistDamage) { assistDamage = d; assist = i; } });
    if (killer >= 0) this.awardKill(killer, p, assist);
    this.events.push({ t: 'death', pid: p.id, killer, assist, x: p.x, y: p.y, inLava: p.inLava, modelPath: MODEL_PATHS.doomDeath });
    if (this.rules.mode === 'deathmatch') { p.respawn = RESPAWN_TIME; p.stats.points -= 1; }
  }
  private awardKill(killerId: number, victim: Warlock, assist: number) {
    const k = this.players[killerId]; k.stats.kills++; k.stats.points += POINT_PER_KILL; k.gold += GOLD_PER_KILL; this.events.push({ t: 'bounty', pid: k.id, gold: GOLD_PER_KILL, x: victim.x, y: victim.y });
    // One announcer line per kill, in the original's priority: first blood, multikill, then spree.
    const labels: string[] = [];
    let sound: string | undefined;
    if (!this.firstBlood) { this.firstBlood = true; labels.push('First Blood'); sound = SOUND_PATHS.firstBlood; }
    if (this.time - k.lastKillTime <= 9) {
      k.multikillCount++;
      const i = Math.min(6, k.multikillCount);
      labels.push(MULTIKILL_LABELS[i]);
      sound = MULTIKILL_SOUNDS[i];
    } else k.multikillCount = 1;
    k.lastKillTime = this.time;
    k.spree = Math.min(10, k.spree + 1);
    if (k.spree >= 3) { labels.push(`${SPREE[k.spree][0]} (${k.spree})`); sound ??= SPREE[k.spree][1]; }
    if (victim.spree >= 3) labels.push(`${victim.name}'s ${SPREE[victim.spree][0]} ended`);
    if (labels.length) this.events.push({ t: 'announcement', text: labels.join(' - '), soundPath: sound });
    if (assist >= 0) { const a = this.players[assist]; a.stats.assists++; a.stats.points += POINT_PER_ASSIST; a.gold += GOLD_PER_ASSIST; }
  }

  private respawn(p: Warlock) {
    this.resetFighter(p, false);
    for (let tries = 0; tries < 200; tries++) { const x = this.rng.range(-this.arenaRadius * 0.5, this.arenaRadius * 0.5), y = this.rng.range(-this.arenaRadius * 0.5, this.arenaRadius * 0.5); if (this.isSafePoint(x, y)) { p.x = p.px = x; p.y = p.py = y; break; } }
    this.events.push({ t: 'effect', name: 'respawn', x: p.x, y: p.y, modelPath: 'Abilities\\Spells\\Human\\ReviveHuman\\ReviveHuman.mdl' });
  }

  // Mirrors the map's EVENT_PLAYER_LEAVE handler: the warlock is removed
  // outright (no death, no bounty) and the player is greyed out.
  private leave(p: Warlock) {
    p.left = true;
    p.alive = false;
    p.ready = true;
    p.respawn = 0;
    p.order = { type: 'idle' }; p.cast = null; p.thrust = null; p.link = null; p.frozen = null; p.timeshift = null; p.rush = null;
    for (const o of this.players) if (o.link?.target === p.id) o.link = null;
    this.events.push({ t: 'left', pid: p.id });
  }

  private livingTeamsOrPlayers() { return new Set(this.players.filter((p) => p.alive).map((p) => this.rules.teams === '2teams' ? p.team : p.id)).size; }
  private checkWinCondition() {
    const alive = this.players.filter((p) => p.alive);
    const living = this.livingTeamsOrPlayers();
    if (this.rules.mode === 'deathmatch') {
      const leader = this.players.find((p) => p.stats.points >= this.rules.pointLimit);
      if (leader) this.setPhase('gameOver', 0);
      return;
    }
    if (living > 1) return;
    let winner = -1;
    if (alive.length) {
      const winTeam = alive[0].team;
      const winners = this.players.filter((p) => p.team === winTeam);
      for (const w of winners) { w.stats.points += POINT_PER_WIN; w.gold += GOLD_PER_WIN; w.stats.wins++; winner = w.id; }
      this.roundWinner = winner;
    }
    const maxD = Math.max(...this.players.map((p) => p.stats.roundDamage));
    for (const p of this.players) if (maxD > 0 && Math.abs(p.stats.roundDamage - maxD) < 1e-6) p.gold += GOLD_MOST_DAMAGE;
    this.events.push({ t: 'roundWinner', pid: winner });
    this.setPhase('roundEnd', ROUND_END_TIME);
  }

  ranking(): Warlock[] { return [...this.players].sort((a, b) => b.stats.points - a.stats.points || b.stats.kills - a.stats.kills || b.stats.damage - a.stats.damage); }

  stateHash(): string {
    const data = {
      tick: this.tick, phase: this.phase, round: this.round, mb: this.arenaMB, tv: this.terrainVersion,
      p: this.players.map((p) => [p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.vx.toFixed(3), +p.vy.toFixed(3), +p.hp.toFixed(3), +p.damagePoints.toFixed(3), p.alive, p.left, p.gold, p.stats.points, p.stats.kills, p.stats.deaths, Object.entries(p.spells).sort()]),
      pr: this.projectiles.map((p) => [p.id, p.kind, p.owner, +p.x.toFixed(2), +p.y.toFixed(2), +p.vx.toFixed(3), +p.vy.toFixed(3), +p.life.toFixed(2)]),
    };
    return JSON.stringify(data);
  }
}
