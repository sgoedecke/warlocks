import type { ItemId, ProductId, SpellColumn, SpellId } from '../config';

export type Phase = 'shop' | 'countdown' | 'fight' | 'roundEnd' | 'gameOver';
export type GameMode = 'round' | 'deathmatch';
export type ArenaShape = 'square' | 'circle';

export type Order =
  | { type: 'idle' }
  | { type: 'move'; x: number; y: number }
  | { type: 'cast'; spell: SpellId; x: number; y: number };

export interface CastState { spell: SpellId; x: number; y: number; timer: number }
export interface ThrustState { dx: number; dy: number; remainingTicks: number; level: number }
export interface LinkState { target: number; time: number; level: number }
export interface FreezeState { time: number }
export interface TimeShiftState { time: number; snap: TimeShiftSnapshot }
export interface TimeShiftSnapshot { x: number; y: number; vx: number; vy: number; hp: number; damagePoints: number; facing: number; order: Order; thrust: ThrustState | null; frozen: FreezeState | null }
export interface RushState { time: number; speedBonus: number; level: number }

export interface Stats {
  points: number;
  kills: number;
  deaths: number;
  assists: number;
  wins: number;
  damage: number;
  roundDamage: number;
  fireballCasts: number;
  fireballHits: number;
}

export interface Warlock {
  id: number;
  name: string;
  color: number;
  team: number;
  isBot: boolean;
  x: number; y: number; px: number; py: number;
  vx: number; vy: number; // inertial/knockback velocity per tick
  mvx: number; mvy: number; // controlled component per tick
  facing: number; pfacing: number;
  hp: number; maxHp: number; damagePoints: number;
  alive: boolean; deathTime: number; respawn: number; diedInLava: boolean;
  order: Order; cast: CastState | null;
  spells: Partial<Record<SpellId, number>>;
  chosen: Partial<Record<SpellColumn, SpellId>>;
  cooldowns: Partial<Record<SpellId, number>>;
  gold: number; ready: boolean; left: boolean;
  spawnProtection: number;
  shield: number; windwalk: number; windwalkSpeed: number; thrust: ThrustState | null; link: LinkState | null; frozen: FreezeState | null; timeshift: TimeShiftState | null; rush: RushState | null;
  inLava: boolean; terrain: string;
  lastHitBy: number; lastHitTime: number; contributions: number[];
  lastCastTime: number; lastCastSpell: SpellId | null;
  moveSpeed: number; BC: number; CC: number; DC: number; NR: number; RA: number; AA: number; IA: number; OA: number;
  inventoryLevel: number; itemSlots: ItemStack[]; soj: boolean;
  fireSprayFan: boolean; splitterContinuous: boolean;
  multikillCount: number; lastKillTime: number; spree: number;
  stats: Stats;
}

export interface ItemStack { id: ItemId; level: number }

export type ProjectileKind = SpellId | 'splitterShard' | 'drainReturn' | 'firesprayBolt';

export interface Projectile {
  id: number; kind: ProjectileKind; owner: number;
  x: number; y: number; px: number; py: number; vx: number; vy: number; ax: number; ay: number;
  radius: number; life: number; age: number; level: number;
  traveled: number; maxDist: number; returning: boolean; dead: boolean;
  hitIds: number[]; targetId: number; damageScale: number; splitAngle: number;
  modelPath: string; scale: number;
  collidesWarlock: boolean; collidesProjectile: boolean; collidesObstacle: boolean;
}

export interface Meteor { id: number; owner: number; x: number; y: number; px: number; py: number; vx: number; vy: number; timer: number; delay: number; level: number; modelPath: string; scale: number }
export interface Obstacle { id: number; x: number; y: number; radius: number; modelPath: string; variant: string; scale: number; facing: number }
export interface TerrainThemeState { id: number; safe: string; lava: string; name: string; safeColor: number; lavaColor: number }

export type GameEvent =
  | { t: 'cast'; pid: number; spell: SpellId; x: number; y: number; modelPath?: string; soundPath?: string }
  | { t: 'spawnProjectile'; id: number; kind: ProjectileKind; owner: number; x: number; y: number; modelPath: string; scale: number }
  | { t: 'effect'; name: string; x: number; y: number; modelPath: string; scale?: number; soundPath?: string }
  | { t: 'explode'; kind: ProjectileKind | 'clash'; x: number; y: number; modelPath: string; scale?: number; soundPath?: string }
  | { t: 'damageText'; pid: number; src: number; text: string; color: 'yellow' | 'cyan' | 'green' | 'red'; size: number; x: number; y: number; amount: number }
  | { t: 'hit'; pid: number; src: number; dmg: number; x: number; y: number; protected: boolean }
  | { t: 'lightning'; pid: number; x1: number; y1: number; x2: number; y2: number; hit: boolean; code: 'CLSB' | 'DRAM' }
  | { t: 'teleport'; pid: number; fx: number; fy: number; tx: number; ty: number; modelPath: string; soundPath?: string }
  | { t: 'swap'; a: number; b: number; ax: number; ay: number; bx: number; by: number; modelPath: string }
  | { t: 'meteorFall'; id: number; x: number; y: number; delay: number; modelPath: string; scale: number }
  | { t: 'meteorImpact'; x: number; y: number; radius: number; modelPath: string }
  | { t: 'death'; pid: number; killer: number; assist: number; x: number; y: number; inLava: boolean; soundPath?: string; modelPath: string }
  | { t: 'announcement'; text: string; soundPath?: string }
  | { t: 'bounty'; pid: number; gold: number; x: number; y: number }
  | { t: 'reflect'; pid: number; x: number; y: number; modelPath: string; soundPath?: string }
  | { t: 'linkHit'; pid: number; target: number; code: 'DRAM' }
  | { t: 'thrustHit'; x: number; y: number; modelPath: string }
  | { t: 'terrain'; version: number }
  | { t: 'phase'; phase: Phase }
  | { t: 'roundWinner'; pid: number }
  | { t: 'error'; pid: number; msg: string }
  | { t: 'buy'; pid: number; product: ProductId; level: number; gold: number }
  | { t: 'left'; pid: number }
  | { t: 'joined'; pid: number }
  | { t: 'gameOver' };

export type Command =
  | { pid: number; type: 'move'; x: number; y: number }
  | { pid: number; type: 'stop' }
  | { pid: number; type: 'cast'; spell: SpellId; x: number; y: number }
  | { pid: number; type: 'buy'; product: ProductId }
  | { pid: number; type: 'sell'; slot: number }
  | { pid: number; type: 'ready' }
  | { pid: number; type: 'toggle'; spell: 'firespray' | 'splitter' }
  | { pid: number; type: 'leave' }
  /** A player joining a game in progress; only the host issues it, with `pid` the next free id. */
  | { pid: number; type: 'join'; name: string; color: number };

export interface PlayerSetup { name: string; color: number; isBot: boolean; team?: number }

export interface SimRules {
  mode: GameMode; rounds: number; pointLimit: number; teams: 'ffa' | '2teams'; arenaShape: ArenaShape; startingGold: number;
}
