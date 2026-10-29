# Warlocks

**Play it at https://sgoedecke.github.io/warlocks/**

A browser remake of the Warcraft III custom map **Warlock 0.88b**. Warlocks fight on a platform surrounded by lava, and the platform shrinks over time. Spells do little damage; their real job is knockback. Push your enemies into the lava and stay out of it yourself. The last warlock standing wins the round, and between rounds you spend gold in the shops.

The game rules come from the map's own script and object data, not from memory. Physics runs in 0.03s ticks like the original, and knockback scales with "damage points" the way the map does it. The arena is painted tile by tile and shrinks the same way. Spell numbers, shop prices, items, obstacle sets and announcer lines all match 0.88b.

```sh
npm install
npm run dev      # Vite dev server
npm run build    # tsc --noEmit + production build
npx tsx scripts/simtest.ts
```

Every push to `master` builds the site and deploys it to GitHub Pages (`.github/workflows/pages.yml`).

## Gameplay fidelity highlights

- Physics uses 0.03s ticks, per-tick inertial velocities, controlled walking, friction/ice/freeze damping, arena bounds bounce, warlock/obstacle/projectile collision, and original-style knockback:
  `(100 + damagePoints) * damage * 0.03 * DC * spellFactor`.
- Arena is painted onto the original 0.88b `war3map.w3e` footprint: a flat 64×64 tile / 65×65 vertex grid from `-4096..4096`, initially lava everywhere. The script then applies the 0.88b safe/lava tile pairs, random theme probabilities, optional ice patches, terrain versioning, shrink by `CR * sqrt(living)`, and obstacle sets 1–6 carrying their original model paths.
- Round and deathmatch modes (deathmatch by default), shop phase, spawn positions, kill/assist/win/most-damage rewards, starting/gold-per-round economy and the final scoreboard are implemented.
- The shop copies the original's shop units: the Merchant (masteries, inventory) links to Spells 1, Spells 2 and Items, each a 4×3 command card with the original button positions. Costs, max levels, one-spell-per-hotkey locking, item upgrade chains and the Fire Spray / Splitter mode toggles follow 0.88b.
- Kill announcements follow the original priority (First Blood, then multikills within 9s, then sprees from 3 to 10 kills), each with its announcer line.
- All normally obtainable spells are represented: Fireball, Scourge, Lightning, Homing, Boomerang, Meteor, Splitter, Wind Walk, Teleport, Thrust, Displacement, Drain, Fire Spray, Bouncer, Shield, Time Shift, Rush, Freeze, Gravity, and Link.

## Art

Everything is drawn in code or comes from openly licensed models, icons and fonts; the repository contains no Blizzard assets.

- **Warlock**: [Animated Wizard](https://poly.pizza/m/kttbFvCl2C) by Quaternius ([CC-BY 3.0](https://creativecommons.org/licenses/by/3.0/)). The texture is recoloured per team at load, and only the clips the game uses are kept; the texture is resized to 512² JPEG.
- **Obstacles**: columns, rock pillars and trees from Kenney's [Nature Kit](https://kenney.nl/assets/nature-kit) (CC0). They are recoloured for each tileset and given procedural painted detail textures with box-projected UVs (`src/render/obstacleModels.ts`).
- **Terrain**: procedural tile textures (`src/render/tileTextures.ts`) drawn with a port of WC3's ground tile shader (`src/render/terrain.ts`), which picks atlas cells from the tile types at each tile's four corners. That's why the lava edge steps tile by tile like the original. To hide repetition, the shader blends two rotated placements of each texture under a slow mask and adds broad light and dark patches. The minimap samples the same textures.
- **Effects**: point-sprite particles, with fire and smoke using procedural 8×8 cloud flipbooks (`src/render/clouds.ts`).
- **Command button icons**: glyphs from [game-icons.net](https://game-icons.net) by Lorc, Delapouite and Lucas ([CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)), lit and framed in code (`src/render/icons.ts`). `node scripts/build-icons.mjs` regenerates `src/render/gameIconPaths.ts` from the glyph names in `icons.ts`. The favicon (`public/favicon.png`) is the Fireball icon.
- **Font**: [Marcellus](https://fonts.google.com/specimen/Marcellus) by Astigmatic ([SIL OFL](https://openfontlicense.org)), via `@fontsource/marcellus`, with digits from [Cinzel](https://fonts.google.com/specimen/Cinzel) by Natanael Gama (SIL OFL).
- **Sound**: synthesised with WebAudio (`src/audio.ts`).

## Controls

| Input | Action |
| --- | --- |
| `W A S D` | Move |
| Right-click | Move / cancel targeting |
| Hotkey, then left-click | Cast targeted spell |
| `Q E R T Y F G C` | Command-card spell hotkeys (the original's `D` slot is on `Q`, leaving WASD free) for the currently learned spell in each slot |
| `X` | Stop |
| `B` | Shop (deathmatch) |
| Arrow keys / screen edge | Pan camera while dead (otherwise it stays on your warlock) |
| Mouse wheel | Zoom |
| `Tab` | Multiboard |
| `F10` / `Esc` | Menu |
| `Enter` | Chat (online games) |

## Online multiplayer

**Quick Play** on the main menu drops you into the public game. If nobody is playing, you start one straight away against three computer players, and whoever comes next joins it mid-fight.

**Host Game** opens a private lobby with a room code and a **Copy link** button (`?join=CODE`). Friends enter the code under **Join** or open the link, before or after the host starts. Up to 10 players can take part, humans and computers combined. Hosted games stay online even with only computer players, so friends can still join; a host alone can pause.

Games are deathmatch (the original's `-dm`), free for all, on the square arena: dead warlocks respawn after 10 s, a kill or assist is worth a point and a death costs one, and the first to 20 points wins. Everyone starts with 10 gold and gets 40 more with each terrain refresh (every 3 minutes), plus gold each time they die: 4 for the first death, 8 for the second, then 2 more each time (10, 12, 14…). The shop opens with `B` or the **Shop** button, and by itself while you wait to respawn. The sim still supports the map's other modes (rounds, teams, circular arena), but the menu doesn't offer them.

How it works:

- **Signalling.** [Trystero](https://github.com/dmotz/trystero) finds peers through public Nostr relays, so no game server is needed. The room code also encrypts the WebRTC handshake on those relays. After that, game traffic goes directly between browsers over WebRTC data channels.
- **Public games** are numbered rooms (`PUBLIC1`, `PUBLIC2`, …). A newcomer joins the game in the first room that has one, moving on only if it is full. If nobody answers within 3 s, the newcomer hosts and starts a game with three computer players. If two hosts end up in one room, newcomers prefer the one already playing, and otherwise the one with the smaller peer id.
- **Joining mid-game.** The host adds the newcomer with a `join` order in the next turn, so every peer adds them on the same tick. Once there are four or more warlocks, a computer player leaves to make room. Right after that turn the host sends the newcomer the whole game state: the sim and the bots, serialised so that `-0`, `NaN` and `Infinity` survive. The newcomer starts from that tick and plays the turns that follow. Turns that arrive before the state are kept until it does. Newcomers get the gold and lava scaling everyone else has earned from terrain refreshes.
- **Lockstep, as WC3 does it.** Only orders are sent, never game state. Clients send their orders to the host. Every 2 ticks (60 ms) the host bundles everything it has received into a turn, broadcasts it, and plays it. Clients play a turn once it arrives and keep about 3 ticks queued to absorb jitter, gently speeding up or slowing down to hold that buffer. The host never waits for anyone.
- **Bots run on every peer.** They are deterministic, so their orders don't cross the network.
- **Determinism.** The sim uses its own `sin`, `cos`, `atan2` and `hypot` (`src/sim/dmath.ts`). JS engines may round `Math.sin` and similar functions differently. Every ~2 s, each client sends the host a hash of its state. A client that falls out of sync is dropped.
- **Leavers.** As in the original map, a player who leaves has their warlock removed and is greyed out on the multiboard. A closed tab is noticed at once; a dead connection after 10 s. If the host leaves mid-game, the game ends.
- **Background tabs.** Online, the sim keeps ticking from a worker timer when the tab is hidden, so a backgrounded host doesn't freeze the game. The game menu doesn't pause. A host with nobody else in the game is the exception to both: their game pauses, as an offline one would.
- **NAT traversal.** Connections are direct, opened with public STUN servers (Google and Cloudflare); there is no relay. That works for most home networks. It fails if a player is behind a symmetric or carrier-grade NAT (common on mobile hotspots), or on a strict office, university or VPN network.

## Graphics and power use

The game is capped at 60 fps and renders at up to 1.5× device pixels, with MSAA. Other battery-related behaviour:

- The game drops to 20 fps when the window is unfocused and to 10 fps while paused.
- Between capped frames it sleeps on a timer, so Chrome stops waking on every vsync.
- The minimap redraws at 30 fps. There is no 3D unit portrait, which would need a second WebGL canvas.
- The audio graph suspends when the tab is hidden.
- WebGL is created with `powerPreference: 'low-power'`.

Obstacle geometry and materials are shared by every instance. Dev autostart accepts `fps=`, `res=` and `aa=0|1` overrides for benchmarking.

## Architecture

```
src/config.ts          0.88b constants, spell/shop/item metadata
src/sim/               deterministic command-driven sim; no Math.random, own trig (dmath.ts)
src/ai/bot.ts          seeded command-only bots
src/render/            Three.js renderer: WC3 tile terrain, glTF models, particles, icons
src/render/models3d/   warlock and obstacle models (see Art)
src/ui/hud.ts          spell bar, health bar, shops, minimap, multiboard, tooltips
src/audio.ts           procedural WebAudio sound effects
src/net/               Trystero session and lobby, lockstep turns, command validation
src/main.ts            menu, lobby, input, fixed-step/lockstep loop, camera, dev autostart hook
scripts/simtest.ts     deterministic headless verification
```

The sim runs in lockstep: all mutation enters through `Command` objects (`move`, `stop`, `cast`, `buy`, `sell`, `ready`, `toggle`, `leave`) and all randomness uses `Rng`.

## Known deviations / skipped 0.88b features

- Avatar/Ghost modes, custom terrain editor commands, contributor skins, the Fireball colour chat command, the `-ulti` Spells 3 shop (Pious, Magma and an empty Shield copy) and the Cataclysm/Torrent Scourge variants are not implemented.
- WC3 pathing/cast-order semantics are approximated by deterministic turning plus `h000` cast point/back-swing timing.
- Projectile/warlock collision is swept for fast movers, but complex JASS callback ordering is approximated where it would not change normal play outcomes.
- The art is a lookalike, not the original: the warlock and obstacles are stand-in models, missiles are particle effects rather than WC3's missile models, and there are no announcer voice lines.
