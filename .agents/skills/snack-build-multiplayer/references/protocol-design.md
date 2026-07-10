# Snack Multiplayer Protocol Design

## Contents

- Channel choice
- Message shape and validation
- JSON versus binary
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

## Message Shape

Keep discriminated `type` aliases in `src/shared/`. Do not use `interface` for sent object payloads:
interfaces lack the implicit string index signature required by Snack's recursive `NetworkMessage`
type.

```ts
export type ClientMessage =
  | {
      v: 1;
      type: "input";
      seq: number;
      moveX: number;
      moveY: number;
      buttons: number;
    }
  | {
      v: 1;
      type: "ready";
      requestId: string;
    };

export type ServerMessage =
  | {
      v: 1;
      type: "snapshot";
      tick: number;
      ackInputSeq: number;
      players: readonly PlayerSnapshot[];
    }
  | {
      v: 1;
      type: "ready-accepted";
      requestId: string;
    };
```

Use the smallest fields that express required semantics:

- `v`: protocol version
- `type`: discriminant
- `seq`: per-sender monotonic input/message sequence
- `tick` or server time: authoritative ordering
- `ackInputSeq`: newest client input included in server state
- `requestId` or event id: retry/idempotency key
- entity generation/version: reject updates for recycled entities

Do not trust a client timestamp as server time. Do not let client-provided identity override
`event.connection`.

## Validation

Decode to `unknown` and prove every field before use:

`event.json()` calls `JSON.parse` and can throw on malformed bytes. Catch decoding errors at each
queue owner before invoking a validator so one hostile message cannot reject `main()` and stop the
authoritative runtime.

```ts
export function parseInput(value: unknown): Extract<ClientMessage, { type: "input" }> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "input" ||
    !Number.isSafeInteger(record.seq) ||
    typeof record.moveX !== "number" ||
    typeof record.moveY !== "number" ||
    !Number.isSafeInteger(record.buttons)
  ) {
    return undefined;
  }

  if (
    !Number.isFinite(record.moveX) ||
    !Number.isFinite(record.moveY) ||
    Math.abs(record.moveX) > 1 ||
    Math.abs(record.moveY) > 1
  ) {
    return undefined;
  }

  return record as Extract<ClientMessage, { type: "input" }>;
}
```

Also enforce:

- allowed message types by connection/game state
- monotonic sequence windows
- per-connection rate and work limits
- numeric finiteness and domain ranges
- maximum collection/string sizes
- ownership and cooldown rules
- idempotency for retried reliable actions

Unknown or malformed input should be ignored or rejected without panicking the runtime.

## JSON Versus Binary

Start with JSON-compatible objects because they are debuggable and Snack encodes them directly.
Move a hot message to binary only after measuring meaningful bandwidth, allocation, or parse cost.

For binary messages:

- define an explicit byte order
- reserve a protocol version and message type in the header
- validate length before every read
- use `DataView` for integers/floats and `TextEncoder`/`TextDecoder` for strings
- keep a shared encode/decode implementation or shared test vectors
- reject trailing or truncated bytes unless the protocol explicitly permits them

Channel `maxSize` is Snack's validation ceiling, not the deliverable WebTransport datagram size.
Client transports negotiate a separate path-dependent datagram maximum, and server creator code does
not receive that number. Keep Internet datagrams at or below a conservative 1,000 encoded bytes
unless testing establishes a lower limit.

Measure JSON payloads with `new TextEncoder().encode(JSON.stringify(value)).byteLength`. Top-level
strings use their raw UTF-8 byte length. If a message can exceed the budget, compact it, split it into
independently useful updates, send deltas, or move it to a reliable stream.

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
