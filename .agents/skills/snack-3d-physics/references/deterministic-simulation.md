# Deterministic Simulation With jolt-ts

## Contents

- What determinism requires
- Save and restore for rollback
- Topology changes and late join
- Running the same simulation on the server
- Caveats and version pinning

## What Determinism Requires

`deterministic: "cross-platform"` makes the physics engine bit-for-bit reproducible: the same
starting state plus the same inputs computes the same result on every machine. The engine is only
one participant — everything that feeds the simulation must be deterministic too, or replays
diverge while the physics itself behaves perfectly:

- **Fixed timestep.** Same `dt`, same `collisionSteps`, every tick, on every peer.
- **Body creation order.** Jolt assigns body ids in creation order; peers must create, add, and
  remove bodies in the same order or their state buffers stop being compatible.
- **Canonical input order.** Apply the tick's inputs in one documented order (for example sorted
  by player id, then input sequence). Reversed application order provably diverges the state.
- **Deterministic randomness.** Any RNG that affects the simulation — spawns, damage rolls, drop
  tables, crit chance — must be an explicit seeded PRNG whose state lives inside the saved
  simulation state. `Math.random()` anywhere in the simulation path breaks every replay.
- **No wall-clock reads.** `Date.now()` and `performance.now()` never influence simulation
  decisions; ticks are the only clock.
- **Everything downstream of inputs is simulation.** If a value changes gameplay — timers, spawn
  points, cooldowns, status effects — it lives in deterministic state and is stepped by ticks,
  not by frames or timestamps.

## Save And Restore For Rollback

Two mechanisms with different jobs; do not mix them up:

- `saveState()` / `restoreState()` is the hot rollback path. It captures positions, velocities,
  active state, and contacts of **existing** bodies — it never creates or destroys bodies. Keep a
  ring buffer of state buffers keyed by tick, sized to the maximum rollback window.
- Use a reusable state recorder (`createStateRecorder()`) in the loop instead of allocating a
  fresh `Uint8Array` every tick; take an owned copy only for buffers that outlive the tick.
- Game state that lives outside the physics world (seeded PRNG state, scores, cooldowns, entity
  metadata) must be saved and restored alongside the physics buffer as one atomic snapshot — a
  rollback that restores physics but not the PRNG desyncs on the next random draw.
- Compare peers with a cheap hash over the saved bytes; hashing on every checkpoint catches
  divergence at the tick it happens instead of minutes later.

Before calling `restoreState()` for an earlier tick, first create or destroy bodies until the
world's body set exactly matches that tick, then restore state and replay forward.

## Topology Changes And Late Join

- `takeSceneSnapshot()` / `restoreSceneSnapshot()` serializes the full world — body creation
  settings, shapes, constraints, preserved ids. Use it to bootstrap a late-joining peer or to
  hard-recover a desynced one, then replay the in-flight ticks on top.
- Spawning or destroying bodies inside the rollback window needs care: a rollback past the spawn
  tick must recreate the spawn deterministically during replay. Prefer spawning through the
  deterministic simulation (driven by tick + seeded PRNG), never from render-side events.
- Scene snapshots are tied to the exact engine build; they are a live-session transfer format,
  not a durable save format.

## Running The Same Simulation On The Server

The Snack server runtime is a restricted V8 isolate: no filesystem, no `fetch`, no dynamic
file-URL imports. The intended authoritative pattern is to step the same jolt-ts world on client
and server.

- Do not rely on the library's dynamic loader on the server. Statically import the embedded
  `wasm-compat` module (`jolt-ts/native/jolt/dist/jolt-physics.wasm-compat.js`), initialize it
  once, and pass the resolved module as `raw` (`World.create({ raw: raw as never, ... })`) so the
  bundler inlines it into the server bundle. Use the memoized `joltModule()` pattern from the parent
  skill in one shared physics module used by both entrypoints. Omitting `raw` selects the unsupported
  dynamic-loader path.
- Run the **same build variant** (single-threaded `wasm-compat`) on client and server. Determinism
  is guaranteed for the same build across machines; mixing build variants (for example asm.js on
  one side and WASM on the other) voids that guarantee.
- Prove the pairing with a cross-environment test: identical scenario stepped in the browser
  client and in local `snack dev` server output must produce identical state hashes before any
  netcode is built on top.
- Physics stepping counts against the server CPU budget. Measure worst-case step plus maximum
  rollback replay cost, not the idle case.

## Caveats And Version Pinning

- Pin one exact `jolt-ts` version for the whole project; client and server must resolve the same
  version. State buffers and scene snapshots are not compatible across engine builds.
- Multithreaded/SIMD builds weaken the determinism story and require cross-origin isolation;
  never use them for networked simulation.
- The library enforces none of the harness rules above — fixed dt, creation order, input order,
  and seeded RNG are the game's responsibility, and the deterministic replay tests in
  [`snack-build-multiplayer`](../../snack-build-multiplayer/SKILL.md)'s rollback reference are
  what make violations visible.
