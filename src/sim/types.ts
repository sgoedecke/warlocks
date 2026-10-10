import type { SpellId } from '../config';

export type Phase = 'shop' | 'countdown' | 'fight' | 'roundEnd' | 'gameOver';

export type Order =
  | { type: 'idle' }
  | { type: 'move'; x: number; y: number }
  | { type: 'cast'; spell: SpellId; x: number; y: number };

export interface CastState {
  spell: SpellId;
  x: number;
  y: number;
  timer: number;
}

export interface ThrustState {
  dx: number;
  dy: number;
  remaining: number;
  level: number;
}

export interface LinkState {
  target: number;
  time: number;
  level: number;
}

export interface Stats {
  kills: number;
  deaths: number;
  wins: number;
  damage: number;
}

export interface Warlock {
  id: number;
  name: string;
  color: number;
  isBot: boolean;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number; // knockback velocity
  vy: number;
  mvx: number; // self-propelled velocity (walking / thrust)
  mvy: number;
  facing: number;
  pfacing: number;
  hp: number;
  alive: boolean;
  deathTime: number;
  diedInLava: boolean;
  order: Order;
  cast: CastState | null;
  spells: Partial<Record<SpellId, number>>;
  cooldowns: Partial<Record<SpellId, number>>;
  gold: number;
  shield: number;
  windwalk: number;
  windwalkSpeed: number;
  thrust: ThrustState | null;
  link: LinkState | null;
  lastHitBy: number;
  lastHitTime: number;
  inLava: boolean;
  lastCastTime: number;
  lastCastSpell: SpellId | null;
  ready: boolean;
  stats: Stats;
}

export type ProjectileKind = 'fireball' | 'homing' | 'boomerang' | 'gravity' | 'link' | 'swap';

export interface Projectile {
  id: number;
  kind: ProjectileKind;
  owner: number;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  radius: number;
  life: number;
  age: number;
  level: number;
  traveled: number;
  maxDist: number;
  returning: boolean;
  hitIds: number[];
  dead: boolean;
}

export interface Meteor {
  id: number;
  owner: number;
  x: number;
  y: number;
  timer: number;
  delay: number;
  level: number;
}

export type GameEvent =
  | { t: 'cast'; pid: number; spell: SpellId; x: number; y: number }
  | { t: 'explode'; kind: ProjectileKind | 'clash'; x: number; y: number }
  | { t: 'hit'; pid: number; src: number; dmg: number; x: number; y: number }
  | { t: 'lightning'; pid: number; x1: number; y1: number; x2: number; y2: number; hit: boolean }
  | { t: 'teleport'; pid: number; fx: number; fy: number; tx: number; ty: number }
  | { t: 'swap'; a: number; b: number; ax: number; ay: number; bx: number; by: number }
  | { t: 'meteorFall'; id: number; x: number; y: number; delay: number }
  | { t: 'meteorImpact'; x: number; y: number; radius: number }
  | { t: 'death'; pid: number; killer: number; x: number; y: number; inLava: boolean }
  | { t: 'bounty'; pid: number; gold: number; x: number; y: number }
  | { t: 'reflect'; pid: number; x: number; y: number }
  | { t: 'linkHit'; pid: number; target: number }
  | { t: 'thrustHit'; x: number; y: number }
  | { t: 'phase'; phase: Phase }
  | { t: 'roundWinner'; pid: number }
  | { t: 'error'; pid: number; msg: string }
  | { t: 'buy'; pid: number; spell: SpellId; level: number };

export type Command =
  | { pid: number; type: 'move'; x: number; y: number }
  | { pid: number; type: 'stop' }
  | { pid: number; type: 'cast'; spell: SpellId; x: number; y: number }
  | { pid: number; type: 'buy'; spell: SpellId }
  | { pid: number; type: 'ready' };

export interface PlayerSetup {
  name: string;
  color: number;
  isBot: boolean;
}
