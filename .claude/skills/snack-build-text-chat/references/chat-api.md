# Snack Chat API

Use the generated declarations in `.snack/types` as the exact source of truth. This reference
summarizes the behavior needed for human-visible text chat.

## Client API

`client.chat` is an async iterable and exposes:

- `maxTextLength`: maximum total Unicode code-point count across the payload's string values.
- `maxStructuredPayloadBytes`: maximum encoded size for a JSON-object payload.
- `send(payload)`: sends a string or JSON object to the authoritative creator server. The promise
  resolves after the local reliable write, not after server acceptance or peer delivery.
- `recv()`: awaits the next host-delivered `ChatMessage`.
- `drain()` and `drainInto(target)`: consume currently queued messages without waiting.

A delivered `ChatMessage` contains:

- `messageId`: host-owned identity for deduplication.
- `sequence`: host-owned delivery ordering metadata.
- `source`: `"player"` or `"server"`.
- `sender`: trusted player identity for player messages, otherwise `null`.
- `payload`: a frozen string or JSON object.
- `sentAt` and `deliveredAt`: host-owned Unix millisecond timestamps.

The browser queue is bounded and may discard the oldest unread chat under pressure. Recipient
filtering also creates sequence gaps. Sort retained messages by `sequence` when stable host order
matters, deduplicate by `messageId`, and never wait for a missing sequence.

## Server API

`server.chat` is an async iterable and exposes:

- `maxTextLength` and `maxStructuredPayloadBytes`.
- `recv()`: awaits the next validated player-authored `ServerChatMessage`.
- `drain()` and `drainInto(target)`: consume currently queued player chat.
- `send(payloadOrMessage, options?)`: sends server-authored chat from a raw payload, or relays a
  received message with trusted player attribution.

`options.only` is an allowlist of connection ids. `options.except` excludes connection ids. With
neither, the message targets all current connections. Only server code may select recipients.

Passing a received `ServerChatMessage` back to `send()` preserves host-owned player attribution.
Copying its payload into a raw send changes the source to server-authored. Relays must happen while
the message remains inside Snack's bounded attribution window; expired relays are dropped rather
than mislabeled.

## Payload Shape

Chat payloads are strings or JSON objects. Arrays are not top-level chat payloads. Prefer a small
discriminated type alias when the game needs channel requests or presentation variants:

```ts
type GameChatPayload =
  | { type: "chat"; channel: "global" | "team"; text: string }
  | { type: "system"; text: string };
```

Use type aliases rather than interfaces so objects remain assignable to Snack's recursive JSON
shape. Validate discriminants, allowed channels, string content, total text code points, encoded
JSON size, and game-specific limits on the authoritative server. Check structured payloads against
both `maxTextLength` and `maxStructuredPayloadBytes`; a short scalar count can still encode to too
many bytes. Treat identity, final recipient ids, permissions, team membership, and moderation
decisions as host/server data, not client payload fields.

## Reliability And Ordering

Chat travels on a dedicated reliable lane, separate from creator streams and datagrams. Reliable
transport does not make `client.chat.send()` an application acknowledgement. The client write may
complete before host validation, rate limiting, recipient policy, or creator-server routing.

Host `messageId` and `sequence` describe delivered messages. Gaps are valid when a message targeted
someone else or a bounded queue dropped old unread work. Do not stall waiting for contiguous
sequence values. Add an explicit game-level acknowledgement only when the product needs it, and
make retries idempotent.

## Upgrade And Closure

Projects created before the chat API must update their project-local Snack CLI dependency and run
`snack scaffold upgrade` from a clean Git worktree. This refreshes the embedded client runtime and
generated declarations.

`client.closed` is terminal for the current launch. Stop send/receive work, show an unavailable or
disconnected state, and let the Snack launch flow create a fresh connection. Do not construct
WebTransport or reconnect the chat lane directly.

## Channel Choice

Use `client.chat` and `server.chat` only for human-visible communication. Use reliable creator
streams for must-arrive gameplay commands and datagrams for superseding low-latency state. Do not
reimplement text chat on those channels to bypass validation, attribution, rate limiting, or host
communication policy.
