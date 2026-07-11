# Text Chat Protocol And Routing

## Define Modes Before Messages

For each chat mode, write down:

- who may send;
- which authoritative game state determines membership;
- who receives it;
- whether spectators, eliminated players, bots, or reconnecting players participate;
- whether history exists and where it is bounded;
- how server-authored system messages are distinguished.

Global, team, party, proximity, lobby, spectator, direct, and system messages should not collapse
into one client-controlled `channel` string with no server policy.

## Validate Client Requests

Let the client request a supported mode and provide text. The server must validate the payload and
derive the final route. A `team` field does not prove team membership, and a list of connection ids
from the client must never become the recipient list.

Use trusted `message.connection.userId` to look up authoritative membership. Convert the selected
users to current `server.connections` ids at send time. Decide explicitly how multiple simultaneous
connections for one user behave: all active connections, newest connection only, or one logical
seat chosen by the game.

Give every membership map a logical lifetime. For match-roster membership keyed by `userId`, remove
the entry when the player actually leaves the match or when the match ends, not merely when one of
that user's connections drops. A fresh connection can then derive the same bounded roster
membership from its trusted `userId`. Connection- or seat-scoped membership instead needs explicit
replacement and cleanup rules.

Use `only: []` to send to nobody. With neither `only` nor `except`, a send targets every current
connection. Avoid treating an empty derived team as a reason to fall back to global chat.

## Preserve Attribution

Relay the received `ServerChatMessage`, not a new object containing its payload. Snack attaches
private provenance to that object so recipients see the trusted player sender. A raw send is
correct only for server-authored content such as round announcements or errors.

Do not accept `userId`, `userName`, role, badge, moderator, or guest status from the chat payload as
trusted identity. Render `ChatMessage.sender` and `source` on the client.

## Bound State

Bound:

- retained message history per channel;
- message ids kept for deduplication;
- local mute sets and channel subscriptions;
- pending application acknowledgements;
- system notification queues;
- persistence batches and logs when the game owns them.

Use `messageId` to deduplicate delivered messages. Use `sequence` for stable order, but never wait
for missing values because recipient filtering and bounded queues create valid gaps.

## Policy And Moderation Boundary

Snack owns transport validation, rate limiting, trusted attribution, and the host delivery point
where platform communication policy can apply. The generated creator API does not currently expose
platform report, block, moderation, audit, or history operations.

A game may implement a local presentation mute, game-specific channel permission, or server rule
for its own mode. Name those features accurately. Do not reveal, infer, or compensate for
recipients that opaque platform policy excludes.

## Lifecycle

Give one loop ownership of `server.chat` and one loop ownership of `client.chat`. Route messages
internally from those owners rather than starting competing receivers in multiple UI components or
game systems.

When `client.closed` settles, the connection and its chat lane are terminal. Stop the loop and
clear connection-scoped pending state. A fresh launch gets a new connection id and must rebuild any
game-owned channel or seat association from trusted identity.

Do not automatically resend unacknowledged text on reconnect. The previous host may have accepted
it. If delivery confirmation is essential, add a bounded idempotent protocol with a client-generated
logical id inside the validated payload and explicit server acknowledgement semantics.
