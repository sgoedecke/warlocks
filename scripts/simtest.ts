import { Bot } from '../src/ai/bot';
import { ALL_SPELLS, type SpellId } from '../src/config';
import { Sim } from '../src/sim/game';
import type { Command, GameEvent, PlayerSetup } from '../src/sim/types';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function players(n: number): PlayerSetup[] {
  return Array.from({ length: n }, (_, i) => ({ name: `Bot${i + 1}`, color: i, isBot: true }));
}

function noNaNs(sim: Sim) {
  const vals: number[] = [sim.time, sim.phaseTimer, sim.arenaMB];
  for (const p of sim.players) vals.push(p.x, p.y, p.vx, p.vy, p.hp, p.damagePoints, p.gold, p.moveSpeed, p.NR, p.DC, p.CC);
  for (const p of sim.projectiles) vals.push(p.x, p.y, p.vx, p.vy, p.life, p.radius);
  for (const v of vals) assert(Number.isFinite(v), `non-finite sim value: ${v}`);
}

function runBotGame(seed: number) {
  const sim = new Sim({ players: players(6), seed, rules: { mode: 'round', rounds: 1, startingGold: 120, teams: 'ffa', arenaShape: 'square', pointLimit: 10 } });
  const bots = sim.players.map((p) => new Bot(p.id, seed ^ (p.id * 7919), 'hard'));
  let economyProgressed = false;
  let lavaDeath = false;
  let shrank = false;
  const cast = new Set<SpellId>();
  const hitSpells = new Set<string>();
  for (let i = 0; i < 30000 && sim.phase !== 'gameOver'; i++) {
    const cmds: Command[] = [];
    for (const b of bots) cmds.push(...b.think(sim));
    sim.step(cmds);
    noNaNs(sim);
    if (sim.players.some((p) => p.gold !== 120 || Object.keys(p.spells).length > 2 || p.itemSlots.length)) economyProgressed = true;
    if (sim.arenaMB < 9 + sim.players.length / 2) shrank = true;
    for (const e of sim.events) {
      if (e.t === 'cast') cast.add(e.spell);
      if (e.t === 'hit') hitSpells.add(`${e.src}->${e.pid}`);
      if (e.t === 'death' && e.inLava) lavaDeath = true;
    }
  }
  assert(sim.phase === 'gameOver', `bot game did not end; phase=${sim.phase}`);
  assert(economyProgressed, 'economy did not progress');
  assert(shrank, 'arena never shrank');
  assert(lavaDeath || sim.players.some((p) => p.diedInLava), 'no lava deaths observed');
  assert(cast.size >= 8, `too few spell kinds cast in bot game: ${[...cast].join(', ')}`);
  assert(hitSpells.size > 0, 'no spell hits observed in bot game');
  return sim.stateHash();
}

function drillSpell(spell: SpellId): { cast: boolean; hit: boolean; ended: boolean } {
  const sim = new Sim({ players: [{ name: 'A', color: 0, isBot: false }, { name: 'B', color: 1, isBot: false }], seed: 9000 + ALL_SPELLS.indexOf(spell), rules: { mode: 'deathmatch', rounds: 1, startingGold: 999, teams: 'ffa', arenaShape: 'square', pointLimit: 1 } });
  const a = sim.players[0];
  const b = sim.players[1];
  sim.obstacles = [];
  a.spells[spell] = Math.max(a.spells[spell] ?? 0, 5);
  a.x = a.px = -220; a.y = a.py = 0; a.facing = 0;
  b.x = b.px = 220; b.y = b.py = 0; b.facing = Math.PI;
  if (spell === 'scourge') { b.x = b.px = -40; b.y = b.py = 0; }
  if (spell === 'boomerang') { b.x = b.px = 25; b.y = b.py = 92; }
  if (spell === 'thrust') { b.x = b.px = -80; b.y = b.py = 0; }
  a.spawnProtection = b.spawnProtection = 0;
  const target = spell === 'scourge' || SPELLS_NONE.has(spell) ? { x: a.x, y: a.y } : { x: b.x, y: b.y };
  let cast = false, hit = false;
  for (let i = 0; i < 260; i++) {
    const cmds: Command[] = i === 0 ? [{ pid: 0, type: 'cast', spell, x: target.x, y: target.y }] : [];
    sim.step(cmds);
    noNaNs(sim);
    for (const e of sim.events as GameEvent[]) {
      if (e.t === 'cast' && e.spell === spell) cast = true;
      if (e.t === 'hit' && e.src === 0) hit = true;
      if (e.t === 'damageText' && e.src === 0 && e.amount > 0 && e.color !== 'green') hit = true;
      if (spell === 'displacement' && e.t === 'swap') hit = true;
      if (spell === 'link' && e.t === 'linkHit') hit = true;
      if (spell === 'freeze' && e.t === 'effect' && e.name === 'freeze') hit = true;
    }
    if (cast && (hit || !DAMAGING.has(spell)) && i > 20) break;
  }
  return { cast, hit, ended: sim.phase === 'gameOver' || sim.phase === 'fight' };
}

const SPELLS_NONE = new Set<SpellId>(['shield', 'timeshift', 'rush', 'windwalk', 'scourge']);
const DAMAGING = new Set<SpellId>(ALL_SPELLS.filter((s) => !['shield', 'timeshift', 'rush', 'windwalk', 'teleport'].includes(s)));

function spellDrill() {
  const cast = new Set<SpellId>();
  const hit = new Set<SpellId>();
  for (const spell of ALL_SPELLS) {
    const r = drillSpell(spell);
    assert(r.cast, `${spell} was not cast in drill`);
    cast.add(spell);
    if (r.hit) hit.add(spell);
  }
  for (const spell of DAMAGING) assert(hit.has(spell), `${spell} did not hit in drill`);
  assert(cast.size === ALL_SPELLS.length, 'not all spells were cast');
}

function main() {
  const a = runBotGame(123456);
  const b = runBotGame(123456);
  assert(a === b, 'same-seed bot games diverged');
  spellDrill();
  console.log('simtest ok');
  console.log(`deterministic hash ${a.slice(0, 160)}...`);
}

main();
