# Build Client Prediction And Reconciliation

Predict only the local subsystem that needs immediate feedback. Reconcile it to authoritative
snapshots using acknowledged input history. This is not full-world rollback.

## Read First

Read:

- [Snack messaging API](messaging-api.md)
- [shared protocol rules](protocol-design.md)
- [binary protocol design](../../snack-design-binary-protocol/SKILL.md) for encoding, quantization,
  and the datagram budget
- [the worked example](client-prediction-example.md)
- [snapshot interpolation](snapshot-interpolation.md) for remote entity presentation

Use this reference after this skill's selection flow chooses local prediction.

## Define The Predicted Boundary

Choose a small client-replayable state, commonly:

- local character locomotion
- camera response
- weapon recoil animation
- immediate cosmetic projectile/effect

Keep score, damage, hits, inventory, cooldown completion, collisions that affect others, and match
outcomes authoritative.

If the full simulation is non-deterministic, keep authoritative snapshots as the correctness
architecture. Locally animate only a non-authoritative presentation proxy: visual feedback or a
simple kinematic transform that is never fed into physics, collision, hits, or game state. Do not
replay an opaque physics engine and call the result rollback.

## Input And Snapshot Contract

Client input:

- monotonically increasing `seq`
- normalized controls only
- fixed-step semantics
- optional redundancy of recent unacknowledged inputs in each datagram

Authoritative snapshot:

- server tick/time
- confirmed local state
- `ackInputSeq` for the newest applied input
- remote entity states for interpolation

The server validates ranges, processes inputs at a bounded rate, and never lets message volume speed
up simulation.

## Predict

On each local fixed step:

1. sample controls
2. allocate the next input sequence
3. apply a pure predicted step locally
4. append the input to a bounded history
5. send recent unacknowledged inputs through a datagram

Keep rendering/smoothing state separate from predicted simulation state.

Drive the fixed step from a bounded accumulator, not an unbounded timer backlog. Browser timers are
throttled in background tabs. On visibility loss, stop accumulating prediction time and send neutral
input when held movement would otherwise continue; reconcile from authority on return.

## Reconcile

For a replayable predicted subsystem, when a snapshot arrives:

1. replace predicted simulation state with authoritative local state
2. discard input history through `ackInputSeq`
3. replay remaining inputs in sequence
4. measure the correction from the previously rendered state
5. ignore tiny visual error, smooth moderate visual error, and snap unsafe/large error

Never feed a visual smoothing offset back into simulation.

For a non-deterministic presentation proxy, do not use the replay procedure above. Accept the
server state and blend or snap only the presentation transform toward authority.

## Bound Failure Modes

- cap input history by count and age
- cap redundant inputs per packet
- measure the encoded input bundle and keep it under a conservative 1000-byte datagram budget
- reject stale snapshots
- reset history on fresh-launch rejoin/server instance change
- retry an id-tagged reliable bootstrap within a bounded window and retire unacknowledged
  connections when that window expires
- snap when the server acknowledgement falls outside retained history
- handle missing datagrams without waiting forever
- rebase a bounded sequence window after a long datagram gap without allowing packet volume to add
  extra simulation steps
- keep prediction correct when `client.net.rtt` or `jitter` is `null`

This reference is the fallback for simulations that cannot be made deterministic. When the
simulation passes deterministic replay tests, prefer [rollback](rollback.md) — the real-time
default — instead of widening a local prediction boundary.

## Verify

Test:

- no-latency parity between prediction and authority
- latency and jitter
- datagram loss/reordering
- long holds and rapid direction changes
- collision/constraint corrections
- lost acknowledgement and history overflow
- fresh-launch rejoin and server reload
- malicious over-rate or out-of-range input

Use `snack-playtest-game` and report correction size/behavior rather than “feels okay.”
