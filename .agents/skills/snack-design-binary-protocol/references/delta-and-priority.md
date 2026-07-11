# Delta Compression And Priority Accumulators

## Contents

- Budget worksheet
- Delta compression against an acked baseline
- Delta encoding tricks
- Priority accumulators
- Loss, recovery, and resets

## Budget Worksheet

Do this arithmetic before writing any codec. Budget 1,000 bytes = 8,000 bits per datagram.

```
header:      version(8) + kind(8) + snapshotSeq(16) + baselineSeq(16) + count(?) ≈ 56 bits
per entity:  id + per-field bits (absolute, worst case)
capacity:    floor((8000 - header) / worstCaseEntityBits)
bandwidth:   packetBytes × sendRate × connections
```

Example: 9-bit ids (≤512 entities), 3×18-bit positions, 29-bit orientation ≈ 92 bits per entity
absolute → ~86 entities per packet before deltas. (A top-down 2D game would drop the axis and
replace the quaternion with an 8–12 bit heading.) If the world holds more than fits, or bandwidth
at your send rate exceeds the target, continue down this file.

For calibration, the canonical Gaffer On Games cube demo (901 physics cubes at 60 Hz) went from
17.37 Mbit/s uncompressed to a 256 kbit/s target — and about 15 kbit/s at rest — using exactly the
techniques below, applied in this order: quantization, smallest-three, dropping velocity,
delta-versus-baseline, then per-field delta tricks.

## Delta Compression Against An Acked Baseline

Send state relative to a snapshot the receiver has confirmed holding. Unchanged entities cost one
bit; changed entities usually cost a few bits instead of their absolute width.

The protocol, adapted to Snack (no transport acks are exposed, so acks are application-level):

1. The server stamps every snapshot datagram with a `snapshotSeq` and stores the quantized
   integer state it sent, per connection, in a bounded ring (e.g. the last 32 snapshots).
2. The client keeps its own ring of decoded quantized snapshots and piggybacks
   `ackSeq = newest snapshotSeq applied` on its regular input datagrams — two bytes, no extra
   packet. A client that sends no inputs (a spectator) sends a small periodic ack datagram
   instead.
3. The server encodes each snapshot relative to the state at the connection's latest `ackSeq` and
   writes that `baselineSeq` in the header. The receiver decodes against its stored copy of that
   exact snapshot.
4. If no ack has arrived yet, the acked snapshot has left the ring, or the connection is new, the
   server sends an absolute (keyframe) snapshot, flagged in the header.

Because the baseline is always something the receiver acked, every delta packet is independently
decodable — loss never creates a packet that references missing data. Loss and reordering only
age the baseline, which makes deltas larger, never wrong. Acks are idempotent and monotonic:
ignore an `ackSeq` older than the one already recorded.

Every "older/newer" comparison on `snapshotSeq`, `baselineSeq`, and `ackSeq` must be
wraparound-safe. A `uint16` at 20–60 snapshots per second wraps in 18–54 minutes — well within a
normal session — and a naive `>` comparison at the wrap corrupts baselines silently. Compare via
signed 16-bit difference (`(a - b) << 16 >> 16 > 0`), or spend the two extra bytes on a `uint32`
and sidestep the problem.

Rules that keep this correct:

- Diff and store in quantized integer space. The stored baseline is the wire integers, not floats;
  both sides must reconstruct bit-identical baselines or deltas corrupt silently.
- Bound both rings. If the acked baseline is older than the ring, fall back to absolute rather
  than growing memory.
- Send a forced absolute snapshot every N packets (or seconds) so worst-case recovery after a loss
  burst is bounded regardless of ack behavior.
- Client-side, drop any snapshot whose `snapshotSeq` is not newer than the last applied one;
  datagrams may be duplicated or reordered.

## Delta Encoding Tricks

Within a delta snapshot, in rough order of value:

- **Unchanged bit per entity.** One bit says "identical to baseline." In mostly-static scenes this
  single trick collapses bandwidth to near the header cost.
- **Changed-index list vs changed bitmask.** With E entities, a full bitmask costs E bits. When
  fewer than about E/log2(E) entities changed, a count plus per-entity indices is cheaper; encode
  a 1-bit header flag selecting the mode and pick whichever encodes smaller each packet.
- **Relative indices.** Sort changed entities by id and encode gaps between successive ids with a
  tiered width (small gap in few bits, escape to wider forms). In the cube demo this averaged
  5.5 bits versus 10-bit absolute indices.
- **Tiered per-field deltas.** Encode `current - baseline` per component with 2 mode bits: small
  delta in ~5 bits, medium in ~9, else the full absolute field. Most moving entities move a
  little per snapshot interval. Tune tier boundaries with a histogram of real gameplay deltas —
  measure, don't guess.
- **Per-field unchanged bits.** Even on "changed" entities, individual fields (often orientation)
  are frequently bit-identical to baseline after quantization; a 1-bit flag per field captures it.
- **At-rest flag.** Skip velocity (and any derivative fields) for resting entities, and keep
  resending a newly rested entity until an ack proves its final state landed.

Every tiered encoding must include an absolute escape so out-of-range motion (teleports, spawns)
still encodes; validate decoded deltas against field ranges exactly like absolute values.

## Priority Accumulators

When even deltas cannot fit every entity, stop fitting every entity. Fill each packet with the
currently most important updates and let everything else catch up over subsequent packets.

```ts
type Replicated = {
  id: number;
  accumulator: number; // per connection
};

function selectForPacket(
  entities: Replicated[],
  priorityOf: (id: number) => number,
  costBits: (id: number) => number,
  budgetBits: number,
): Replicated[] {
  for (const e of entities) e.accumulator += priorityOf(e.id);
  const byUrgency = [...entities].sort((a, b) => b.accumulator - a.accumulator);
  const included: Replicated[] = [];
  let used = 0;
  for (const e of byUrgency) {
    const cost = costBits(e.id);
    if (used + cost > budgetBits) continue; // later, smaller entries may still fit
    used += cost;
    included.push(e);
    e.accumulator = 0; // only included entities reset
  }
  return included;
}
```

Guidance:

- Accumulators are per connection: each player has a different own-player entity and a different
  view of what is near or interacting.
- Weight by gameplay relevance: the player's own state effectively always included (weight ~10⁶),
  interacting or nearby entities high (say 100), distant idle entities low (1). Skipped entities
  keep accumulating. Starvation is impossible only when every entity has positive priority and its
  encoded cost fits within the packet budget; oversized entities need a different encoding or
  reliable chunking path.
- Boost the priority of entities with pending must-land state (just came to rest, just spawned)
  until an ack covers them.
- The packet must carry explicit entity ids (or the changed-index structures above); membership
  now varies per packet, so nothing may be inferred from position in the packet.
- Interest management composes: filter to what the player can perceive first, then prioritize
  within that set.

## Loss, Recovery, And Resets

- Send rate trades against latency tolerance downstream: snapshot interpolation needs a buffer of
  roughly three send intervals to ride out consecutive losses, so halving packet size by halving
  send rate is not free. Tune with the snapshot-interpolation reference in `snack-build-multiplayer`.
- Deltas and priorities degrade under loss into larger or later packets. If a design degrades into
  _invalid_ packets — deltas against unacked baselines, inferred membership — fix the design, not
  the symptoms.
- Reset all baselines, rings, and accumulators for a connection on bootstrap, rejoin, or server
  instance change, and version the snapshot stream so a stale client cannot apply deltas across a
  reset.
- Verify under `snack-playtest-game` network conditions: loss and reordering must produce visibly
  degraded but never corrupt state, and a long loss burst must recover via the forced-absolute
  path within its bounded window.
