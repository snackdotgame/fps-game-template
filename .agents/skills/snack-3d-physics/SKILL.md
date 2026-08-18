---
name: snack-3d-physics
description: Add or change 3D physics in a generated Snack.Game project with jolt-ts. Use for rigid bodies, collision shapes or queries, fixed-step worlds, physical character, vehicle, or ragdoll movement, deterministic rollback, and Jolt state save/restore. Use jolt-ts-character-controller for Ecctrl-style walking, running, jumping, moving platforms, and controller prediction. Do not use for 2D-only physics or rendering-only transforms.
---

# Build 3D Physics With jolt-ts

Use `jolt-ts` for 3D physics instead of hand-rolling integration or collision math. It wraps a
package-owned Jolt Physics WASM build with a TypeScript-first API, and its default build is
compiled cross-platform deterministic — the property multiplayer rollback is built on.

## Read First

Read:

- the `jolt-ts` README and its determinism guide for the current API surface
- [references/character-controller.md](references/character-controller.md) when the game has a
  walking, running, or jumping player character
- [references/deterministic-simulation.md](references/deterministic-simulation.md) when the
  simulation is networked or needs save/restore
- [`snack-build-multiplayer`](../snack-build-multiplayer/SKILL.md) to select the netcode approach
  before wiring physics into networking

## Set Up The World

- Add `jolt-ts` as a project dependency. When players walk, run, or jump, also add the pre-built
  [`snackdotgame/jolt-ts-character-controller`](https://github.com/snackdotgame/jolt-ts-character-controller)
  package and use its `CharacterController` instead of hand-rolling capsule movement.
- Put world creation in one shared module (for example `src/shared/physics.ts`) imported by both
  `src/client.ts` and `src/server.ts`. Statically import and memoize the embedded initializer, then
  pass its resolved module as `raw`; omitting `raw` falls back to `jolt-ts`'s dynamic loader, which
  the restricted server runtime does not support:

  ```ts
  // src/shared/physics.ts
  import initJolt from "jolt-ts/native/jolt/dist/jolt-physics.wasm-compat.js";
  import { World } from "jolt-ts";

  let rawModulePromise: Promise<unknown> | undefined;

  function joltModule(): Promise<unknown> {
    rawModulePromise ??= (initJolt as unknown as () => Promise<unknown>)();
    return rawModulePromise;
  }

  export async function createPhysicsWorld(): Promise<World> {
    const raw = await joltModule();
    return World.create({
      raw: raw as never,
      deterministic: "cross-platform",
    });
  }
  ```

  Each client or server runtime initializes its own module once and creates worlds from that
  resolved module.

- Create one world per simulation from the memoized raw module; initialization is async because the
  WASM module loads first.
- For any networked or replayable simulation, pass `deterministic: "cross-platform"`. It enables
  Jolt's deterministic simulation mode, which is what makes stepping reproducible. Nothing detects
  divergence at runtime; catch it yourself by comparing state hashes across peers (see
  `references/deterministic-simulation.md`).
- Use the default single-threaded `wasm-compat` build. It embeds the WASM in the JS bundle (no
  asset plumbing), needs no cross-origin isolation, and is the safest determinism baseline.
  Multithreaded and SIMD variants trade those properties away; choose them only for a
  non-networked, presentation-only simulation that has outgrown one core.
- Pin the exact same `jolt-ts` version on client and server; state formats are tied to the build.

## Step With A Fixed Timestep

`world.step(dt, collisionSteps)` advances one tick with whatever `dt` you pass — the library does
not enforce a fixed step, so own it:

- Accumulate render time and step the simulation in fixed increments (for example `1 / 60`);
  never pass a variable frame delta into a simulation that anything replays or compares.
- Keep simulation stepping separate from rendering; interpolate presentation between the last two
  simulation states for smooth visuals at any refresh rate.
- Apply inputs and forces in one canonical order per tick (for example sorted by player id).
  Reordered inputs produce a different world, which is invisible locally and fatal when networked.

## Presentation Stays Outside

Physics owns authoritative transforms; rendering reads them. Use the `*Into(out)` read variants
(`translationInto`, `rotationInto`, ...) to copy body state into caller-owned objects without
per-frame allocation. Never write render-side smoothing, camera offsets, or visual corrections
back into bodies.

## Verify

- A short deterministic replay test: same initial bodies + same scripted inputs stepped twice in
  two worlds produce identical `saveState()` bytes (or an equal hash).
- Frame-time check under load with `snack-debug-performance`: worst-case step cost must fit the
  frame budget on the client and the CPU budget on the server.
- For networked simulations, everything in
  [references/deterministic-simulation.md](references/deterministic-simulation.md) as well.
