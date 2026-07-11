# Snack Multiplayer Protocol Design

## Contents

- Channel choice
- Binary message shape
- Validation and debug formatting
- Delivery semantics

## Channel Choice

| Need                                                        | Prefer          | Reason                                                        |
| ----------------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| Frequent input samples                                      | Datagram        | A newer input usually supersedes a late one.                  |
| Frequent snapshots or transforms                            | Datagram        | Avoid head-of-line delay; tolerate loss with later snapshots. |
| Join/bootstrap state                                        | Reliable stream | The client needs a complete baseline.                         |
| Match start/end, inventory, chat, purchases, or room events | Reliable stream | Dropping the event is not acceptable.                         |
| Large state correction                                      | Reliable stream | Completeness matters more than freshness.                     |

Datagrams are unreliable and may be lost, duplicated, or reordered. Each reliable stream send is an
independent message and may complete before or after another send. Do not treat transport completion
as an application acknowledgement. Include sequence/order fields and reject stale messages when
application order matters.

## Binary Message Shape

Use binary for gameplay messages from the first networked implementation. Do not build a temporary
JSON wire protocol that must be replaced after the message shapes spread through client and server
code. Keep logical decoded types plus their binary codecs together in `src/shared/`.

Start every packet with an explicit protocol version and message-kind byte. Assign stable numeric
tags rather than relying on enum declaration order. Define byte order, field widths, quantization,
string encoding, collection limits, and whether trailing bytes are allowed. Include the smallest
fields needed for sequence, tick, acknowledgement, idempotency, and entity-generation semantics.

```ts
// src/shared/input-protocol.ts
export type InputMessage = {
  seq: number;
  moveX: number;
  moveY: number;
  buttons: number;
};

const PROTOCOL_VERSION = 1;
const INPUT_MESSAGE = 1;
const INPUT_BYTES = 12;
const MOVE_SCALE = 32_767;
const ALLOWED_BUTTON_MASK = 0b1111;

export function encodeInput(message: InputMessage): Uint8Array {
  if (
    !Number.isInteger(message.seq) ||
    message.seq < 0 ||
    message.seq > 0xffff_ffff ||
    !Number.isFinite(message.moveX) ||
    !Number.isFinite(message.moveY) ||
    Math.abs(message.moveX) > 1 ||
    Math.abs(message.moveY) > 1 ||
    !Number.isInteger(message.buttons) ||
    message.buttons < 0 ||
    message.buttons > ALLOWED_BUTTON_MASK
  ) {
    throw new Error("Invalid local input message");
  }

  const bytes = new Uint8Array(INPUT_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, INPUT_MESSAGE);
  view.setUint32(2, message.seq, true);
  view.setInt16(6, Math.round(message.moveX * MOVE_SCALE), true);
  view.setInt16(8, Math.round(message.moveY * MOVE_SCALE), true);
  view.setUint16(10, message.buttons, true);
  return bytes;
}

export function decodeInput(bytes: Uint8Array): InputMessage | undefined {
  if (bytes.byteLength !== INPUT_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== PROTOCOL_VERSION || view.getUint8(1) !== INPUT_MESSAGE) {
    return undefined;
  }

  const rawMoveX = view.getInt16(6, true);
  const rawMoveY = view.getInt16(8, true);
  const buttons = view.getUint16(10, true);
  if (rawMoveX < -MOVE_SCALE || rawMoveY < -MOVE_SCALE) return undefined;
  if ((buttons & ~ALLOWED_BUTTON_MASK) !== 0) return undefined;
  return {
    seq: view.getUint32(2, true),
    moveX: rawMoveX / MOVE_SCALE,
    moveY: rawMoveY / MOVE_SCALE,
    buttons,
  };
}

export function formatInputForLog(bytes: Uint8Array): string {
  const message = decodeInput(bytes);
  return message
    ? `input seq=${message.seq} move=(${message.moveX.toFixed(3)},${message.moveY.toFixed(3)}) buttons=0x${message.buttons.toString(16)}`
    : `invalid input packet (${bytes.byteLength} bytes)`;
}
```

Pass the encoded `Uint8Array` to Snack and decode `event.bytes` at the queue owner. Use `DataView`
for numeric fields and `TextEncoder`/`TextDecoder` for bounded strings. Prefer fixed-width packets
for frequent inputs and transforms; use explicit length prefixes and hard collection limits for
variable state.

## Validation And Debug Formatting

Treat every decoder as an untrusted-input boundary. Validate the complete packet before changing
authority:

- exact or minimum packet length before every read
- protocol version and allowed message tags
- declared string/collection lengths before allocating or iterating
- numeric finiteness, quantized ranges, enum values, and bit masks
- monotonic sequence windows and allowed messages for the current game state
- ownership, cooldown, per-connection rate/work limits, and retry idempotency
- trailing bytes unless that message explicitly permits an extension section

Return `undefined` or a small result type for malformed remote bytes; do not let a decoder throw out
of the authoritative loop. Local encoders may throw for programmer errors before a packet is sent.
Do not trust a client timestamp as server time or let packet fields override `event.connection`.

Make binary debugging a first-class part of the codec. Provide a formatter such as
`formatInputForLog()` that calls the real decoder and renders a compact human-readable line. This
keeps logs and devtools understandable without maintaining a second parser. Enable packet logging
only for explicit debugging, and sample or filter hot message families rather than flooding the
runtime log budget.

Test round trips, malformed/truncated packets, boundary values, and stable golden byte vectors. A
golden vector makes an accidental field-width, byte-order, or tag change visible in review.

Snack also accepts JSON-compatible payloads, but do not use them as the default gameplay wire
format. Structured chat through `client.chat` / `server.chat` is a separate host-owned capability.

Channel `maxSize` is Snack's validation ceiling, not the deliverable WebTransport datagram size.
Client transports negotiate a separate path-dependent datagram maximum, and server creator code does
not receive that number. Keep Internet datagrams at or below a conservative 1,000 encoded bytes
unless testing establishes a lower limit.

Measure the final `Uint8Array.byteLength`. If a message can exceed the budget, compact or quantize
it, split it into independently useful updates, send deltas, or move it to a reliable stream. For
bitpacking, quantization grids, delta baselines, and priority accumulators, use
[`snack-design-binary-protocol`](../../snack-design-binary-protocol/SKILL.md).

## Delivery Semantics

Snack server `send()` and `broadcast()` are fire-and-forget. Client sends resolve when the local
runtime accepts the payload, not when the game server has applied it.

When an action must be confirmed:

1. assign a request/event id
2. send the request
3. have the authority return an explicit result
4. retry only with the same id and a bounded policy
5. make the server result idempotent

For periodic state, prefer a later full/delta snapshot over retrying stale datagrams.

For a new-connection bootstrap, server `send()` is not an application receipt. Tag the bootstrap,
acknowledge it from the client after applying or superseding it, and retry the same bounded message
within an explicit attempt/time limit. Exclude or retire an unacknowledged connection when that
limit expires.
