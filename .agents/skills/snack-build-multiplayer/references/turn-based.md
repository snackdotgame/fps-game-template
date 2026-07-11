# Build Turn-Based Snack Multiplayer

Use reliable stream messages for authoritative commands, results, and state. Optimize for
correctness, idempotency, and fresh-launch rejoin rather than latency hiding.

## Read First

Read:

- `AGENTS.md` and relevant client/server/shared source
- [Snack messaging API](messaging-api.md)
- [shared protocol rules](protocol-design.md)
- [binary protocol design](../../snack-design-binary-protocol/SKILL.md) for encoding, quantization,
  and the datagram budget
- [the worked example](turn-based-example.md) for a command/revision implementation

Use this reference only after this skill's selection flow chooses the turn-based/discrete path.

## Model Commands And State

Keep one authoritative state machine on the server:

- phase and turn owner
- monotonically increasing state `revision`
- legal actions for the current phase
- command ids for deduplication
- deterministic transition rules where practical
- a complete rejoin/bootstrap state

Clients send commands such as “play card,” “choose target,” or “end turn.” They do not send the
resulting score, ownership, next turn, or final state.

## Use Reliable Streams

Send commands with `client.streams.send()`. Receive them with `server.streams.recv()`. Reply through
`event.connection.streams.send()` or broadcast authoritative state with
`server.streams.broadcast()`.

Every command should include:

- protocol version
- command type
- stable `commandId`
- `expectedRevision` when acting on a specific state
- only the player choice needed by the server

Every result should include the command id and either:

- accepted authoritative state/revision
- structured rejection plus the current revision/state needed to recover

If a client retries, reuse the same command id. Cache or otherwise remember processed ids within a
bounded window so a duplicate cannot apply twice.

## Handle Ordering And Rejoin

- Reject or reconcile commands targeting a stale revision.
- Do not assume independently completed reliable messages imply game-level ordering; use revisions.
- Send a full current state on every new connection, including fresh-launch rejoin, before accepting
  commands that depend on it.
- Put an id on that bootstrap, require a client acknowledgement, and retry the same bootstrap within
  a bounded window; server stream send is not an application-level receipt. Unacknowledged
  connections must not own a turn.
- Decide explicitly whether one `userId` owns one logical seat, whether simultaneous connections
  share that seat, or whether the game assigns separate seat ids. Do not key independent players by
  `userId` accidentally.
- Keep private state targeted to the owning connection; broadcast only public state.
- Rebuild client UI from authoritative state rather than replaying UI history after rejoin.

Datagrams may be used for non-critical cursors, hover, or presence hints, but never for a turn or
inventory mutation that must arrive.

## Verify

Test:

- legal and illegal actions
- action by the wrong player/phase
- duplicate command id
- stale `expectedRevision`
- retry after delayed response
- disconnect during a turn
- fresh-launch rejoin/bootstrap
- two clients issuing commands close together

Run the `snack-playtest-game` workflow. Add latency/jitter; do not add datagram loss unless the game
also uses datagrams.
