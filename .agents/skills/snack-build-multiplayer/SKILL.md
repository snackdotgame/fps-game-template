---
name: snack-build-multiplayer
description: Select the multiplayer and netcode architecture for a generated Snack.Game project. Use before implementing turn-based commands, authoritative state synchronization, snapshot interpolation, client prediction and reconciliation, deterministic rollback, shooter lag compensation, message encoding, or datagram versus reliable-stream transport.
---

# Choose A Snack.Game Multiplayer Approach

Route each gameplay subsystem to the simplest networking model that meets its latency and
correctness requirements. Do not begin with prediction or rollback by default.

## Read First

Read:

- `AGENTS.md` and `snack.json`
- `src/client.ts`, `src/server.ts`, and relevant `src/shared/*`
- `.snack/types/client.d.ts` and `.snack/types/server.d.ts`
- [references/messaging-api.md](references/messaging-api.md) for the exact Snack send/receive APIs

Keep the server authoritative regardless of the selected presentation technique. Treat client
messages as untrusted input.

## Select Per Subsystem

Different parts of one game may choose different paths. For example, use reliable streams for
lobby/turn/match events and datagrams plus interpolation for movement.

```mermaid
flowchart TD
  A["Start with one gameplay subsystem"] --> B{"Can every action wait for a server round trip?"}
  B -- "Yes: turns, cards, board moves, menus" --> T["Use snack-multiplayer-turn-based"]
  B -- "No" --> C{"Is state continuous and frequently changing?"}
  C -- "No: sparse authoritative commands/events" --> T
  C -- "Yes" --> D{"Does only remote state need smoothing?"}
  D -- "Yes" --> S["Use snack-multiplayer-snapshot-interpolation"]
  D -- "Local input must feel immediate" --> E{"Can the predicted local subsystem replay from saved input?"}
  E -- "No: non-deterministic physics/gameplay" --> N["Use snapshots; optionally animate a non-authoritative presentation proxy"]
  E -- "Yes" --> F{"Must late input rewind the wider simulation?"}
  F -- "No: correct only the local predicted state" --> P["Use snack-multiplayer-client-prediction"]
  F -- "Yes" --> G{"Is the relevant simulation deterministic, fixed-step, and serializable?"}
  G -- "No" --> P2["Use client prediction plus authoritative correction; do not claim rollback"]
  G -- "Yes" --> R["Use snack-multiplayer-rollback"]
```

For a non-deterministic real-time game that also needs immediate local response, use snapshot
interpolation as the correctness architecture. Optionally animate a narrow, non-authoritative
presentation proxy: visual feedback or a simple kinematic transform that is corrected to authority
and is never fed into physics, collision, hits, or game state. Do not select client prediction alone
for an opaque non-deterministic world.

Then select any additional server validation technique:

```mermaid
flowchart TD
  A["Does the server validate latency-sensitive actions against moving targets?"] --> B{"Would current-state-only validation unfairly penalize normal latency?"}
  B -- "No" --> C["Use current authoritative state"]
  B -- "Yes: hitscan shots or similar instant actions" --> L["Also use snack-multiplayer-lag-compensation"]
```

Lag compensation is server-side historical validation, not a replacement for snapshots, prediction,
or rollback. Projectile travel, movement, score, ammo, and cooldowns remain authoritative under the
game's primary approach.

## Approach Skills

| Approach                                                                                           | Use when                                                                                          | Typical channels                                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`snack-multiplayer-turn-based`](../snack-multiplayer-turn-based/SKILL.md)                         | Actions can wait for authority; state changes are discrete.                                       | Reliable streams for commands and results/state.                               |
| [`snack-multiplayer-snapshot-interpolation`](../snack-multiplayer-snapshot-interpolation/SKILL.md) | A non-deterministic or continuous authoritative simulation needs smooth remote presentation.      | Datagrams for inputs/snapshots; streams for bootstrap and critical events.     |
| [`snack-multiplayer-client-prediction`](../snack-multiplayer-client-prediction/SKILL.md)           | Local controls must react immediately and a limited local subsystem can be replayed or corrected. | Datagrams for inputs/snapshots; streams for bootstrap and critical events.     |
| [`snack-multiplayer-rollback`](../snack-multiplayer-rollback/SKILL.md)                             | Late inputs must change past simulation and the relevant simulation is provably deterministic.    | Datagrams for tick inputs/frames; streams for checkpoints and critical events. |
| [`snack-multiplayer-lag-compensation`](../snack-multiplayer-lag-compensation/SKILL.md)             | The server must fairly validate instant actions against recent authoritative target history.      | Datagram or stream input according to frequency; authoritative result events.  |

Load only the selected approach skills. A game may load more than one when separate subsystems have
different requirements.

## Choose The Channel

```mermaid
flowchart TD
  A["One message family"] --> B{"Must every message arrive?"}
  B -- "Yes" --> S["Reliable stream"]
  B -- "No" --> C{"Does a newer message supersede an older one?"}
  C -- "Yes" --> D["Datagram"]
  C -- "No or uncertain" --> S
```

- Use streams for turns, commands, acknowledgements, bootstrap state, inventory, match start/end,
  and other must-arrive events.
- Use datagrams for frequent input samples, transforms, and snapshots where late data is less useful
  than newer data.
- Keep encoded Internet datagrams within a conservative 1,000-byte budget; `maxSize` is only the
  Snack validation ceiling.
- Add application sequence, acknowledgement, idempotency, and ordering rules when game semantics
  require them; transport delivery alone is not enough.
- Give each receive queue one owner. When combining leaf examples, merge their parsers into one
  client/server router per channel; two async iterators or drain loops can consume each other's
  messages.

Read [references/protocol-design.md](references/protocol-design.md) when defining message shapes,
validation, JSON/binary encoding, retries, or ordering.

## Record The Decision

Before implementation, state:

- authority and trust boundary
- acceptable input-to-feedback latency
- deterministic versus non-deterministic simulation boundary
- selected approach per subsystem
- datagram versus stream choice per message family
- required sequence, tick, revision, acknowledgement, and idempotency fields
- bootstrap, disconnect, fresh-launch rejoin, and recovery behavior
- network conditions that must pass

If determinism is uncertain, select snapshots or limited prediction first. Prove deterministic
replay with tests before selecting rollback.
