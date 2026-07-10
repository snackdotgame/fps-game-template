---
name: snack-build-text-chat
description: Use when adding or changing human-visible text chat, team or proximity chat, lobby or spectator chat, server system messages, chat payloads, recipient routing, trusted sender attribution, mute behavior, or chat lifecycle in a Snack.Game project using client.chat and server.chat.
---

# Build Snack Text Chat

Implement human-visible player communication on Snack's dedicated chat lane. Keep player identity,
membership, recipients, and policy enforcement authoritative instead of rebuilding chat with
gameplay datagrams or creator streams.

## Read First

Read:

- `AGENTS.md`
- `src/client.ts`
- `src/server.ts`
- the relevant files under `src/shared/`
- `.snack/types/client.d.ts`
- `.snack/types/server.d.ts`

If the generated declarations do not expose `client.chat` and `server.chat`, update the
project-local Snack CLI dependency, commit or stash project changes, and run
`snack scaffold upgrade`.

Read [references/chat-api.md](references/chat-api.md) before using the platform API. Read
[references/protocol-and-routing.md](references/protocol-and-routing.md) when defining payloads,
channels, recipient selection, or lifecycle policy. Start from
[references/example.md](references/example.md) for a complete global/team chat implementation.

## Workflow

1. Define which human-visible communication modes exist: global, team, proximity, lobby,
   spectator, direct, and server-authored system messages have different authority and recipient
   rules.
2. Define a small discriminated payload schema in `src/shared/`. Use type aliases, validate every
   field plus total text and encoded structured size on the server, and keep identity, recipient
   ids, permissions, and trusted membership out of client-authored data.
3. Send player text with `client.chat.send()`. Treat resolution as completion of the local reliable
   write, not proof that the server accepted or delivered the message.
4. Receive through one owner of `server.chat`. Relay the received `ServerChatMessage` object to
   preserve Snack's trusted player attribution. Passing only its payload would create a
   server-authored message.
5. Derive recipients from authoritative game state and current server connections. Use `only` or
   `except` on `server.chat.send()`; never let browser payloads supply final recipient ids.
6. Receive host-delivered messages through one owner of `client.chat`. Use Snack's `sender`,
   `source`, `messageId`, `sequence`, and timestamps rather than payload identity fields.
7. Bound chat history, deduplication state, channel state, mutes, notifications, logs, and any
   persistence owned by the game. Give authoritative membership an explicit logical-player,
   connection, seat, or match lifetime. Stop the current chat loop when `client.closed` settles and
   let a fresh Snack launch create a new connection.
8. Test global, restricted-channel, and system messages through the Snack host shell with multiple
   players, rapid sends, invalid payloads, long text, simultaneous connections, and disconnects.

## Platform Boundaries

- Use `client.chat` and `server.chat` for human-visible communication so Snack can validate,
  rate-limit, attribute, and apply host communication policy at one boundary.
- Use creator reliable streams for must-arrive gameplay commands and datagrams for superseding
  low-latency state. Do not bypass chat controls by carrying player conversation there.
- Browser code sends only to the authoritative server and cannot choose recipients.
- Raw `server.chat.send(payload)` is server-authored. Relaying a received `ServerChatMessage`
  preserves host-owned player attribution.
- Use `client.chat.maxTextLength`, `client.chat.maxStructuredPayloadBytes`, and their server
  equivalents rather than hard-coding platform limits. A game may enforce smaller semantic limits.
- Do not invent platform moderation, block, report, audit, history, or persistence APIs. Game-owned
  channels and local presentation mutes are allowed, but label them accurately and do not infer
  recipients removed by opaque platform policy.
- Do not retry a send blindly. The server may have accepted the original even though the client
  lacks an application acknowledgement. Add a separate idempotent acknowledgement protocol only
  when the product genuinely requires delivery confirmation.

## UI Boundary

This skill owns text-chat transport, message semantics, trust, routing, policy boundaries, and
lifecycle. If the task also includes the chat interface, use `snack-design-game-ux` for layout,
controls, focus, accessibility, and responsive behavior. At the boundary, pass structured accepted
messages to the presentation layer, render text through `textContent` or framework text nodes, and
never trust or inject payload HTML.

## Validation

Run the project-owned checks:

```sh
<package-manager> run check
<package-manager> run build
```

Then test through `http://127.0.0.1:3030/`, not the Vite-only port. Verify trusted attribution,
server-owned channel membership, player and server message sources, bounded state, invalid payload
rejection, send failure behavior, and terminal closure with at least two clients.
