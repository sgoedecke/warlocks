# Warlocks

A browser remake of the Warcraft III custom map **Warlock 0.88b**. Warlocks fight on a platform surrounded by lava, and the platform shrinks over time. Spells do little damage; their real job is knockback. Push your enemies into the lava and stay out of it yourself. The last warlock standing wins the round, and between rounds you spend gold in the shops.

The game rules come from the map's own script and object data, not from memory. Physics runs in 0.03s ticks like the original, and knockback scales with "damage points" the way the map does it. The arena is painted tile by tile and shrinks the same way. Spell numbers, shop prices, items, obstacle sets and announcer lines all match 0.88b.

```sh
npm install
npm run dev      # Vite dev server
npm run build    # tsc --noEmit + production build
npx tsx scripts/simtest.ts
```

## Gameplay fidelity highlights

- Physics uses 0.03s ticks, per-tick inertial velocities, controlled walking, friction/ice/freeze damping, arena bounds bounce, warlock/obstacle/projectile collision, and original-style knockback:
  `(100 + damagePoints) * damage * 0.03 * DC * spellFactor`.
- Arena is painted onto the original 0.88b `war3map.w3e` footprint: a flat 64×64 tile / 65×65 vertex grid from `-4096..4096`, initially lava everywhere. The script then applies the 0.88b safe/lava tile pairs, random theme probabilities, optional ice patches, terrain versioning, shrink by `CR * sqrt(living)`, and obstacle sets 1–6 carrying their original model paths.
- Round and deathmatch modes, shop phase, spawn positions, kill/assist/win/most-damage rewards, starting/gold-per-round economy and the final scoreboard are implemented.
- The shop copies the original's shop units: the Merchant (masteries, inventory) links to Spells 1, Spells 2 and Items, each a 4×3 command card with the original button positions. Costs, max levels, one-spell-per-hotkey locking, item upgrade chains and the Fire Spray / Splitter mode toggles follow 0.88b.
- Kill announcements follow the original priority (First Blood, then multikills within 9s, then sprees from 3 to 10 kills), each with its announcer line.
- All normally obtainable spells are represented: Fireball, Scourge, Lightning, Homing, Boomerang, Meteor, Splitter, Wind Walk, Teleport, Thrust, Displacement, Drain, Fire Spray, Bouncer, Shield, Time Shift, Rush, Freeze, Gravity, and Link.

## Original assets

The repository contains no Blizzard or map assets. Instead the game reads them in the browser from files you supply, and keeps them in IndexedDB so you only add them once. Nothing is uploaded anywhere.

On the main menu, drop files onto the **Original assets** panel (or click **Add files…**):

- **The Warlock 0.88b map** (`.w3m`). This provides the warlock model (`BloodelfWizard`), the map's custom effects (fire spray, boomerang, meteor and lightning-combo explosions), the Rain of Fire icon and the announcer voice lines.
- **Optionally, `war3.mpq`, `War3x.mpq` and `War3Patch.mpq`** from a classic (1.26 or earlier) install. These provide everything the map borrows from the base game: missile and spell effect models, obstacle doodads, terrain tiles, unit textures and command button icons. Reforged's CASC storage isn't supported.

Anything that isn't available is drawn procedurally, so the game is fully playable with no files at all. In dev builds, `reference/Warlock088bhotfix.w3m` is loaded automatically if present.

The browser-side pipeline is in `src/assets/` (MPQ reader with zlib and bzip2 support, BLP and MDX parsing via `mdx-m3-viewer`'s parsers) and `src/render/mdx/` (a Three.js MDX renderer: CPU skinning, geoset/material/texture animation, team colour, particle emitters and ribbons). Terrain uses a port of WC3's ground tile shader (`src/render/terrain.ts`), which picks atlas cells from the tile types at each tile's four corners. That's why the lava edge steps tile by tile like the original.

Limitations: files stored with MPQ's PKWARE implode or ADPCM/Huffman compression (used for some base-game `.wav` sounds) can't be decoded yet, and spell sounds triggered by model events aren't played.

## Controls

| Input | Action |
| --- | --- |
| Right-click | Move / cancel targeting |
| Hotkey, then left-click | Cast targeted spell |
| `G F D E R T Y C` | WC3 command-card spell hotkeys for the currently learned spell in each slot |
| `S` | Stop |
| Arrow keys / screen edge | Pan camera |
| Mouse wheel | Zoom |
| `Space` / `F1` | Centre camera on hero |
| `Tab` | Multiboard |
| `F10` / `Esc` | Menu |

## Architecture

```
src/config.ts          0.88b constants, spell/shop/item metadata, original asset paths
src/sim/               deterministic command-driven sim; no Math.random in sim
src/ai/bot.ts          seeded command-only bots
src/assets/            MPQ/BLP/MDX loading from user-supplied archives
src/render/            Three.js renderer: WC3 tile terrain, MDX models, procedural fallbacks
src/ui/hud.ts          WC3 console, command card, shops, minimap, multiboard, tooltips
src/audio.ts           original sound files when available, procedural WebAudio otherwise
src/main.ts            menu, input, fixed-step loop, camera, dev autostart hook
scripts/simtest.ts     deterministic headless verification
dev/mdxview.html       dev-only viewer for the map's imported models
```

The sim is lockstep-friendly: all mutation enters through `Command` objects (`move`, `stop`, `cast`, `buy`, `sell`, `ready`, `toggle`) and all randomness uses `Rng`. Sim events carry the original model and sound paths (e.g. `war3mapImported\\CFirstBlood.mp3`), and the renderer and audio look those up in the loaded archives.

## Known deviations / skipped 0.88b features

- Avatar/Ghost modes, custom terrain editor commands, contributor skins, the Fireball colour chat command, the `-ulti` Spells 3 shop (Pious, Magma and an empty Shield copy) and the Cataclysm/Torrent Scourge variants are not implemented.
- WC3 pathing/cast-order semantics are approximated by deterministic turning plus `h000` cast point/back-swing timing.
- Projectile/warlock collision is swept for fast movers, but complex JASS callback ordering is approximated where it would not change normal play outcomes.
- Without the base-game MPQs, models that use base-game textures (including the warlock's robes) get procedural stand-in textures.
