# Snack.Game Messaging API

Use the generated `.snack/types/client.d.ts` and `.snack/types/server.d.ts` as the exact contract for
the installed CLI version. This reference describes the current API and delivery semantics.

## Contents

- Payloads and events
- Client send and receive APIs
- Server send, broadcast, and receive APIs
- Datagram and reliable-stream semantics
- Network statistics and connection metadata
- Common patterns and constraints

## Payloads

Both channels accept:

```ts
type NetworkMessage =
  | string
  | number
  | boolean
  | null
  | NetworkMessage[]
  | { [key: string]: NetworkMessage };

type Payload = NetworkMessage | Uint8Array | ArrayBuffer | ArrayBufferView | string;
```

Top-level strings are sent as raw UTF-8 and should be read with `text()`. Other JSON-compatible
values are JSON-encoded and should be read with `json()`. Byte payloads are sent unchanged.

Every channel exposes `maxSize`, but this is Snack's validation ceiling, not a promise that the
transport can deliver a message that large. Stream messages currently allow up to 1 MiB. Datagram
delivery is additionally limited by WebTransport's path-dependent maximum, commonly around 1,200
bytes. The browser checks its negotiated `maxDatagramSize` and rejects oversized sends. Server code
does not receive a per-player deliverable-size value.

Keep Internet-facing datagrams at or below a conservative 1,000-byte encoded budget unless a tested
deployment provides a lower bound. Measure the encoded bytes, not JavaScript character count. Use
compact fields, deltas, multiple independently useful datagrams, or a reliable stream for larger
state. Never use `datagrams.maxSize` as the payload budget.

Server datagram sends are fire-and-forget. A transport send failure is logged and that datagram is
dropped; it does not confirm delivery and must not disconnect the player. Design every datagram
message family to tolerate loss.

Server stream send methods also return `void`: they enqueue a reliable message but do not confirm
that a new client applied its bootstrap. Give bootstrap/checkpoint messages an id, acknowledge that
id from the client, and resend the same bounded message on a timer within an explicit attempt/time
limit. Do not mark a connection ready merely because `connection.streams.send()` returned. If the
limit expires, retire that connection from gameplay rather than retrying forever or giving an
uninitialized player a seat.

## Network Events

Client events expose:

```ts
interface NetworkEvent {
  readonly bytes: Uint8Array;
  readonly receivedAt: number;
  text(): string;
  json<T = unknown>(): T;
}
```

Server events also expose `connection`, the trusted Snack connection that sent the message.

`json<T>()` only decodes and casts. It does not validate the value. Decode to `unknown` and validate
before use.

`receivedAt` is a local receive timestamp. Do not treat it as a shared authoritative clock.

## Client API

Import:

```ts
import { client } from "snack:client";
```

Connection/runtime state:

- `client.launch: Promise<LaunchEnvelope>`
- `client.connection: Promise<Connection>`
- `client.ready: Promise<void>`
- `client.closed: Promise<void>`
- `client.net: NetStats`
- `client.datagrams: ClientDatagrams`
- `client.streams: ClientStreams`

`client.closed` is terminal for that page's client runtime. The current runtime does not reconnect
its WebTransport connection in place.

Send:

```ts
await client.datagrams.send({ v: 1, type: "input", seq: 42, moveX: 1 });
await client.streams.send({ v: 1, type: "play-card", commandId: "cmd-42", cardId: "ace-spades" });

const bytes = new Uint8Array([1, 2, 3]);
await client.datagrams.send(bytes);
```

The promise confirms local runtime/transport acceptance, not that the server applied the message.

Receive one message:

```ts
const event = await client.streams.recv();
const value: unknown = event.json();
```

Drain queued messages during a frame:

```ts
for (const event of client.datagrams.drain()) {
  const value: unknown = event.json();
  // Validate and apply.
}
```

Reuse an array to reduce allocations:

```ts
import type { DatagramEvent } from "snack:client";

const events: DatagramEvent[] = [];
events.length = 0;
client.datagrams.drainInto(events);
```

Async iteration:

```ts
for await (const event of client.streams) {
  const value: unknown = event.json();
}
```

Do not mix multiple independent consumers on the same queue unless the ownership and message
routing are explicit; one consumer may drain messages another expects.

## Disconnect And Rejoin

Use these terms precisely:

- **disconnect**: the current transport closes and `client.closed` resolves
- **rejoin**: a fresh shell/iframe launch creates a new transport and a new `connection.connectionId`
- **bootstrap**: the server sends the full recoverable state required by that new connection

Do not show an indefinite automatic “reconnecting” state; automatic in-place reconnect is not a
current `snack:client` capability. A relaunch may reach the same live game session, but games must
not assume it will. Hosted server state is in memory and is lost when that session ends.

Treat `connection.id` as one transport lifetime. A signed-in or selected local profile can rejoin
with the same trusted `userId`, but a local tab reload creates a new guest identity by default unless
the debug profile flow or `SNACK_DEV_PERSIST_GUEST_IDENTITY=true` preserves it. One `userId` may also
have multiple simultaneous connections, so each game must choose a policy: merge them into one
logical player, replace/reject an older connection, or treat every connection as a separate seat.

On a valid rejoin:

1. neutralize or remove input from the old connection
2. bind the new connection to the game's logical player/seat according to its policy
3. send a reliable bootstrap with instance/round identity and revision/tick
4. replace client state and clear old pending commands, snapshots, prediction/rollback histories,
   effects, timers, and listeners
5. deduplicate commands by match/round plus logical player plus command id, not by `connection.id`

Snack may reclaim an empty hosted session after a short platform-controlled grace period. Do not
hardcode that period into game rules or promise that the same match can always be resumed.

## Server API

Import:

```ts
import { server } from "snack:server";
```

Receive across all connections:

```ts
const event = await server.streams.recv();
const connection = event.connection;
const value: unknown = event.json();
```

Global channel methods:

```ts
server.datagrams.send(connectionId, payload);
server.datagrams.broadcast(payload);
server.datagrams.broadcast(payload, { only: [connectionId] });
server.datagrams.broadcast(payload, { except: [connectionId] });

server.streams.send(connectionId, payload);
server.streams.broadcast(payload);
server.streams.broadcast(payload, { only: [connectionId] });
server.streams.broadcast(payload, { except: [connectionId] });
```

Connection-scoped reply:

```ts
const event = await server.streams.recv();
event.connection.streams.send({ v: 1, type: "accepted" });
event.connection.datagrams.send({ v: 1, type: "correction", x: 10, y: 5 });
```

All server and per-connection channels support:

- `maxSize`
- `recv()`
- `drain()`
- `drainInto(target)`
- async iteration
- `send()`

`server.connections` is a read-only view of connected players. Each connection exposes:

- `id`: server-side connection id used by `send` and broadcast filters
- trusted `userId`, `userName`, and `isGuest`
- `connectedAt`
- `net` statistics
- connection-scoped `datagrams` and `streams`
- `close(reason?)` is present in the generated declaration, but the current creator runtime does not
  close the transport; do not rely on it for replacement, moderation, or input ownership

The server also exposes `config`, `running`, `sleep(ms)`, `elapsedMs()`, and `end()`. Call
`server.end()` after the game has reached its final state and clients have had a bounded opportunity
to receive the result. Hosted state is ephemeral; there is no creator persistence API or outbound
`fetch` capability today.

Server `send()` and `broadcast()` are fire-and-forget after validation/enqueue. They do not confirm
peer delivery or application processing.

## Datagram Semantics

Use datagrams when freshness matters more than guaranteed delivery:

- messages may be lost
- messages may arrive out of order
- messages may be duplicated
- a newer input/snapshot should normally supersede an older one

Include tick/sequence fields and reject stale data. Do not retry periodic state datagrams; send a
newer state.

## Reliable Stream Message Semantics

Use stream messages when data must arrive intact. Each `send` creates an independent reliable
message transfer. Messages from separate sends may complete out of order, so application code must:

- include sequence/revision fields and reject stale messages when apply order matters
- include command/event ids for idempotency
- send explicit acknowledgements/results when the sender needs proof of application
- bound retries and preserve the same id across retries

Reliable delivery does not make client claims trustworthy.

## Network Statistics

Client `client.net` and server `connection.net` expose:

```ts
interface NetStats {
  readonly rtt: number | null;
  readonly latestRtt: number | null;
  readonly jitter: number | null;
}
```

Use these for diagnostics and bounded presentation tuning. Keep correctness independent of a single
sample, and handle `null` before enough samples exist.

## Guardrails

- Use `snack:client` and `snack:server` only.
- Do not fetch `/connect-info` or create WebTransport/WebSocket plumbing.
- Validate all decoded client values before changing authority.
- Use Snack connection identity, never identity repeated in a client payload.
- Decide whether logical players are keyed by connection, user, or a game-owned seat; do not merge
  simultaneous connections accidentally.
- Keep one clear owner per receive queue.
- Bound queue draining, message size, per-connection rate, retries, and history.
- Use project-local generated types instead of copying this reference into source code.
