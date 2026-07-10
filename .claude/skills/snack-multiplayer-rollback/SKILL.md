---
name: snack-multiplayer-rollback
description: Implement bounded deterministic rollback and replay in generated Snack.Game projects. Use only when late authoritative input must change past simulation and the relevant fixed-step simulation is serializable, deterministic across client and server, and covered by replay/hash tests.
---

# Build Deterministic Rollback

Use rollback only after proving the relevant simulation can restore and replay the same inputs to
the same state. Snack supplies messaging, not rollback, history, deterministic physics, or a seeded
game RNG.

## Read First

Read:

- [Snack messaging API](../snack-build-multiplayer/references/messaging-api.md)
- [shared protocol rules](../snack-build-multiplayer/references/protocol-design.md)
- [references/example.md](references/example.md)
- existing simulation, input, side-effect, and serialization code

Use this skill only after `snack-build-multiplayer` selects rollback.

## Prove Determinism Before Networking

Require:

- fixed simulation tick
- integer/fixed-point math where cross-engine floating behavior is unsafe
- explicit seeded PRNG state
- stable entity and input ordering
- no `Date.now()`, `performance.now()`, `Math.random()`, DOM state, or unordered iteration inside
  the deterministic step
- serializable complete simulation state
- deterministic collision/physics behavior
- replay tests that compare state hashes for identical initial state and input frames

If these conditions fail, use `snack-multiplayer-snapshot-interpolation` or limited
`snack-multiplayer-client-prediction`. There is no reliable “non-deterministic rollback” path.

## Define The Tick Protocol

Use:

- client input frames tagged with future simulation tick
- a bounded input lead derived from RTT/jitter and kept inside the server's accepted future window;
  a delayed checkpoint cannot start the client permanently behind the authority
- redundant recent input frames in datagrams
- server-selected cutoff/input-delay rules
- authoritative per-tick input frames
- redundant recent authoritative frames in datagrams
- reliable periodic checkpoints containing tick, state, and hash
- an id-tagged initial checkpoint retried within a bounded window, with unacknowledged connections
  retired from gameplay
- provisional membership until that checkpoint is acknowledged; send live frames and membership
  checkpoints only to active acknowledged connection ids

The server remains authoritative. Ignore client inputs outside the accepted tick window and never
let packet volume accelerate simulation.

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

## Smooth Presentation Separately

Rollback corrects simulation; it does not remove packet jitter from rendering. Keep a bounded
presentation history and:

- render the local predicted player immediately
- render remote players a few ticks behind the simulation
- interpolate between saved presentation states using a target that advances every render frame
- adapt the delay gradually from `client.net.jitter`, within explicit minimum and maximum ticks
- never feed interpolation, camera smoothing, or correction offsets back into deterministic state

For a shooter, rollback and interpolation still do not answer “what target did the shooter see?”
Use `snack-multiplayer-lag-compensation` as a separate server-side technique when historical hit
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
