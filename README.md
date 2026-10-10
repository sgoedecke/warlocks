# Warlocks

A browser remake of the classic Warcraft III custom map **Warlocks**. Warlocks fight on a round platform surrounded by lava, and the platform shrinks over time. Spells do only a little damage. Their real job is knockback: push your enemies into the lava and keep yourself out. The last warlock standing wins the round. Between rounds you spend gold in the spell shop.

Built with TypeScript, Three.js and Vite. All textures, icons, models and sounds are generated in code, so there are no asset files.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # typecheck + production build into dist/
```

## Controls (WC3 defaults)

| Input | Action |
| --- | --- |
| Right-click | Move (also cancels targeting) |
| Hotkey, then left-click | Cast a targeted spell |
| `S` | Stop |
| `F` `L` `H` `B` `M` `G` `K` `W` `T` `R` `D` `I` | Fireball, Lightning, Homing Missile, Boomerang, Meteor, Gravity, Link, Swap, Teleport, Thrust, Shield, Windwalk |
| Arrow keys / screen edge | Pan the camera |
| Mouse wheel | Zoom |
| `Space` / `F1` | Centre the camera on your warlock |
| `C` | Toggle camera lock |
| `Tab` | Scoreboard |
| `F10` / `Esc` | Menu |

The main menu has a Quick Cast option. With it on, a targeted spell fires at the cursor as soon as you press its hotkey.

## Rules

- Everyone starts with Fireball and 20 gold. You get +8 gold per round, +6 per kill and +10 for winning a round.
- The lava does damage over time. The arena starts shrinking 12 seconds into each round.
- Knockback gets stronger the more health the target has lost.
- If someone dies within 9 seconds of being hit, the last player who hit them gets the kill.
- Opposing missiles destroy each other. Shield reflects missiles.

## Architecture

```
src/
  config.ts          tuning constants, spell definitions and per-level stats
  sim/               deterministic game simulation (no rendering, no Math.random)
  ai/bot.ts          bot players
  render/            Three.js renderer, procedural textures, particles, unit model
  ui/hud.ts          WC3-style console, command card, shop, minimap, multiboard
  audio.ts           WebAudio-synthesised sound effects
  main.ts            input, camera, fixed-step game loop, main menu
```

The simulation is built for lockstep multiplayer:

- It advances at a fixed 30 Hz tick.
- The only way to change it is through `Command` objects (`move`, `stop`, `cast`, `buy`, `ready`), which are passed to `sim.step(cmds)`.
- All randomness comes from a seeded PRNG.
- The renderer only reads sim state and interpolates between ticks. It also consumes `sim.events` for effects and sound.

To add networked play, exchange each tick's commands between peers and step every client with the same command list. Bots are deterministic too, so they can run on every client. One thing to check: browsers can return slightly different results for `Math.sin` and `Math.atan2`. Cross-browser lockstep may need its own deterministic trig functions or periodic state hashing.

## Accuracy notes

The original map went through many versions. The spell set, hotkeys and rough numbers here are reconstructed from memory of the classic versions, not extracted from the map file. Everything lives in `src/config.ts` so it is easy to retune.
