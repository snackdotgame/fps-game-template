# Breachpoint

A BattleBit-inspired multiplayer FPS built with [three.js](https://threejs.org) on the
[Snack](https://snack.game) platform, with [Jolt Physics](https://github.com/jrouwe/JoltPhysics)
(WASM, cross-platform deterministic build, via the published `jolt-ts` package) on
both client and server. Two teams of blocky soldiers fight team deathmatch on an arena
where **the cover is the gameplay**: walls chip under gunfire, sledgehammers breach them,
grenades blow buildings open — and you can deploy fresh cover of your own.

## The loop

- **Team deathmatch**, two teams, auto-balanced. First to 40 kills or best score after
  5 minutes; short results screen, then the map fully restores and a new round starts.
- **Buildings collapse** (BattleBit's critical-health 'levolution'): every structure
  tracks integrity — buildings fall at 35% structural loss, trees fall when the trunk
  breaks — and a collapse drops everything left standing with dust, debris, ground
  shake, and a rubble mound that becomes new cover. Pieces darken as they're chipped,
  and explosions delete pieces up close while cracking them in an outer falloff ring.
- **Everything is destructible, piece by material-shaped piece**: brick walls are
  individual clay bricks in running bond (gunfire knocks out single bricks), cabins
  are stacked logs, roofs and floors are planks, windowpanes shatter to a single
  hit, trees are trunk segments and foliage cubes, and sandbags, crates, boulders,
  and corner posts all break too. Only the bedrock and the arena's perimeter can't
  be destroyed.
- **Multi-story buildings**: the center house and north house are two-story, and a
  three-story tower overlooks the east lane — switchback staircases of floating
  plank treads (destructible, naturally), upper-floor windows, and a shared
  **step-up assist** in the controller so stairs and low cover walk smoothly.
- **Terrain destruction**: ground-level explosions dig real craters — the shared
  heightfield drops, chunked Jolt terrain tiles rebuild on both sides, crater bowls
  render scorched, and the grass clears out. Pads and spawns can't be undermined.
- **One body per structure, not per brick**: a wall/roof/tree is a single
  static Jolt body whose collision boxes are greedy-merged from its surviving
  pieces (a pristine 230-brick wall is 3 boxes); hits resolve to the exact
  brick analytically from the hit position and the known grid, and the slab's
  shape rebuilds (batched, ~0.4ms worst case) when its damage set changes.
  ~9,000 destructible pieces ride in ~190 bodies.
- **Real structural physics**: every piece knows what it rests on. Knock out a
  wall's bottom course and the intact bricks above RELEASE — they become dynamic
  bodies on the server, tumble, and re-freeze wherever they land as repositioned,
  still-destructible pieces (clients play the fall cosmetically and receive the
  authoritative resting pose). Roof sheets hang together until their last anchor
  dies, then the whole sheet comes down; felled trees topple piece by piece;
  blast-released pieces fly outward from the explosion. Releases are budgeted
  per tick so big shears crumble progressively.
- **The level keeps evolving**: destroyed pieces chance-shed persistent rubble
  chunks that collide, obstruct, and are destructible in turn (rendered through
  pooled instancing — a thousand loose pieces is two draw calls); craters
  accumulate; bullet decals mark the walls (and die with the surface they're
  on); and dead soldiers' ragdolls linger on the field (~50s) before fading.
- **Uneven terrain**: rolling noise-generated ground (one shared height function drives
  both Jolt collision and the rendered mesh), with ridgelines as natural cover and
  buildings on flat pads.
- **Rifle** — full-auto hitscan, 30-round mag, server-side spread that worsens while
  moving or airborne. R reloads (auto on empty).
- **Grenades (G)** — real physics projectiles (they bounce); the blast damages players
  with falloff, shoves everyone nearby, and deletes every wall panel in the radius.
- **Sledgehammer (F)** — one swing knocks a brick out of a wall, two fell a tree;
  also a melee weapon.
- **Build (Q)** — deploy a cover panel where you're looking (6 per life, with a ghost
  preview). Deployed cover is destructible like everything else.
- Health regen after 6s, 3s respawns with brief spawn protection, kill feed, Tab
  scoreboard.
- **Bots** fill the server to 8 combatants, so there's a war on from the first click.
  Each joining human replaces a bot (and a bot returns when a human leaves). Bots play
  through the exact same controller and weapon hooks as humans — they patrol, acquire
  targets with real line-of-sight raycasts, strafe and burst-fire with distance-scaled
  aim wobble, lob grenades, and **sledgehammer through walls when a building is in their
  way**.

Controls: click to lock the mouse, WASD + shift sprint + space jump, LMB fire,
R reload, G grenade, F sledge, Q build, Tab scores.

## Sandbox

Flip `SANDBOX = true` in `src/shared/constants.ts` (and restart `dev`) for the
destruction test environment: no bots, no damage, bottomless
ammo/grenades/cover, and an endless round — iterate on destruction and
procgen without getting shot.

## Architecture

The whole battlefield is one **Jolt physics world on both sides** — players are
rotation-locked dynamic capsules, grenades are bouncing spheres, and every destructible
wall is its own static "panel" body. Destruction is therefore real: when a panel dies its
body is removed on the server _and_ in every client's mirror world, so you can walk and
shoot through the hole your grenade just made, and prediction collides with the same
breached geometry the server does.

- `src/shared/map.ts` — a **procedurally generated battlefield** from a fixed seed
  (change `MAP_SEED` for a new layout): an 84m arena of value-noise terrain with
  real relief (flattened under buildings and spawns, identical chunked Jolt mesh
  collision and rendered geometry from one height function, craters subtracted by
  the same function on both sides), and **~9,000 material-shaped destructible
  pieces**: nine buildings (six brick laid brick-by-brick in running bond with cut
  bricks around openings, three log cabins of stacked 2m logs; three of them
  multi-story with plank floors and switchback stairs), glass windowpanes, plank
  roofs, timber corner posts, sandbag emplacements, supply crates, boulder
  clusters, and **two species of procedural destructible trees** (oak cube-crowns
  and tiered pines, 3-6 trunk segments — two breaks fell any tree). Per-material
  HP: a brick dies to one sledge swing, a log takes two, glass shatters to
  anything, posts and rocks are tough. Deployed cover becomes a steel piece at
  runtime.
- `src/shared/physics.ts` — world construction and the deterministic FPS controller:
  walk/sprint/jump movement, plus the **deterministic weapon state machine** (ammo,
  cooldowns, reload, grenade/supply counts) that runs identically in prediction and on
  the server. Firing _effects_ are hooks: the server's hooks do hit detection and
  destruction; the client's hooks do muzzle flash and sound — so the trigger feel is
  instant and the bullets are authoritative.
- `src/server.ts` — hitscan raycasts (Jolt `castRay` with view angles carried in every
  input), panel HP, explosion AoE (players, panels, other grenades), kill/score/respawn
  flow, and round resets that rebuild the world.
- `src/client.ts` — first-person rendering in a **texture-free voxel style**: the
  ~9,000 pieces draw as one `InstancedMesh` pool per material (~12 draw calls for
  the whole battlefield) of beveled solids with deterministic per-piece palette
  variation (terracotta brick variance, wood tones, canopy greens) and damage
  tinting via instance colors; faceted flat-shaded terrain with per-face jitter and
  scorched crater bowls; **wind-swaying shader grass** (chunked, crater-aware);
  drifting voxel cloud clusters; bullet decals; soldiers with pivoted limbs, vests,
  helmets, and a speed-scaled walk cycle; **verlet ragdolls** that settle where
  soldiers die; ACES tone mapping; prediction mirror world; view-model rifle with
  recoil; tracers; explosion debris; build preview; HUD; synthesized sounds. Hot
  paths reuse shared geometries, cached materials, and flat ring buffers — effects
  never allocate GPU resources per spawn.

### Netcode

Same three-way split as the sibling snack-dash template, tuned for an FPS:

- **Snapshots (30 Hz)**: idempotent full dynamic state — every soldier pose (with view
  angles for head/gun aim), grenade bodies, ack + self state in f64 — **plus a ring of
  recent transient events** (tracers, impacts, explosions). The ring rides in every
  snapshot, so a lost datagram doesn't lose the tracer: the next snapshot still carries
  it, and the client dedupes by event seq. Latest-wins, no retransmission; the client
  restores its mirror world from each snapshot and replays pending inputs.
- **Adaptive interpolation delay**: remotes render in the past behind a jitter buffer
  sized from MEASURED snapshot inter-arrival gaps (Source-style: a multiple of the
  snapshot interval, not ping) — worst observed gap plus a tick of slack, clamped to
  66-250ms, growing fast when the network degrades and shrinking slowly. The live value
  shows as "lerp" in the HUD's corner readout.
- **Inputs (30 Hz)**: redundant 8-tail with view angles per input; the client's
  production rate is servo'd to the server-reported buffer depth. Each input also
  carries `viewTick` — the server tick of the world the client was _rendering_ when it
  sampled.
- **Destruction and construction** ride QUIC reliable streams (exactly-once, ordered —
  they change collision, so they can't be fire-and-forget), as do roster, kills, scores,
  and round flow. Late joiners get the full destroyed/built lists in the welcome.

Hit detection is **server-side with exact favor-the-shooter lag compensation**: the
server keeps a short position history per player and rewinds rifle/sledge hit tests to
each shot's reported `viewTick` — the world the shooter was actually seeing. Present-day
walls still occlude (no shooting through cover that just went up). The
**client-attributable rewind (interpolation + transit) is capped at 120ms** so high-ping
shooters can't punish targets deep into the past; the server's own input-buffer wait is
honored on top of the cap, since that delay is the server's, not the shooter's ping —
it exists even on LAN.

## Asset credits

Visual art uses a mix of procedural project art and credited CC0 model packs:

- Soldier, weapon, prop, vehicle, and environment GLB assets are from
  [Quaternius](https://quaternius.com)'s
  [Toon Shooter Game Kit](https://quaternius.com/packs/toonshootergamekit.html),
  licensed CC0 — see `assets/vendor/quaternius-toon-shooter/README.md`.
- The grenade model is from [Kenney](https://kenney.nl)'s Game Assets All-in-1
  Weapon Pack, licensed CC0 — see `assets/vendor/kenney/README.md`.
- The destructible battlefield, terrain, vegetation, voxel effects, UI shapes, and
  procedural fallback soldiers are generated by this project at runtime.

Audio assets are credited alongside their checked-in source notes:

- Footstep and impact samples are from [Kenney](https://kenney.nl)'s
  [Impact Sounds](https://kenney.nl/assets/impact-sounds), licensed CC0 — see
  `assets/sounds/LICENSE-kenney-impact-sounds.txt`.
- Rifle and reload samples are from SnakeF8 / F8 Studios'
  [Authentic Gun Sounds](https://f8studios.itch.io/snakes-authentic-gun-sounds)
  and [Second Authentic Gun Sounds](https://f8studios.itch.io/snakes-second-authentic-gun-sounds-pack),
  licensed CC0 — see the README files under `assets/sounds/snakef8-*`.

## Develop

```sh
npm install
npm run dev
```

Open the Snack host shell at `http://127.0.0.1:3030/`. Each tab is its own guest, so
two tabs are a 1v1 — plus the bots, who hold the rest of the line. (Ports: `SNACK_DEV_PORT` / `SNACK_CLIENT_PORT`; `npm run dev` goes
through turbo which strips env vars — run `npx vite` and `npx snack dev` directly for
custom ports.)

## Test

```sh
# controller/weapons/destruction physics + determinism (no browser needed)
node_modules/.bin/esbuild scripts/physics-test.ts --bundle --format=esm \
  --platform=browser --external:module --outfile=/tmp/bp-physics-test.mjs \
  && node /tmp/bp-physics-test.mjs

# two-client end-to-end battle (needs the dev server running)
PLAYWRIGHT_RESOLVE_FROM=/path/to/some/package.json node scripts/playtest.mjs
```

The playtest connects two clients on opposite teams and verifies movement sync, shooting
a wall down (and the destruction reaching the other client), grenade demolition,
deploying cover, an aimed rifle kill with score/kill-feed, respawn, and leave handling.
`window.__fps` exposes the dev hooks it uses. Checks: `npm run check`.
