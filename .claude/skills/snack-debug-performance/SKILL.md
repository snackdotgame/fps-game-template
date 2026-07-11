---
name: snack-debug-performance
description: Diagnose and improve generated Snack.Game projects. Use for blank or broken games, runtime and asset failures, incorrect state, stuck input, disconnect or fresh-launch rejoin bugs, slow frames, memory growth, excessive rendering or network cost, server CPU problems, and performance regressions that require reproducible evidence and before-and-after measurements.
---

# Debug And Profile Snack.Game Projects

Reproduce the player-visible failure through the real Snack launch path, identify the owning layer,
fix the cause there, and remeasure the same scenario.

## Establish The Reproduction

Read:

- `AGENTS.md`, `package.json`, and `snack.json`
- the changed client, server, shared protocol, and relevant skill references
- browser console/network errors and the attached `snack dev` terminal output

For server CPU or memory work, read
[the public hosted limits](../snack-configure-project/references/server-runtime.md#public-hosted-resource-limits)
before choosing a measurement scenario or accepting a fix.

Run the project through the Snack host shell at `http://127.0.0.1:3030/`, or its configured shell
port. Do not use the Vite-only client page as evidence for networked gameplay.

Record:

- exact profile/player count, action sequence, network conditions, viewport, and game state
- expected and actual behavior
- first observable bad state and the earliest relevant error
- whether the problem reproduces in development, production build, or both

## Classify Before Editing

Assign the failure to its narrowest owner:

- launch envelope or connection lifecycle
- protocol parsing, ordering, or recovery
- authoritative rules or server timing
- prediction, interpolation, or rollback
- input/focus/device handling
- renderer, camera, scene, UI, assets, or audio
- build, dependency, or restricted server runtime
- CPU, GPU, memory, bundle/assets, or network bandwidth

Read [references/profiling.md](references/profiling.md) for layer-specific checks, measurement
scenarios, diagnostic contracts, and optimization order.

## Fix The Owning Layer

- trace the actual state transition instead of masking symptoms in UI
- preserve existing protocol and project compatibility
- add bounds and recovery for queues, histories, timers, fresh-launch rejoins, and resource lifetimes
- apply one performance change at a time, then remeasure
- keep diagnostics development-only or explicitly gated
- do not weaken server authority to hide latency or correctness problems

If the project uses Three.js and the evidence points to rendering, load `snack-threejs-rendering`.
If the evidence points to multiplayer behavior, load the selected multiplayer approach skill.

## Verify The Exact Path

Use `snack-playtest-game` to replay the original reproduction and nearby failure modes. For
performance work, compare the same profile count, state, viewport, device-pixel ratio, network
conditions, duration, and production/development mode.

Report:

- reproduction and owner
- root cause and mechanism
- files changed
- before/after absolute measurements
- correctness and visual regressions checked
- remaining uncertainty or unmeasured risk

Run the project `check` and `build` scripts after implementation.
