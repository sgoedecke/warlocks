// Gameplay constants and object-data-derived metadata for Warlock 0.88b.
// Coordinates are Warcraft III world units. Physics velocities in the sim are per 0.03s tick.

export const DT = 0.03;
export const TICK_RATE = 1 / DT;
export const TERRAIN_MIN = -4096;
export const TERRAIN_MAX = 4096;
export const MAP_MIN = -3584;
export const MAP_MAX = 3584;
export const TILE_SIZE = 128;
export const TILE_COUNT = (TERRAIN_MAX - TERRAIN_MIN) / TILE_SIZE + 1;

export const WARLOCK_RADIUS = 30;
export const OBSTACLE_RADIUS = 35;
export const WARLOCK_HP = 100;
export const WARLOCK_BASE_SPEED = 210;
export const WARLOCK_TURN_RATE = 3; // h000 uses a fast WC3 turn; approximate radians/second.
export const CAST_POINT = 0.3; // h000 damage point / spell point from object data (udp1).
export const CAST_BACKSWING = 0.4; // ubs1; orders end immediately after effect in the browser sim.
export const SPAWN_PROTECTION = 4;

export const SHOP_TIME = 30;
export const COUNTDOWN_TIME = 3;
export const ROUND_END_TIME = 3;
export const START_GOLD = 10;
export const GOLD_PER_ROUND = 40;
export const GOLD_PER_KILL = 1;
export const GOLD_PER_ASSIST = 1;
export const GOLD_PER_WIN = 2;
export const GOLD_MOST_DAMAGE = 1;
/** Gold for a player's nth death this game: 4, 8, 10, 12, 14… */
export function goldForDeath(n: number) {
  return n <= 1 ? 4 : 2 * n + 4;
}
export const POINT_PER_KILL = 1;
export const POINT_PER_ASSIST = 1;
export const POINT_PER_WIN = 2;
export const RESPAWN_TIME = 10;
export const DEATHMATCH_REFRESH = 180;

export const ARENA_MB_BASE = 9;
export const ARENA_START_RADIUS = (ARENA_MB_BASE + 4) * TILE_SIZE;
export const SHRINK_CR = 10;
export const LAVA_TICK = 0.1;
export const LAVA_DAMAGE_PER_TICK = 1; // 10 HP/s at NR=1.
export const LAVA_INCREASE_PER_ROUND = 0.02;

export const PLAYER_COLORS: { name: string; hex: string; css: string }[] = [
  { name: 'Red', hex: '#ff0303', css: '#ff0303' },
  { name: 'Blue', hex: '#0042ff', css: '#2d62ff' },
  { name: 'Teal', hex: '#1ce6b9', css: '#1ce6b9' },
  { name: 'Purple', hex: '#540081', css: '#9b3bd1' },
  { name: 'Yellow', hex: '#fffc01', css: '#fffc01' },
  { name: 'Orange', hex: '#fe8a0e', css: '#fe8a0e' },
  { name: 'Green', hex: '#20c000', css: '#20c000' },
  { name: 'Pink', hex: '#e55bb0', css: '#e55bb0' },
  { name: 'Gray', hex: '#959697', css: '#aaa' },
  { name: 'Light Blue', hex: '#7ebff1', css: '#7ebff1' },
  { name: 'Dark Green', hex: '#106246', css: '#36a878' },
  { name: 'Brown', hex: '#4e2a04', css: '#986234' },
];

export const BOT_NAMES = [
  'Gul\'dan', 'Ner\'zhul', 'Kel\'Thuzad', 'Medivh', 'Drak\'thul', 'Teron', 'Cho\'gall', 'Zuluhed',
  'Dentarg', 'Rend', 'Maim', 'Mannoroth', 'Kil\'jaeden', 'Archimonde', 'Tichondrius', 'Mal\'Ganis',
];

/** Bot names in random order, marked so they can't be mistaken for people. */
export function shuffledBotNames(): string[] {
  return [...BOT_NAMES].sort(() => Math.random() - 0.5).map((n) => `${n} (Bot)`);
}

export type SpellId =
  | 'fireball' | 'scourge'
  | 'lightning' | 'homing' | 'boomerang'
  | 'meteor' | 'splitter' | 'windwalk'
  | 'teleport' | 'thrust' | 'displacement'
  | 'drain' | 'firespray' | 'bouncer'
  | 'shield' | 'timeshift' | 'rush'
  | 'freeze' | 'gravity' | 'link';

export type SpellColumn = 'core' | 'D' | 'E' | 'R' | 'T' | 'C' | 'Y';
export type Targeting = 'point' | 'none';

export interface SpellDef {
  id: SpellId;
  raw: string;
  name: string;
  hotkey: string;
  col: number;
  row: number;
  column: SpellColumn;
  page: 'warlock' | 'spells1' | 'spells2' | 'spells3';
  icon: string;
  tooltip: string;
  learnResearch?: string;
  upgradeResearch?: string;
  learnCost: number;
  learnInc?: number;
  upgradeCost: number;
  upgradeInc: number;
  maxLevel: number;
  targeting: Targeting;
  cooldowns: number[];
  modelPath?: string;
  scale?: number;
}

const cd = (values: number[]) => values;
const rep = (n: number, v: number) => Array.from({ length: n }, () => v);

export const SPELLS: Record<SpellId, SpellDef> = {
  fireball: { id: 'fireball', raw: 'S000', name: 'Fireball', hotkey: 'G', col: 3, row: 0, column: 'core', page: 'warlock', icon: 'ReplaceableTextures\\CommandButtons\\BTNFireBolt.blp', learnCost: 0, upgradeCost: 5, upgradeInc: 1, maxLevel: 12, targeting: 'point', cooldowns: rep(12, 4.8), tooltip: 'Hurls a fireball. Damage and area effect improve with upgrades.', modelPath: 'Abilities\\Weapons\\RedDragonBreath\\RedDragonMissile.mdl' },
  scourge: { id: 'scourge', raw: 'S001', name: 'Scourge', hotkey: 'F', col: 2, row: 0, column: 'core', page: 'warlock', icon: 'ReplaceableTextures\\CommandButtons\\BTNCloakOfFlames.blp', learnCost: 0, upgradeCost: 16, upgradeInc: 0, maxLevel: 3, targeting: 'none', cooldowns: rep(3, 3), tooltip: 'Short range blast around the caster; also denies some hostile links/projectiles.' },
  lightning: { id: 'lightning', raw: 'S002', name: 'Lightning', hotkey: 'Q', col: 0, row: 0, column: 'D', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNChainLightning.blp', learnResearch: 'R009', upgradeResearch: 'R00P', learnCost: 9, learnInc: 3, upgradeCost: 8, upgradeInc: 1, maxLevel: 9, targeting: 'point', cooldowns: cd([16, 15.5, 15, 14.5, 14, 13.5, 13, 12.5, 12]), tooltip: 'Instant line strike. Detonates your own Fireball for the classic combo.' },
  homing: { id: 'homing', raw: 'S003', name: 'Homing Missile', hotkey: 'Q', col: 0, row: 0, column: 'D', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNManaFlare.blp', learnResearch: 'R005', upgradeResearch: 'R00O', learnCost: 10, upgradeCost: 8, upgradeInc: 1, maxLevel: 9, targeting: 'point', cooldowns: cd([17, 16.5, 16, 15.5, 15, 14.5, 14, 13.5, 13]), tooltip: 'Missile that acquires and steers toward enemies.', modelPath: 'Abilities\\Spells\\NightElf\\SpiritOfVengeance\\SpiritOfVengeanceBirthMissile.mdl', scale: 2 },
  boomerang: { id: 'boomerang', raw: 'S004', name: 'Boomerang', hotkey: 'Q', col: 0, row: 0, column: 'D', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNUpgradeMoonGlaive.blp', learnResearch: 'R00Z', upgradeResearch: 'R010', learnCost: 9, upgradeCost: 6, upgradeInc: 1, maxLevel: 9, targeting: 'point', cooldowns: cd([16, 13.9, 12.5, 11.7, 11, 10.3, 9.6, 8.9, 8.2]), tooltip: 'Curving blade that returns to its owner.', modelPath: 'ArcaneGlaive.mdl' },
  meteor: { id: 'meteor', raw: 'S008', name: 'Meteor', hotkey: 'E', col: 1, row: 1, column: 'E', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNFire.blp', learnResearch: 'R00A', upgradeResearch: 'R00R', learnCost: 15, upgradeCost: 8, upgradeInc: 2, maxLevel: 8, targeting: 'point', cooldowns: cd([20, 19.5, 19, 18.5, 18, 17.5, 17, 16.5]), tooltip: 'A falling fireball that lands after 1.35 seconds.', modelPath: 'Abilities\\Weapons\\BallsOfFireMissile\\BallsOfFireMissile.mdl' },
  splitter: { id: 'splitter', raw: 'S009', name: 'Splitter', hotkey: 'E', col: 1, row: 1, column: 'E', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNWispSplode.blp', learnResearch: 'R00H', upgradeResearch: 'R00U', learnCost: 16, upgradeCost: 8, upgradeInc: 1, maxLevel: 8, targeting: 'point', cooldowns: cd([25, 24, 23, 22, 21, 20, 19, 18]), tooltip: 'Large projectile that splits into seven shards.', modelPath: 'Abilities\\Weapons\\SpiritOfVengeanceMissile\\SpiritOfVengeanceMissile.mdl', scale: 2.5 },
  windwalk: { id: 'windwalk', raw: 'S010', name: 'Wind Walk', hotkey: 'E', col: 1, row: 1, column: 'E', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNWindWalkOn.blp', learnResearch: 'R00F', upgradeResearch: 'R00X', learnCost: 16, learnInc: 2, upgradeCost: 8, upgradeInc: 2, maxLevel: 8, targeting: 'none', cooldowns: cd([30, 28, 26, 24, 22, 20, 18, 16]), tooltip: 'Invisibility and +200 movement speed. Backstab on contact.' },
  teleport: { id: 'teleport', raw: 'S011', name: 'Teleport', hotkey: 'R', col: 2, row: 1, column: 'R', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNUnsummonBuilding.blp', learnResearch: 'R004', upgradeResearch: 'R00V', learnCost: 9, upgradeCost: 6, upgradeInc: 1, maxLevel: 9, targeting: 'point', cooldowns: cd([16, 13.5, 11.5, 10, 9, 8, 7, 6, 5.5]), tooltip: 'Blink up to 700 + 70 per level.' },
  thrust: { id: 'thrust', raw: 'S012', name: 'Thrust', hotkey: 'R', col: 2, row: 1, column: 'R', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNInvisibility.blp', learnResearch: 'R007', upgradeResearch: 'R00W', learnCost: 10, upgradeCost: 7, upgradeInc: 1, maxLevel: 9, targeting: 'point', cooldowns: cd([17, 14.5, 12.5, 11, 10, 9, 8, 7, 6.5]), tooltip: 'Fast dash; first enemy hit is damaged and knocked back.' },
  displacement: { id: 'displacement', raw: 'S013', name: 'Displacement', hotkey: 'R', col: 2, row: 1, column: 'R', page: 'spells1', icon: 'ReplaceableTextures\\CommandButtons\\BTNWandOfNeutralization.blp', learnResearch: 'R013', upgradeResearch: 'R014', learnCost: 10, upgradeCost: 7, upgradeInc: 1, maxLevel: 8, targeting: 'point', cooldowns: cd([16.5, 14, 12, 10.5, 9.5, 8.5, 7.5, 6.5]), tooltip: 'Projectile that swaps with a hit unit or teleports you on timeout.', modelPath: 'Abilities\\Spells\\NightElf\\shadowstrike\\ShadowStrikeMissile.mdl' },
  drain: { id: 'drain', raw: 'S014', name: 'Drain', hotkey: 'T', col: 3, row: 1, column: 'T', page: 'spells2', icon: 'ReplaceableTextures\\CommandButtons\\BTNCripple.blp', learnResearch: 'R00E', upgradeResearch: 'R00L', learnCost: 15, upgradeCost: 9, upgradeInc: 1, maxLevel: 8, targeting: 'point', cooldowns: cd([22, 21.5, 21, 20.5, 20, 19.5, 19, 18.5]), tooltip: 'Damages/slows enemies or heals/speeds allies.', modelPath: 'Abilities\\Spells\\Undead\\DeathCoil\\DeathCoilMissile.mdl' },
  firespray: { id: 'firespray', raw: 'S015', name: 'Fire Spray', hotkey: 'T', col: 3, row: 1, column: 'T', page: 'spells2', icon: 'ReplaceableTextures\\CommandButtons\\BTNSpell_Shadow_RainOfFire.blp', learnResearch: 'R001', upgradeResearch: 'R00J', learnCost: 15, upgradeCost: 7, upgradeInc: 1, maxLevel: 8, targeting: 'point', cooldowns: cd([18, 17, 16, 15, 14, 13, 12, 11]), tooltip: 'Fires a stream or fan of small fireballs.', modelPath: 'Abilities\\Weapons\\RedDragonBreath\\RedDragonMissile.mdl', scale: 0.73 },
  bouncer: { id: 'bouncer', raw: 'S016', name: 'Bouncer', hotkey: 'T', col: 3, row: 1, column: 'T', page: 'spells2', icon: 'ReplaceableTextures\\CommandButtons\\BTNBanish.blp', learnResearch: 'R003', upgradeResearch: 'R00K', learnCost: 16, upgradeCost: 6, upgradeInc: 1, maxLevel: 8, targeting: 'point', cooldowns: cd([20, 19, 18, 17, 16, 15, 14, 13]), tooltip: 'Projectile that retargets after hits, weakening each bounce.', modelPath: 'Abilities\\Weapons\\IllidanMissile\\IllidanMissile.mdl' },
  shield: { id: 'shield', raw: 'S005', name: 'Shield', hotkey: 'C', col: 0, row: 0, column: 'C', page: 'spells2', icon: 'ReplaceableTextures\\CommandButtons\\BTNNeutralManaShield.blp', learnResearch: 'R00C', upgradeResearch: 'R00T', learnCost: 14, upgradeCost: 8, upgradeInc: 1, maxLevel: 9, targeting: 'none', cooldowns: cd([25, 24.5, 24, 23.5, 23, 22.5, 22, 21.5, 21]), tooltip: '2.5 + 0.5/level seconds of projectile reflection.' },
  timeshift: { id: 'timeshift', raw: 'S006', name: 'Time Shift', hotkey: 'C', col: 0, row: 0, column: 'C', page: 'spells2', icon: 'ReplaceableTextures\\CommandButtons\\BTNCrystalBall.blp', learnResearch: 'R011', upgradeResearch: 'R012', learnCost: 15, upgradeCost: 7, upgradeInc: 1, maxLevel: 8, targeting: 'none', cooldowns: cd([22, 19.5, 17.5, 16, 15, 14, 13, 12]), tooltip: 'Returns to the stored position/velocity/life after 3.6 seconds.' },
  rush: { id: 'rush', raw: 'S007', name: 'Rush', hotkey: 'C', col: 0, row: 0, column: 'C', page: 'spells2', icon: 'ReplaceableTextures\\CommandButtons\\BTNMassTeleport.blp', learnResearch: 'R006', upgradeResearch: 'R00S', learnCost: 13, upgradeCost: 7, upgradeInc: 1, maxLevel: 8, targeting: 'none', cooldowns: rep(8, 21), tooltip: 'Converts incoming damage to movement speed while active.' },
  freeze: { id: 'freeze', raw: 'S017', name: 'Freeze', hotkey: 'Y', col: 3, row: 0, column: 'Y', page: 'spells3', icon: 'ReplaceableTextures\\CommandButtons\\BTNBreathOfFrost.blp', learnResearch: 'R008', upgradeResearch: 'R00M', learnCost: 14, upgradeCost: 6, upgradeInc: 2, maxLevel: 8, targeting: 'point', cooldowns: cd([20, 19, 18, 17, 16, 15, 14, 13]), tooltip: 'Missile that freezes target, reducing damage/knockback taken.', modelPath: 'Abilities\\Spells\\Undead\\FreezingBreath\\FreezingBreathMissile.mdl' },
  gravity: { id: 'gravity', raw: 'S018', name: 'Gravity', hotkey: 'Y', col: 3, row: 0, column: 'Y', page: 'spells3', icon: 'ReplaceableTextures\\CommandButtons\\BTNStarfall.blp', learnResearch: 'R00G', upgradeResearch: 'R00N', learnCost: 15, upgradeCost: 8, upgradeInc: 2, maxLevel: 7, targeting: 'point', cooldowns: rep(7, 26), tooltip: 'Slow orb that pulls warlocks/projectiles and deals small periodic damage.', modelPath: 'Abilities\\Spells\\Undead\\DarkSummoning\\DarkSummonMissile.mdl' },
  link: { id: 'link', raw: 'S019', name: 'Link', hotkey: 'Y', col: 3, row: 0, column: 'Y', page: 'spells3', icon: 'ReplaceableTextures\\CommandButtons\\BTNAdvancedStrengthOfTheMoon.blp', learnResearch: 'R00B', upgradeResearch: 'R00Q', learnCost: 12, upgradeCost: 6, upgradeInc: 1, maxLevel: 9, targeting: 'point', cooldowns: cd([14, 13, 12, 11, 10, 9, 8, 7, 6]), tooltip: 'Tether projectile. Linked enemies are pulled and drained.', modelPath: 'Abilities\\Weapons\\FarseerMissile\\FarseerMissile.mdl' },
};

export const WARLOCK_CARD: SpellId[] = ['lightning', 'meteor', 'teleport', 'drain', 'freeze', 'scourge', 'fireball', 'shield'];
export const ALL_SPELLS = Object.keys(SPELLS) as SpellId[];
export const SHOP_SPELLS: SpellId[] = ALL_SPELLS.filter((s) => !['fireball', 'scourge'].includes(s));

export type ProductId = SpellId | 'rangeMastery' | 'aoeMastery' | 'lifestealMastery' | 'inventory' | ItemId;
export type ItemId = 'boots' | 'pendant' | 'helm' | 'cape' | 'mask' | 'staff' | 'soj' | 'sword' | 'aegis';

export interface ItemDef {
  id: ItemId;
  unitRaw: string;
  name: string;
  icon: string;
  hotkey?: string;
  costs: number[];
  sell: number[];
  max: number;
  tooltip: string;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  boots: { id: 'boots', unitRaw: 'h00B', name: 'Boots of Speed', icon: 'ReplaceableTextures\\CommandButtons\\BTNSlippersOfAgility.blp', costs: [5, 5, 5], sell: [4, 8, 12], max: 3, tooltip: '+20/+30/+40 movement speed.' },
  pendant: { id: 'pendant', unitRaw: 'h00A', name: 'Pendant', icon: 'ReplaceableTextures\\CommandButtons\\BTN3M1.blp', costs: [5, 5, 5], sell: [4, 8, 12], max: 3, tooltip: '+10/+20/+30 maximum hit points.' },
  helm: { id: 'helm', unitRaw: 'h005', name: 'Helm', icon: 'ReplaceableTextures\\CommandButtons\\BTNHelmutPurple.blp', costs: [11, 11, 11], sell: [10, 20, 30], max: 3, tooltip: 'Reduces knockback taken; lowers speed.' },
  cape: { id: 'cape', unitRaw: 'h002', name: 'Cape', icon: 'ReplaceableTextures\\CommandButtons\\BTNCloak.blp', costs: [12, 12, 12], sell: [10, 20, 30], max: 3, tooltip: 'Reduces lava damage; lowers speed; adds regeneration.' },
  mask: { id: 'mask', unitRaw: 'h001', name: 'Mask of Death', icon: 'ReplaceableTextures\\CommandButtons\\BTNMaskOfDeath.blp', costs: [15], sell: [10], max: 1, tooltip: '+32% life steal, +16% damage point recovery, -22 speed, +6% knockback taken.' },
  staff: { id: 'staff', unitRaw: 'h006', name: 'Staff of Fireball', icon: 'ReplaceableTextures\\CommandButtons\\BTNStaffOfSanctuary.blp', costs: [15], sell: [10], max: 1, tooltip: 'Fireball special upgrade: level table shifts by +12, damage counter -2.' },
  soj: { id: 'soj', unitRaw: 'h004', name: 'The Stone of Jordan Ring', icon: 'ReplaceableTextures\\CommandButtons\\BTNRingGreen.blp', costs: [5], sell: [0], max: 1, tooltip: 'Next spell can be upgraded 2 levels beyond its maximum. Cannot be sold.' },
  sword: { id: 'sword', unitRaw: 'h007', name: 'Blood Sword', icon: 'ReplaceableTextures\\CommandButtons\\BTNThoriumMelee.blp', costs: [16, 16], sell: [14, 28], max: 2, tooltip: 'Upgrades Scourge/Torrent/Cataclysm mode.' },
  aegis: { id: 'aegis', unitRaw: 'h008', name: 'Aegis', icon: 'ReplaceableTextures\\CommandButtons\\BTNHumanArmorUpThree.blp', costs: [17, 17], sell: [16, 32], max: 2, tooltip: 'Reduces incoming damage; lowers speed.' },
};

export const TERRAIN_THEMES = [
  { id: 1, safe: 'Jwmb', lava: 'Dlav', weight: 300, name: 'Dungeon magma', safeColor: 0x6b5b43, lavaColor: 0xa02000 },
  { id: 2, safe: 'Odtr', lava: 'Dlvc', weight: 233, name: 'Outland lava cracks', safeColor: 0x6d5a35, lavaColor: 0xc84a10 },
  { id: 3, safe: 'Ngrs', lava: 'Glvc', weight: 233, name: 'Northrend grass', safeColor: 0x4f6b40, lavaColor: 0x9f2a0a },
  { id: 4, safe: 'Agrs', lava: 'Cpos', weight: 233, name: 'Ashenvale poison', safeColor: 0x526d3b, lavaColor: 0x5f8f1c },
  { id: 5, safe: 'Agrd', lava: 'Adrd', weight: 11, name: 'Rare drylands', safeColor: 0x7c6946, lavaColor: 0xb22d12 },
] as const;

export const ICE_TILE = 'Idki';

export const MODEL_PATHS = {
  fireballImpact: 'Abilities\\Spells\\Other\\Incinerate\\FireLordDeathExplode.mdl',
  lightningCombo: 'LGH_FB.mdl',
  thunderclapNoSplat: 'Thunderclap_nosplat.mdl',
  darkPortal: 'Abilities\\Spells\\Demon\\DarkPortal\\DarkPortalTarget.mdl',
  novaYellow: 'Nova_yellow.mdl',
  arcaneExplosion: 'ArcaneExplosion.mdx',
  shieldReflect: 'Abilities\\Spells\\Undead\\ReplenishMana\\ReplenishManaCasterOverhead.mdl',
  doomDeath: 'Abilities\\Spells\\Other\\Doom\\DoomDeath.mdl',
  frostNova: 'Abilities\\Spells\\Undead\\FrostNova\\FrostNovaTarget.mdl',
  blueWarStomp: 'Blue_WarStompCaster.mdx',
};

export const SOUND_PATHS = {
  firstBlood: 'war3mapImported\\CFirstBlood.mp3',
  doubleKill: 'war3mapImported\\BDoubleKill2.mp3',
  multiKill: 'war3mapImported\\BMultiKill3.mp3',
  megaKill: 'war3mapImported\\BMegaKill4.mp3',
  ultraKill: 'war3mapImported\\BUltraKill5.mp3',
  monsterKill: 'war3mapImported\\BMonsterKill6.mp3',
  killingSpree: 'war3mapImported\\AAKillingSpree3.mp3',
  dominating: 'war3mapImported\\AADominating4.mp3',
  ownage: 'war3mapImported\\AAOwnage5.mp3',
  rampage: 'war3mapImported\\AARampage6.mp3',
  unstoppable: 'war3mapImported\\AAUnstoppable7.mp3',
  wickedSick: 'war3mapImported\\AAWhickedSick8.mp3',
  godLike: 'war3mapImported\\AAGodLike9.mp3',
  holyShit: 'war3mapImported\\AAHolyShit10.mp3',
  hattrick: 'war3mapImported\\CHattrick.mp3',
  lastSecondSave: 'war3mapImported\\CLastSecondSave.mp3',
  denied: 'war3mapImported\\Denied.mp3',
  rescue: 'Sound\\Interface\\Rescue.wav',
  shield: 'Abilities\\Spells\\Human\\SpellSteal\\SpellStealMissile.wav',
};

export function spellCooldown(id: SpellId, level: number): number {
  const arr = SPELLS[id].cooldowns;
  return arr[Math.max(0, Math.min(arr.length - 1, level - 1))];
}

export function spellPrice(id: SpellId, currentLevel: number): number {
  if (id === 'fireball') return 5 + Math.max(0, currentLevel - 1);
  if (id === 'scourge') return 16;
  const d = SPELLS[id];
  if (currentLevel <= 0) return d.learnCost + (d.learnInc ?? 0) * 0;
  return d.upgradeCost + d.upgradeInc * (currentLevel - 1);
}

export function productName(id: ProductId): string {
  if (id in SPELLS) return SPELLS[id as SpellId].name;
  if (id in ITEMS) return ITEMS[id as ItemId].name;
  if (id === 'rangeMastery') return 'Range Mastery';
  if (id === 'aoeMastery') return 'Area Mastery';
  if (id === 'lifestealMastery') return 'Life Steal Mastery';
  return 'Inventory';
}
