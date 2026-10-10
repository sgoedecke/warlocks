// All gameplay numbers are in Warcraft III world units (a footman is ~32 units across)
// and seconds, so tuning can be compared against the original map.

export const TICK_RATE = 30;
export const DT = 1 / TICK_RATE;

export const ARENA_START_RADIUS = 820;
export const ARENA_MIN_RADIUS = 170;
export const ARENA_SHRINK_DELAY = 12; // seconds before lava starts creeping in
export const ARENA_SHRINK_RATE = 5.5; // units / second

export const WARLOCK_RADIUS = 28;
export const WARLOCK_HP = 100;
export const WARLOCK_SPEED = 270;
export const WARLOCK_TURN_RATE = 11; // rad / s
export const CAST_FACING_TOLERANCE = 0.35; // rad
export const LAVA_DPS = 13;
export const KNOCKBACK_FRICTION = 1.7; // exponential decay constant of knockback velocity
// Knockback grows as a warlock gets hurt: kb * (1 + KB_HP_SCALING * fractionMissingHp)
export const KB_HP_SCALING = 0.8;
export const KILL_CREDIT_WINDOW = 9; // seconds a hit counts towards a lava kill

export const START_GOLD = 20;
export const GOLD_PER_ROUND = 8;
export const GOLD_PER_KILL = 6;
export const GOLD_PER_WIN = 10;

export const SHOP_TIME = 25;
export const COUNTDOWN_TIME = 3;
export const ROUND_END_TIME = 3.5;

export const PLAYER_COLORS: { name: string; hex: string; css: string }[] = [
  { name: 'Red', hex: '#ff0303', css: '#ff0303' },
  { name: 'Blue', hex: '#0042ff', css: '#0042ff' },
  { name: 'Teal', hex: '#1ce6b9', css: '#1ce6b9' },
  { name: 'Purple', hex: '#540081', css: '#9b3bd1' },
  { name: 'Yellow', hex: '#fffc01', css: '#fffc01' },
  { name: 'Orange', hex: '#fe8a0e', css: '#fe8a0e' },
  { name: 'Green', hex: '#20c000', css: '#20c000' },
  { name: 'Pink', hex: '#e55bb0', css: '#e55bb0' },
];

export const BOT_NAMES = [
  'Gul\'dan', 'Ner\'zhul', 'Kel\'Thuzad', 'Medivh', 'Drak\'thul', 'Teron', 'Cho\'gall', 'Zuluhed',
  'Dentarg', 'Rend', 'Maim', 'Mannoroth', 'Kil\'jaeden', 'Archimonde', 'Tichondrius', 'Mal\'Ganis',
];

export type SpellId =
  | 'fireball'
  | 'lightning'
  | 'homing'
  | 'boomerang'
  | 'meteor'
  | 'gravity'
  | 'link'
  | 'swap'
  | 'teleport'
  | 'thrust'
  | 'shield'
  | 'windwalk';

export type Targeting = 'point' | 'none';

export interface SpellDef {
  id: SpellId;
  name: string;
  hotkey: string;
  col: number;
  row: number;
  cost: number; // gold to learn
  upgradeCost: number; // gold per additional level
  maxLevel: number;
  targeting: Targeting;
  // If set, caster walks into this range before casting (WC3 behaviour for ground-targeted spells).
  range?: (lvl: number) => number;
  castTime: number;
  cooldown: (lvl: number) => number;
  describe: (lvl: number) => string;
}

const lv = (base: number, perLevel: number) => (l: number) => base + perLevel * (l - 1);

export const SPELL_STATS = {
  fireball: { speed: 880, radius: 16, range: 1100, damage: lv(8, 1.5), kb: lv(560, 45) },
  lightning: { range: lv(650, 50), damage: lv(6, 1.5), kb: lv(380, 40) },
  homing: { speed: 430, turn: 2.6, life: 5.5, radius: 18, damage: lv(9, 2), kb: lv(470, 40), seek: 900 },
  boomerang: { speed: 820, out: 680, radius: 18, damage: lv(6, 1.5), kb: lv(420, 40) },
  meteor: { delay: 1.15, radius: lv(150, 12), damage: lv(13, 3), kb: lv(720, 50) },
  gravity: { speed: 290, life: 4.2, radius: 24, pull: lv(380, 40), pullRadius: lv(330, 25), dps: lv(3, 1) },
  link: { speed: 1150, range: 820, radius: 14, duration: lv(2.6, 0.3), pull: 1150, damage: lv(4, 1) },
  swap: { speed: 1050, range: 900, radius: 16 },
  teleport: { range: lv(560, 70) },
  thrust: { speed: 1350, distance: lv(460, 40), damage: lv(8, 2), kb: lv(680, 50) },
  shield: { duration: lv(2.2, 0.35) },
  windwalk: { duration: lv(3, 0.6), speed: lv(1.4, 0.07) },
};

const S = SPELL_STATS;

export const SPELLS: Record<SpellId, SpellDef> = {
  fireball: {
    id: 'fireball', name: 'Fireball', hotkey: 'F', col: 0, row: 0, cost: 0, upgradeCost: 8, maxLevel: 5,
    targeting: 'point', castTime: 0.12, cooldown: lv(1.9, -0.1),
    describe: (l) => `Hurls a ball of fire that explodes on the first warlock it touches, dealing ${S.fireball.damage(l).toFixed(1)} damage and knocking the target back.`,
  },
  lightning: {
    id: 'lightning', name: 'Lightning', hotkey: 'L', col: 1, row: 0, cost: 12, upgradeCost: 8, maxLevel: 5,
    targeting: 'point', castTime: 0.1, cooldown: lv(5.5, -0.4),
    describe: (l) => `Instantly strikes the first warlock or missile in a line (${S.lightning.range(l)} range) for ${S.lightning.damage(l).toFixed(1)} damage.`,
  },
  homing: {
    id: 'homing', name: 'Homing Missile', hotkey: 'H', col: 2, row: 0, cost: 14, upgradeCost: 9, maxLevel: 5,
    targeting: 'point', castTime: 0.15, cooldown: lv(10, -0.7),
    describe: (l) => `Launches a slow missile that hunts the nearest enemy warlock, dealing ${S.homing.damage(l).toFixed(1)} damage.`,
  },
  boomerang: {
    id: 'boomerang', name: 'Boomerang', hotkey: 'B', col: 3, row: 0, cost: 12, upgradeCost: 8, maxLevel: 5,
    targeting: 'point', castTime: 0.12, cooldown: lv(7, -0.5),
    describe: (l) => `Throws a blade that flies out and returns, striking warlocks on the way out and back for ${S.boomerang.damage(l).toFixed(1)} damage.`,
  },
  meteor: {
    id: 'meteor', name: 'Meteor', hotkey: 'M', col: 0, row: 1, cost: 16, upgradeCost: 10, maxLevel: 5,
    targeting: 'point', range: () => 900, castTime: 0.25, cooldown: lv(14, -1),
    describe: (l) => `Calls down a meteor which lands after ${S.meteor.delay}s, dealing ${S.meteor.damage(l).toFixed(0)} damage and violently knocking back all warlocks in the area.`,
  },
  gravity: {
    id: 'gravity', name: 'Gravity', hotkey: 'G', col: 1, row: 1, cost: 16, upgradeCost: 10, maxLevel: 5,
    targeting: 'point', castTime: 0.2, cooldown: lv(15, -1),
    describe: (l) => `Releases a slow sphere of gravity that pulls nearby warlocks towards it and burns them for ${S.gravity.dps(l)} damage per second.`,
  },
  link: {
    id: 'link', name: 'Link', hotkey: 'K', col: 2, row: 1, cost: 12, upgradeCost: 8, maxLevel: 5,
    targeting: 'point', castTime: 0.1, cooldown: lv(13, -0.8),
    describe: (l) => `Fires a chain. If it hooks a warlock you are dragged towards each other for ${S.link.duration(l).toFixed(1)}s while life is drained from them.`,
  },
  swap: {
    id: 'swap', name: 'Swap', hotkey: 'W', col: 3, row: 1, cost: 12, upgradeCost: 8, maxLevel: 5,
    targeting: 'point', castTime: 0.12, cooldown: lv(13, -1.2),
    describe: () => `Fires a bolt that swaps your position with the first warlock it hits.`,
  },
  teleport: {
    id: 'teleport', name: 'Teleport', hotkey: 'T', col: 0, row: 2, cost: 12, upgradeCost: 8, maxLevel: 5,
    targeting: 'point', range: (l) => S.teleport.range(l), castTime: 0.2, cooldown: lv(13, -1),
    describe: (l) => `Teleports you to a target location up to ${S.teleport.range(l)} range away.`,
  },
  thrust: {
    id: 'thrust', name: 'Thrust', hotkey: 'R', col: 1, row: 2, cost: 12, upgradeCost: 8, maxLevel: 5,
    targeting: 'point', castTime: 0.05, cooldown: lv(10, -0.8),
    describe: (l) => `Charges forward ${S.thrust.distance(l)} distance. The first warlock you slam into takes ${S.thrust.damage(l)} damage and is knocked back.`,
  },
  shield: {
    id: 'shield', name: 'Shield', hotkey: 'D', col: 2, row: 2, cost: 14, upgradeCost: 9, maxLevel: 5,
    targeting: 'none', castTime: 0, cooldown: lv(14, -1),
    describe: (l) => `Surrounds you with a magic barrier for ${S.shield.duration(l).toFixed(1)}s that reflects enemy missiles.`,
  },
  windwalk: {
    id: 'windwalk', name: 'Windwalk', hotkey: 'I', col: 3, row: 2, cost: 14, upgradeCost: 9, maxLevel: 5,
    targeting: 'none', castTime: 0, cooldown: lv(16, -1.2),
    describe: (l) => `Become invisible and move ${Math.round((S.windwalk.speed(l) - 1) * 100)}% faster for ${S.windwalk.duration(l).toFixed(1)}s. Casting a spell reveals you.`,
  },
};

export const SPELL_ORDER: SpellId[] = [
  'fireball', 'lightning', 'homing', 'boomerang',
  'meteor', 'gravity', 'link', 'swap',
  'teleport', 'thrust', 'shield', 'windwalk',
];

export function upgradePrice(id: SpellId, currentLevel: number): number {
  const d = SPELLS[id];
  if (currentLevel === 0) return d.cost;
  return d.upgradeCost + 2 * (currentLevel - 1);
}
