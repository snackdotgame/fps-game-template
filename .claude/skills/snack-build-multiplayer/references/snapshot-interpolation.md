# Build Snapshot And Interpolation Netcode

Run the real simulation only on the server. Send periodic authoritative snapshots and render remote
state from a short interpolation buffer.

## Read First

Read:

- [Snack messaging API](messaging-api.md)
- [shared protocol rules](protocol-design.md)
- [binary protocol design](../../snack-design-binary-protocol/SKILL.md) for encoding, quantization,
  and the datagram budget
- [the worked example](snapshot-interpolation-example.md)
- current client/server/shared code and generated Snack types

Use this reference after this skill's selection flow chooses snapshot synchronization, especially when the
simulation cannot replay deterministically.

## Design The State Flow

Client to server:

- send input intent, not resulting position/velocity/hits
- use sequenced datagrams for frequent input
- use reliable streams for infrequent commands that must arrive

Server:

- validate input and apply it to authoritative state
- advance the only real simulation
- attach a monotonic `tick` and server time to snapshots
- keep each encoded datagram under a conservative 1000-byte path-MTU budget
- split snapshots into independently useful replacement groups, compact deltas, or interest groups
  rather than making every tick depend on every full-world chunk arriving
- send complete or recoverable state often enough for the game
- send bootstrap/checkpoint state reliably on initial join or fresh-launch rejoin

Client:

- order snapshots by tick and reject stale/duplicate data
- keep a bounded interpolation buffer
- advance a monotonic estimated server/render clock from local receipt time between packet arrivals;
  do not derive the render target only from the newest packet timestamp or let changing transit
  delay move it backward
- render remote entities between two authoritative samples
- apply discrete events once using ids/revisions
- extrapolate only briefly and only where acceptable

## Tune Rates Deliberately

Choose separately:

- server simulation rate
- client input sample/send rate
- snapshot send rate
- interpolation delay

Do not tie all rates to rendering FPS. Start with a conservative snapshot rate and an interpolation
delay large enough to absorb ordinary jitter, then profile bandwidth and feel.

Use `client.net.jitter` only for bounded, gradual adaptation. Do not let one sample resize buffers
without limits or abruptly move the render timeline.

## Non-Deterministic Simulations

For browser physics, variable floating-point systems, third-party engines, or other simulations
that do not replay exactly:

- do not rewind and re-simulate the whole world on the client
- do not call visual correction “rollback”
- treat snapshots as authority
- interpolate remote state
- optionally predict cosmetic effects or a narrow local controller
- use [client prediction](client-prediction.md) only for a subsystem with a defined correction path

## Recover

- Send a reliable full bootstrap/checkpoint on every new connection, including a fresh-launch rejoin.
- Give it an id, retry within a bounded window until the client acknowledges applying or
  superseding it, and retire an unacknowledged connection when the window expires.
- Keep a new connection provisional until that acknowledgement. Do not add a new authoritative
  player or include the connection in high-rate broadcasts before it is ready.
- Make later snapshots self-sufficient or periodically send full state so one lost delta cannot
  break the client indefinitely.
- Remove entities by explicit generation/tombstone or by complete-snapshot membership rules.
- Use stable replacement-group ids. Do not repartition entities by current encoded size in a way
  that moves them between groups under loss.
- Lease continuous input on the server and send current intent periodically; neutralize on focus or
  visibility loss so one lost release packet cannot hold movement forever.
- Bound snapshot count, age, entity count, and extrapolation duration.
- When lag compensation consumes the common rendered tick, hide an unhealthy replacement group
  before it can hold that tick beyond the server's retained rewind history.
- Reset buffers on server instance/version change.

## Verify

Test with `snack-playtest-game`:

- two or more players
- no latency/loss baseline
- latency and high jitter
- datagram loss and reordering
- long gaps followed by recovery
- fresh-launch rejoin/bootstrap
- server reload
- long-session buffer bounds

Confirm server authority remains correct even when interpolation looks imperfect.
