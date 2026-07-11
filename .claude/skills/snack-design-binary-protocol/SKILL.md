---
name: snack-design-binary-protocol
description: Design efficient binary wire formats for Snack.Game gameplay messages. Use when a datagram could exceed the ~1,000-byte path-MTU budget, or when implementing bitpacking, quantization, smallest-three quaternion compression, delta compression against acked baselines, priority accumulators, or bandwidth budgets.
---

# Design An Efficient Binary Protocol

Fit every datagram in one network packet by construction. Set the byte budget first, then apply the
cheapest encoding technique that meets it.

## Read First

Read:

- [Snack messaging API](../snack-build-multiplayer/references/messaging-api.md) for channel
  semantics, `maxSize`, and delivery guarantees
- [shared protocol rules](../snack-build-multiplayer/references/protocol-design.md) for message
  framing, validation, debug formatting, and confirmation patterns
- [references/bit-packing.md](references/bit-packing.md) when implementing bit-level encoders,
  quantization, or quaternion compression
- [references/delta-and-priority.md](references/delta-and-priority.md) when one packet cannot hold
  the whole world

Use this skill after `snack-build-multiplayer` selects channels and an approach reference defines what
each message family must carry.

## The Budget Is Physical

A datagram that does not fit in one network packet does not get fragmented and retried by Snack; it
fails. The browser rejects sends above the negotiated `maxDatagramSize`, and the server logs and
drops oversized or failed datagram sends. Channel `maxSize` is a validation ceiling, not a delivery
promise.

Plan against these numbers:

- Ethernet MTU is 1,500 bytes; after IP and UDP headers roughly 1,472 bytes reach the wire, and
  IPv6 only guarantees 1,280. QUIC and WebTransport framing take more.
- Production game protocols do not discover path MTU per player; they assume a conservative fixed
  payload of about 1,000 to 1,200 bytes and design to it.
- On Snack, keep every encoded Internet datagram at or below 1,000 bytes. Server creator code never
  learns the per-player deliverable size, so there is nothing to adapt to at runtime.
- Do not build an application-level fragmentation layer for game state. Losing any fragment loses
  the whole message, so fragmentation multiplies effective loss: at 1% packet loss, a 2-fragment
  message dies about 2% of the time and a 10-fragment message about 9.5% of the time.
- Data that legitimately exceeds one packet — bootstrap state, checkpoints, large corrections —
  belongs on a reliable stream, which accepts up to 1 MiB per message and handles delivery.

Enforce the budget in code: encode the worst-case instance of each datagram family in a test and
assert `bytes.byteLength <= 1000`.

## Work The Ladder

Apply rungs in order and stop at the first one that fits the budget with headroom. Every later rung
adds code, state, and failure modes.

1. **Send less.** The best bandwidth optimizations are about what you don't send. Cut fields the
   receiver can derive, split state into independently useful messages, lower the send rate, and
   filter by interest or visibility. At high send rates, velocity can often be dropped entirely and
   positions interpolated linearly.
2. **Quantize into fixed-width byte-aligned fields.** Bound every value, quantize floats onto the
   coarsest grid the gameplay tolerates, and lay fields out with `DataView`. Most Snack games
   should stop here: byte-aligned codecs are simple, debuggable, and already 5–10x smaller than
   JSON.
3. **Bitpack.** When byte alignment wastes real budget — many flags, many entities, sub-byte
   ranges — write fields at exact bit widths with a shared `BitWriter`/`BitReader`. This is also
   where smallest-three quaternion compression (29 bits instead of 128) pays off. See
   [references/bit-packing.md](references/bit-packing.md).
4. **Delta against an acked baseline.** Send each value relative to a snapshot the receiver has
   confirmed holding. Unchanged entities cost one bit; small changes cost a few. This is typically
   the largest single win for snapshot-heavy games. See
   [references/delta-and-priority.md](references/delta-and-priority.md).
5. **Prioritize.** When even deltas cannot fit every entity, stop trying to fit every entity. Use a
   priority accumulator to fill each packet with the currently most important updates and let the
   rest catch up on later packets. See
   [references/delta-and-priority.md](references/delta-and-priority.md).

## Field Encoding Menu

Costs assume the field is bounded and validated. Byte-aligned sizes are for rung 2; bit sizes for
rung 3 and later.

| Field                           | Encoding                                       | Cost                 |
| ------------------------------- | ---------------------------------------------- | -------------------- |
| Protocol version + message kind | Two `uint8`                                    | 2 bytes              |
| Sequence / tick                 | `uint16` with wraparound compare, or `uint32`  | 2–4 bytes            |
| Entity id                       | Ranged int over max live entities              | `ceil(log2(N))` bits |
| Boolean / flag set              | Bitmask                                        | 1 bit per flag       |
| Analog input in [-1, 1]         | Quantized `int16` (or 10–12 bits packed)       | 2 bytes / 10–12 bits |
| Position axis, bounded world    | Quantized to grid, e.g. 512 steps/m over 512 m | 18 bits              |
| Orientation (3D)                | Smallest-three quaternion, 9-bit components    | 29 bits              |
| Orientation feeding simulation  | Smallest-three, 15-bit components              | 47 bits              |
| Velocity component, bounded     | Quantized, e.g. 32 steps per m/s over ±32 m/s  | 11 bits, often omit  |
| Heading / angle (2D)            | Quantized turn fraction                        | 8–12 bits            |
| Short string (name, chat)       | Length prefix + UTF-8 bytes, hard cap          | 1 byte + bytes       |

Pick quantization by consumer: presentation-only state (snapshot interpolation) tolerates coarse
grids like 2 mm positions and 9-bit quaternion components; state that feeds back into simulation
(prediction, state sync) needs finer grids like 4,096 steps/m and 15-bit components, or corrections
will fight the local simulation.

## Never Trust, Always Range-Check

Binary decoding is an untrusted-input boundary. Beyond the shared protocol rules:

- It is not enough to read a value at the right bit width; every read must also validate the value
  against its `[min, max]` range and fail the whole packet on violation.
- Read declared lengths and counts before allocating or looping, and cap them at protocol
  constants, not at what fits in the field width.
- Never scan for terminators; strings and arrays are length-prefixed with hard caps.
- After decoding, verify the packet is fully consumed and any final-byte padding bits are zero.
- Keep encode and decode adjacent in one `src/shared/` module with golden byte vectors, so the two
  paths cannot drift apart silently. During development, interleave known sentinel bytes between
  sections to localize desyncs; both sides must agree whether sentinels are compiled in.
- QUIC already provides integrity and encryption, so checksums buy nothing on Snack; an explicit
  leading protocol-version byte is the compatibility gate. Bump it on any layout change, because a
  bitpacked format has no slack for silent reinterpretation.

## Verify

- Round-trip tests for every message family, plus malformed, truncated, out-of-range, and
  trailing-garbage packets.
- Golden byte vectors so field-width or ordering changes are visible in review.
- A worst-case size test per datagram family asserting the 1,000-byte budget.
- A bandwidth estimate: worst-case packet bytes × send rate × connections, compared against a
  stated target.
- Playtest with `snack-playtest-game` under loss, reordering, and jitter; delta and priority
  schemes must degrade to bigger-but-valid packets, never to corrupt state.

## Sources

Techniques adapted for Snack.Game from Glenn Fiedler's Gaffer On Games series:

- https://gafferongames.com/post/reading_and_writing_packets/
- https://gafferongames.com/post/serialization_strategies/
- https://gafferongames.com/post/packet_fragmentation_and_reassembly/
- https://gafferongames.com/post/snapshot_compression/
- https://gafferongames.com/post/snapshot_interpolation/
- https://gafferongames.com/post/state_synchronization/
