# Build Deterministic Prediction And Rollback

This is the default architecture for continuous real-time games: one deterministic simulation runs
on the client and the authoritative server, the local player is predicted with zero input delay,
and authoritative state corrects mispredictions by restore-and-replay. Never use delay-based
lockstep — a client must speculate and correct, not stall waiting for inputs.

Determinism must be built, not assumed: Snack supplies messaging, while `jolt-ts` supplies
deterministic 3D physics (see [`snack-3d-physics`](../../snack-3d-physics/SKILL.md)), and the game
supplies a fixed tick, seeded randomness, and canonical ordering. Prefer a deterministic
simulation for any game with many networked bodies — inputs and corrections stay small while
replicated per-body state does not.

## Read First

Read:

- [Snack messaging API](messaging-api.md)
- [shared protocol rules](protocol-design.md)
- [binary protocol design](../../snack-design-binary-protocol/SKILL.md) for encoding, quantization,
  and the datagram budget
- [`snack-3d-physics`](../../snack-3d-physics/SKILL.md) for deterministic physics setup,
  save/restore, and running the same world on the server
- [the worked example](rollback-example.md)
- existing simulation, input, side-effect, and serialization code

Use this reference only after this skill's selection flow chooses rollback.

## Prove Determinism Before Networking

Require:

- fixed simulation tick
- integer/fixed-point math where cross-engine floating behavior is unsafe
- explicit seeded PRNG state
- stable entity and input ordering
- no `Date.now()`, `performance.now()`, `Math.random()`, DOM state, or unordered iteration inside
  the deterministic step
- serializable complete simulation state
- deterministic collision/physics behavior (`jolt-ts` with `deterministic: "cross-platform"`)
- replay tests that compare state hashes for identical initial state and input frames

Everything downstream of inputs is simulation. If a value changes gameplay — random rolls, spawn
selection, timers, cooldowns — it must be deterministic too: an explicit seeded PRNG saved and
restored as part of simulation state, ticks as the only clock. One `Math.random()` in the
simulation path silently breaks every replay.

Prefer making the simulation deterministic over abandoning this path; `snack-3d-physics` covers
the physics half. Fall back to [snapshot interpolation](snapshot-interpolation.md) or limited
[client prediction](client-prediction.md) only when determinism is genuinely impractical — an
opaque third-party engine or unserializable state. There is no reliable “non-deterministic
rollback” path.

## Choose The Reconciliation Shape

Pick by whether one complete encoded snapshot fits the 1,000-byte datagram budget:

- **Full-state snapshots — the default when state fits.** The server broadcasts the complete
  authoritative state every tick as a latest-wins datagram. The client restores it into the same
  deterministic simulation, replays its still-unacknowledged local inputs, and resumes
  predicting. Every snapshot is an independent restart point: loss self-heals on the next
  snapshot, no checkpoint or hash machinery is needed, and a client that stalls too long
  hard-adopts the next snapshot. Snack's game templates ship this shape at 30 Hz with an
  eight-input redundancy tail.
- **Input-frame streaming — when state exceeds the budget.** Clients and server exchange per-tick
  input frames with redundancy; state travels only as periodic reliable checkpoints with hashes.
  This is the shape of [the worked example](rollback-example.md) and of the checkpoint items
  below.

Both shapes predict the local player at zero input delay and correct by restore-and-replay;
neither ever waits for missing remote data before stepping.

## Define The Tick Protocol

Use:

- client input frames tagged with sequence or future simulation tick
- a bounded input lead derived from RTT/jitter — either a tick lead kept inside the server's
  accepted future window, or a small server input-buffer depth target fed back to the client in
  snapshots; a delayed checkpoint cannot start the client permanently behind the authority
- redundant recent input frames in datagrams
- server-selected cutoff rules for late input (an accepted tick window, never a hidden or
  variable input delay)
- authoritative per-tick input frames (input-frame shape)
- redundant recent authoritative frames in datagrams (input-frame shape)
- reliable periodic checkpoints containing tick, state, and hash (input-frame shape)
- an id-tagged initial checkpoint retried within a bounded window, with unacknowledged connections
  retired from gameplay
- provisional membership until that checkpoint is acknowledged; send live frames and membership
  checkpoints only to active acknowledged connection ids

The server remains authoritative. Ignore client inputs outside the accepted tick window and never
let packet volume accelerate simulation.

Zero added input delay is the default feel. A small fixed input delay is a legitimate tuning
lever — it shallows rollbacks and steadies corrections at the cost of local responsiveness, and
precision games in the fighting tradition often accept two or three ticks of it. Tune it, like
damping strengths, extrapolation caps, and interpolation delay, from what the creator says the
game should feel like; set it once at match start and never vary it at runtime — a delay that
changes mid-match reads as stutter.

Keep encoded datagram bundles under a conservative 1000-byte path-MTU budget. Reduce redundancy,
use compact ids or interest groups, or fall back to reliable checkpoint/frame delivery when one
authoritative frame cannot fit. `datagrams.maxSize` is a validation ceiling, not a delivery budget.

## Save And Replay

For every predicted tick, save:

- complete state before the tick
- predicted input frame
- deterministic PRNG state as part of simulation state
- side-effect/event ids, or defer effects until confirmation

When an authoritative frame differs:

1. find the earliest divergent tick
2. restore the saved state before that tick
3. replay through the current predicted tick using authoritative frames where available
4. use the same documented prediction rule for still-missing frames
5. replace predicted history and compare hashes
6. smooth only rendered presentation; never alter replay state for visual smoothing

Reconcile periodic checkpoints by replaying retained authoritative/predicted frames newer than the
checkpoint; do not discard still-unconfirmed local inputs every checkpoint. If the divergent tick
is older than retained history, use the checkpoint as an explicit hard recovery, clear local
history, and rebuild the bounded input lead.

## Predict Remote Players

Remote players' inputs never arrive in time to simulate them exactly; predict them and absorb
corrections. Send remote state as compact pose snapshots and pick per game:

- **Dead-reckon forward — the default for fast games.** Derive velocity from the last two
  authoritative poses and extrapolate ahead by sample age plus half the RTT, bounded (about
  150 ms). Ease the displayed pose toward that target with exponential damping, and damp turning
  far harder than movement — orientation misprediction reads worse than position error, so never
  extrapolate heading. The templates use `1 - exp(-dt * 18)` for position against
  `1 - exp(-dt * 8)` for heading. Corrections from newly arrived state are absorbed by the same
  damping, so the pose glides to the corrected position instead of snapping; snap outright only
  above a teleport threshold such as a respawn.
- **Short delayed interpolation — when accuracy beats responsiveness.** Render remotes two to
  three ticks in the past, interpolating between buffered snapshots and adapting the delay from
  measured jitter. Hold the last pose rather than extrapolating when the buffer runs dry, and
  keep the delay under the server's lag-compensation rewind cap when hitscan validation exists.

Rising prediction depth means rising error: cap extrapolation, and when a remote's data stalls
past the cap, hold and fade rather than continuing to guess. Remote prediction and damping are
presentation — they never write into deterministic simulation state.

## Smooth Presentation Separately

Rollback corrects simulation; it does not remove packet jitter from rendering. Keep a bounded
presentation history and:

- render the local predicted player immediately, easing reconciliation error out with an
  exponentially decaying offset rather than popping to the corrected pose
- present remote players by the strategy chosen above — damped dead reckoning or short delayed
  interpolation
- interpolate between saved presentation states using a target that advances every render frame
- adapt any delay gradually from `client.net.jitter`, within explicit minimum and maximum ticks
- never feed interpolation, camera smoothing, or correction offsets back into deterministic state

For a shooter, rollback and interpolation still do not answer “what target did the shooter see?”
Use [lag compensation](lag-compensation.md) as a separate server-side technique when historical hit
validation is warranted. Never let the client choose an unbounded rewind time.

## Bound Cost

- cap history by ticks and bytes
- cap rollback distance per render frame or expose a recovery state
- cap accepted future/late input windows
- derive the client lead and server future window from the same documented maximum supported
  RTT/jitter; enter an explicit degraded state outside that envelope instead of silently dropping
  every input
- prune confirmed frames and checkpoints
- keep checkpoint cadence sufficient to recover from datagram loss
- separate irreversible audio, particles, analytics, and UI effects from deterministic state
- deduplicate replayed effects by stable event id

Rollback must fit the server/client CPU budget under worst accepted history, not only the common
case.

## Verify

Add deterministic tests before browser playtests:

- same initial state + input frames => same hash
- save/restore => same serialized state
- shuffled entity insertion => stable step ordering
- replay after a late input => expected corrected hash
- PRNG state restore => same random sequence

Then use `snack-playtest-game` with latency, jitter, datagram loss/reordering, long rollback windows,
checkpoint recovery, fresh-launch rejoin, and server reload.

Report maximum observed rollback ticks, history bytes, replay time, and correction behavior.
