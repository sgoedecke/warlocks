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

Anything that isn't available is drawn procedurally, so the game is fully playable with no files at all. The map file on its own is enough for the original look, because of the open texture pack below. In dev builds, `reference/Warlock088bhotfix.w3m` is loaded automatically if present.

The browser-side pipeline is in `src/assets/` (MPQ reader with zlib and bzip2 support, BLP and MDX parsing via `mdx-m3-viewer`'s parsers) and `src/render/mdx/` (a Three.js MDX renderer: CPU skinning, geoset/material/texture animation, team colour, particle emitters and ribbons). Terrain uses a port of WC3's ground tile shader (`src/render/terrain.ts`), which picks atlas cells from the tile types at each tile's four corners. That's why the lava edge steps tile by tile like the original.

Limitations: files stored with MPQ's PKWARE implode or ADPCM/Huffman compression (used for some base-game `.wav` sounds) can't be decoded yet, and spell sounds triggered by model events aren't played.

### Open texture pack

The map's models borrow all of their textures from the base game. `src/render/opentex/` replaces them with original, MIT-licensed art, generated in code at load time. Whenever a texture isn't in the loaded archives, the renderer uses the matching generator:

- **Effect textures** (`particles.ts`). About 55 generators, keyed by the original texture path: fire, smoke and swirl flipbooks laid out on the same 8×8 grids, glows, stars, flares, shockwaves, lightning, frost, water and so on. Particle emitters use WC3's own sprite-sheet cell rules, so the flipbooks animate the same way the originals do.
- **Unit skins** (`bake.ts`). These are baked directly onto each model's UV layout from its 3D geometry: robes, gold trim, pauldrons, hood, armour pads and copper staff. Shading uses each texel's position, normal and distance to the UV seam. The pauldrons, hood and tabard leave the team-colour layer showing through, as the originals do.
- **Command button icons** (`icons.ts`). Canvas-painted icons for every spell, item, upgrade and menu button.

`noise.ts` holds the shared tileable noise and colour helpers. To view the pack, use `dev/opentex.html` (add `?dark`, or `?bake=BloodelfWizard.mdx`) and `dev/icons.html`. Real textures from the MPQs always take precedence.

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
| `Enter` | Chat (online games) |

## Online multiplayer

**Play Online** on the main menu joins the public lobby. If nobody is waiting there, you become its host, using the settings on the left. Whoever hosts can fill empty seats with computer players and start the game when ready. Once a game starts, newcomers go to the next public lobby, so a new one is always open.

For a private game, click **Host Game**. The lobby shows a room code and a **Copy invite link** button (`?join=CODE`). Friends enter the code under **Join** or open the link. Up to 10 players can take part, humans and computers combined.

How it works:

- **Signalling.** [Trystero](https://github.com/dmotz/trystero) finds peers through public Nostr relays, so no game server is needed. The room code also encrypts the WebRTC handshake on those relays. After that, game traffic goes directly between browsers over WebRTC data channels.
- **Public lobbies** are numbered rooms (`PUBLIC1`, `PUBLIC2`, …). A newcomer joins the open lobby in the first room that has one. A room whose game has started refuses newcomers, who move to the next room. If nobody answers within 6 s, the newcomer hosts. If two people arrive together and both start hosting, the host with the smaller peer id keeps the room and the other lobby merges into it. If a lobby's host leaves before the game starts, the remaining players pick a new host the same way.
- **Lockstep, as WC3 does it.** Only orders are sent, never game state. Clients send their orders to the host. Every 2 ticks (60 ms) the host bundles everything it has received into a turn, broadcasts it, and plays it. Clients play a turn once it arrives and keep about 3 ticks queued to absorb jitter, gently speeding up or slowing down to hold that buffer. The host never waits for anyone.
- **Bots run on every peer.** They are deterministic, so their orders don't cross the network.
- **Determinism.** The sim uses its own `sin`, `cos`, `atan2` and `hypot` (`src/sim/dmath.ts`). JS engines may round `Math.sin` and similar functions differently. Every ~2 s, each client sends the host a hash of its state. A client that falls out of sync is dropped.
- **Leavers.** As in the original map, a player who leaves has their warlock removed and is greyed out on the multiboard. A closed tab is noticed at once; a dead connection after 10 s. If the host leaves mid-game, the game ends.
- **Background tabs.** Online, the sim keeps ticking from a worker timer when the tab is hidden, so a backgrounded host doesn't freeze the game. The game menu doesn't pause.
- **NAT traversal.** Connections are direct, opened with public STUN servers (Google and Cloudflare); there is no relay. That works for most home networks. It fails if a player is behind a symmetric or carrier-grade NAT (common on mobile hotspots), or on a strict office, university or VPN network.

## Graphics and power use

The menu's **Graphics** setting picks a frame cap and the maximum render resolution (device pixel ratio):

| Preset | Frame cap | Resolution |
| --- | --- | --- |
| Battery saver | 30 fps | 1× (soft on Retina) |
| Balanced (default) | 60 fps | 1.5× |
| High | display refresh rate | 2× (native Retina) |

**Anti-aliasing** (MSAA) is a separate toggle. Turning it off saves about a quarter of the GPU time but leaves jagged model edges; classic WC3 had none either. Other battery-related behaviour:

- The game drops to 20 fps when the window is unfocused and to 10 fps while paused.
- Between capped frames it sleeps on a timer, so Chrome stops waking on every vsync.
- The unit portrait and minimap redraw at 30 fps.
- The audio graph suspends when the volume is 0 or the tab is hidden.
- WebGL is created with `powerPreference: 'low-power'`.

MDX models are skinned on the GPU. Each instance uploads one palette of averaged matrix-group matrices, deduplicated across geosets, as vertex uniforms. Geometry is shared by all instances of a model, and particle and ribbon buffers are persistent. Dev autostart accepts `fps=`, `res=` and `aa=0|1` overrides for benchmarking.

## Architecture

```
src/config.ts          0.88b constants, spell/shop/item metadata, original asset paths
src/sim/               deterministic command-driven sim; no Math.random, own trig (dmath.ts)
src/ai/bot.ts          seeded command-only bots
src/assets/            MPQ/BLP/MDX loading from user-supplied archives
src/render/            Three.js renderer: WC3 tile terrain, MDX models, procedural fallbacks
src/render/opentex/    open-source replacement textures, skins and icons
src/ui/hud.ts          WC3 console, command card, shops, minimap, multiboard, tooltips
src/audio.ts           original sound files when available, procedural WebAudio otherwise
src/net/               Trystero session and lobby, lockstep turns, command validation
src/main.ts            menu, lobby, input, fixed-step/lockstep loop, camera, dev autostart hook
scripts/simtest.ts     deterministic headless verification
dev/mdxview.html       dev-only model viewer (?focus=Model.mdx&seq=&yaw=&d=&h=&at=ms)
dev/opentex.html       dev-only gallery of the open texture pack
dev/icons.html         dev-only gallery of the open command icons
```

The sim runs in lockstep: all mutation enters through `Command` objects (`move`, `stop`, `cast`, `buy`, `sell`, `ready`, `toggle`, `leave`) and all randomness uses `Rng`. Sim events carry the original model and sound paths (e.g. `war3mapImported\\CFirstBlood.mp3`), and the renderer and audio look those up in the loaded archives.

## Known deviations / skipped 0.88b features

- Avatar/Ghost modes, custom terrain editor commands, contributor skins, the Fireball colour chat command, the `-ulti` Spells 3 shop (Pious, Magma and an empty Shield copy) and the Cataclysm/Torrent Scourge variants are not implemented.
- WC3 pathing/cast-order semantics are approximated by deterministic turning plus `h000` cast point/back-swing timing.
- Projectile/warlock collision is swept for fast movers, but complex JASS callback ordering is approximated where it would not change normal play outcomes.
- Without the base-game MPQs, base-game textures come from the open texture pack. It is a lookalike, not a pixel copy. Base-game *models* (missiles such as the fireball dragon, and obstacle doodads) are still drawn with simple procedural meshes.
