# Debugging And Performance Profiling

## Contents

- Reproduction record
- Failure triage
- Multiplayer checks
- Measurement scenario
- Bottleneck classification
- Diagnostic contract
- Optimization order
- Lifecycle and leak checks
- Verification report

## Reproduction Record

Capture a stable reproduction before editing:

```text
Issue:
Expected:
Actual:
Profiles/players:
Game and round state:
Input sequence:
Latency/jitter/datagram loss:
Viewport/device/DPR:
Development or production build:
First bad observation:
Console, terminal, or network evidence:
```

Prefer the exact URL and command used by the player. Confirm the shell and Vite ports are the
expected processes. Reproduce at least twice before concluding that a timing-sensitive problem is
stable.

## Failure Triage

Check in order:

1. **Build:** client/server bundle, runtime compatibility, missing exports, and asset paths.
2. **Launch:** `snack.ready`, launch envelope, identity, connection, and initial state.
3. **Protocol:** parser rejection, size limits, message family, ordering, revision, and stale data.
4. **Authority:** invalid state transition, trust boundary, timers, ownership, and lifecycle.
5. **Client state:** bootstrap, prediction, reconciliation, interpolation, rollback, and teardown.
6. **Input:** focus, pointer capture/lock, cancellation, device disconnect, sampling, and stuck state.
7. **Presentation:** renderer, camera, canvas, UI, assets, animation, audio, and resize.
8. **Performance:** only after correctness and ownership are understood.

Trace the first incorrect value rather than the final visual symptom. A wrong score label may begin
with a duplicated command, and a frozen mesh may begin with a replaced connection or stale entity
map.

## Multiplayer Checks

Inspect the selected approach:

- **Reliable commands:** command id, current revision, actor/turn, idempotency, and response state.
- **Snapshots:** monotonic tick, complete/recoverable state, interpolation buffer bounds, and
  fresh-launch rejoin bootstrap.
- **Prediction:** input sequence, acknowledgement, saved history, correction threshold, and lost
  input recovery.
- **Rollback:** fixed step, input frame, checkpoint, history bounds, state hash, and side-effect
  deduplication.

Use `client.net.rtt`, `latestRtt`, and `jitter` as observations, not assumptions. Handle `null` before
enough samples exist. Reliable streams can become late under congestion; datagrams can be lost or
reordered. Inspect queue and history bounds before increasing send rates.

Test join, leave, disconnect, fresh-launch rejoin, server rebuild, and a new tab without prior
in-memory state.
Check that connections, entity ids, timers, queues, event histories, and effects are replaced rather
than duplicated.

## Measurement Scenario

Define one representative scenario and keep it fixed across measurements:

- production or development build
- device/browser and CPU/GPU class when known
- viewport and device-pixel ratio
- player/profile count
- active level, camera, and entity count
- network simulation settings
- warm-up and sample duration
- input script or repeatable player path

Record absolute values, not only percentages:

- frame-time median and slow percentiles
- simulation and rendering time when instrumented
- server loop/update time and overruns
- memory growth across repeated rounds/rejoins
- sent/received bytes and messages by family
- queue, interpolation, prediction, or rollback-history depth
- bundle and largest asset sizes
- renderer-specific calls, primitives, resources, and post passes

Do not use headless software-renderer FPS as GPU performance evidence. Headless runs remain useful
for functional, visual-state, error, and leak checks.

## Bottleneck Classification

| Class        | Typical evidence                                     | First checks                                                 |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------ |
| server CPU   | slow authoritative step, timer drift, growing queues | algorithm, frequency, allocations, unbounded histories       |
| client CPU   | long scripting tasks, simulation/update cost         | per-frame work, allocations, entity iteration, UI layout     |
| GPU draw     | many calls or state changes                          | batching, instancing, shared materials, culling              |
| GPU vertex   | excessive geometry or shadow work                    | LOD, proxy meshes, shadow casters, imported assets           |
| GPU fragment | high DPR, overdraw, transparency, post effects       | DPR cap, fill area, particles, post chain                    |
| memory       | growth after rounds or rejoins                       | listeners, timers, maps, GPU/audio resources, retained state |
| network      | bandwidth spikes, late streams, missing datagrams    | encoding, frequency, deltas, batching, backpressure          |
| load/bundle  | slow first playable, decode stalls                   | package size, compression, lazy loading, asset formats       |

Do not remove player-visible quality before measuring simpler causes such as duplicate work, high
DPR, stale resources, missing culling, or excessive message frequency.

## Diagnostic Contract

Expose a small development-only object when repeated measurement warrants it:

```ts
export interface SnackGameDiagnostics {
  frame: number;
  state: string;
  entities: number;
  connections: number;
  queuedEvents: number;
  interpolationDepth?: number;
  predictionHistory?: number;
  rollbackHistory?: number;
  renderer?: Readonly<Record<string, number>>;
}

declare global {
  interface Window {
    __SNACK_GAME_DIAGNOSTICS__?: () => SnackGameDiagnostics;
  }
}

if (import.meta.env.DEV) {
  window.__SNACK_GAME_DIAGNOSTICS__ = () => ({
    frame,
    state: gameState.kind,
    entities: entityById.size,
    connections: connectedPlayers.size,
    queuedEvents: pendingEffects.length,
  });
}
```

Return snapshots rather than mutable internal objects. Never expose credentials, signed launch
data, private player information, or an API that can mutate authoritative state. Gate or remove
diagnostics from player-facing builds.

## Optimization Order

1. remove duplicate loops, handlers, network sends, and state copies
2. bound queues, histories, timers, and caches
3. reduce work frequency while preserving correctness
4. reuse objects and avoid hot-path allocation
5. batch and compact messages without obscuring message families
6. simplify expensive algorithms or spatial queries
7. optimize renderer/assets with engine-specific evidence
8. add adaptive quality only after stable baseline behavior

Apply one material change, then repeat the same scenario. Record regressions in responsiveness,
correctness, visual clarity, and recovery behavior.

Respect the public limits in
[`snack-configure-project`'s server runtime reference](../../snack-configure-project/references/server-runtime.md#public-hosted-resource-limits).
Do not assume a successful local desktop run proves hosted server cost is safe.

## Lifecycle And Leak Checks

Repeat several times:

- join and leave
- reload and fresh-launch rejoin
- start, finish, and restart a round
- background and restore the tab
- resize or rotate
- load and replace an asset-heavy scene

After each cycle, inspect counts for players, connections, entities, timers, listeners, animation
loops, audio nodes, render resources, histories, and queued events. Counts should return to an
expected steady state.

## Verification Report

Report:

```text
Reproduction:
Owning layer:
Root cause:
Change:
Baseline scenario:
Before:
After:
Correctness checks:
Regression checks:
Unmeasured risks:
```

Include absolute numbers and sample duration. If a measurement is unavailable, state what proxy was
used and why it is insufficient for a stronger claim.
