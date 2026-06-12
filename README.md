# Breachpoint

A BattleBit-inspired multiplayer FPS built with [three.js](https://threejs.org) on the
[Minion](https://minion.game) platform, with [Jolt Physics](https://github.com/jrouwe/JoltPhysics)
(WASM, cross-platform deterministic build, via the local [jolt-ts](../jolt-ts) wrapper) on
both client and server. Two teams of blocky soldiers fight team deathmatch on an arena
where **the cover is the gameplay**: walls chip under gunfire, sledgehammers breach them,
grenades blow buildings open — and you can deploy fresh cover of your own.

## The loop

- **Team deathmatch**, two teams, auto-balanced. First to 40 kills or best score after
  5 minutes; short results screen, then the map fully restores and a new round starts.
- **Buildings collapse** (BattleBit's critical-health 'levolution'): every structure
  tracks integrity — buildings fall at 40% wall loss, trees fall when the trunk
  breaks — and a collapse drops everything left standing with dust, debris, ground
  shake, and a rubble mound that becomes new cover. Panels darken as they're chipped,
  and explosions delete panels up close while cracking them in an outer falloff ring.
- **Uneven terrain**: rolling noise-generated ground (one shared height function drives
  both Jolt collision and the rendered mesh), with ridgelines as natural cover and
  buildings on flat pads.
- **Rifle** — full-auto hitscan, 30-round mag, server-side spread that worsens while
  moving or airborne. R reloads (auto on empty).
- **Grenades (G)** — real physics projectiles (they bounce); the blast damages players
  with falloff, shoves everyone nearby, and deletes every wall panel in the radius.
- **Sledgehammer (F)** — two swings open a wall; also a melee weapon.
- **Build (Q)** — deploy a cover panel where you're looking (6 per life, with a ghost
  preview). Deployed cover is destructible like everything else.
- Health regen after 6s, 3s respawns with brief spawn protection, kill feed, Tab
  scoreboard.
- **Bots** fill the server to 6 combatants, so there's a war on from the first click.
  Each joining human replaces a bot (and a bot returns when a human leaves). Bots play
  through the exact same controller and weapon hooks as humans — they patrol, acquire
  targets with real line-of-sight raycasts, strafe and burst-fire with distance-scaled
  aim wobble, lob grenades, and **sledgehammer through walls when a building is in their
  way**.

Controls: click to lock the mouse, WASD + shift sprint + space jump, LMB fire,
R reload, G grenade, F sledge, Q build, Tab scores.

## Architecture

The whole battlefield is one **Jolt physics world on both sides** — players are
rotation-locked dynamic capsules, grenades are bouncing spheres, and every destructible
wall is its own static "panel" body. Destruction is therefore real: when a panel dies its
body is removed on the server _and_ in every client's mirror world, so you can walk and
shoot through the hole your grenade just made, and prediction collides with the same
breached geometry the server does.

- `src/shared/map.ts` — a **procedurally generated battlefield** from a fixed seed
  (change `MAP_SEED` for a new layout): value-noise terrain with real relief
  (flattened under buildings and spawns, identical Jolt mesh collision and rendered
  geometry from one height function), five buildings made of ~950 fine-grained panels
  (1m x 0.625m — holes where you actually shoot), procedurally placed cover walls and
  crates, and **destructible trees** — two sledge swings or any blast to the trunk
  fells the whole tree. Deployed cover becomes a panel at runtime.
- `src/shared/physics.ts` — world construction and the deterministic FPS controller:
  walk/sprint/jump movement, plus the **deterministic weapon state machine** (ammo,
  cooldowns, reload, grenade/supply counts) that runs identically in prediction and on
  the server. Firing _effects_ are hooks: the server's hooks do hit detection and
  destruction; the client's hooks do muzzle flash and sound — so the trigger feel is
  instant and the bullets are authoritative.
- `src/server.ts` — hitscan raycasts (Jolt `castRay` with view angles carried in every
  input), panel HP, explosion AoE (players, panels, other grenades), kill/score/respawn
  flow, and round resets that rebuild the world.
- `src/client.ts` — first-person rendering (primitive-built map and soldiers, no asset
  downloads at all), the prediction mirror world, view-model rifle with recoil, tracers,
  explosion debris, build preview, HUD, and synthesized sounds.

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

## Develop

```sh
npm install
npm run dev
```

Open the Minion host shell at `http://127.0.0.1:3030/`. Each tab is its own guest, so
two tabs are a 1v1 — plus the bots, who hold the rest of the line. (Ports: `MINION_DEV_PORT` / `MINION_CLIENT_PORT`; `npm run dev` goes
through turbo which strips env vars — run `npx vite` and `npx minion dev` directly for
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
