# Build Server-Side Lag Compensation

Validate an action against a bounded historical view of authoritative targets. Keep the current live
simulation unchanged and let the server decide the result.

## Read First

Read:

- this skill's selection flow and the selected primary approach reference
- `src/client.ts`, `src/server.ts`, and the shared message definitions
- [binary protocol design](../../snack-design-binary-protocol/SKILL.md) for encoding, quantization,
  and the datagram budget
- generated `snack:client` and `snack:server` types
- [the worked example](lag-compensation-example.md) for a strict TypeScript hitscan example

Use lag compensation in addition to snapshots, prediction, or rollback. Do not select it for every
game merely because latency exists.

## Decide Whether It Applies

Use bounded historical validation when:

- the action is effectively instant, such as a hitscan shot or short melee trace
- moving targets make current-state-only validation unfair at ordinary latency
- the server has authoritative target transforms/hitboxes and a synchronized tick history

Usually do not rewind:

- slow projectiles whose authoritative travel can be simulated normally
- area effects with explicit server timing
- turn-based or command games
- client-reported damage, targets, collision results, or hit lists

## Record Authoritative History

Store a bounded ring of historical hit-test state keyed by server tick/time. Record only the data
needed for validation: target identity/generation, position, orientation, and simple hitboxes.

- keep enough history for the maximum allowed rewind plus jitter margin
- use the same authoritative transforms that governed gameplay at that tick
- remove recycled entities by generation, not only id
- bound memory and work independently of client requests

## Validate A Request

The client sends intent: round id, command id, the actual delayed `viewTick` used to render remote
targets, origin, and direction. It never sends the hit result. Wire the view tick from the primary
snapshot/interpolation presentation path; the newest received tick is not what the player saw.

The server must:

1. validate command shape, rate, weapon state, ammo, cooldown, and current match phase
2. derive the maximum rewind from the server-known interpolation-delay bound, trusted connection
   RTT/jitter, and a hard game cap
3. clamp the requested tick to retained history and reject future/excessively old requests
4. validate the claimed origin against the shooter's historical pose
5. query historical target hitboxes without mutating the live world
6. apply damage once to current authoritative state and return a deduplicated result

Do not compensate unlimited latency. Prefer a slightly late miss over giving a high-latency player a
large window to shoot targets far behind current cover.

## Preserve Fairness

- rewind targets and relevant moving cover consistently
- never rewind only the victim while leaving cover at its current pose
- exclude the shooter's client-selected target or hit point from authority
- define how simultaneous death, invulnerability, spawn protection, and already-dead targets behave
- use current authoritative ammo/cooldown even when geometry is checked historically
- key deduplication by match/round plus logical player plus command id across fresh connections
- select one active connection per logical player and permanently ignore superseded connection ids;
  the current `Connection.close()` declaration does not enforce this policy for creator code
- batch high-rate reliable results or repeat compact result ids in authoritative snapshots; do not
  create a separate stream message for every automatic-weapon shot
- route result batches through the primary netcode's single reliable receive owner rather than
  starting a second iterator over `client.streams`
- keep the primary interpolation path's stale-group timeout inside retained rewind history, so one
  missing group cannot freeze the common `viewTick` until otherwise valid shots become too old

## Verify

Test at several fixed RTT/jitter values with both shooter and target perspectives. Include current
state, ordinary compensated hits, shots outside the rewind cap, cover transitions, duplicate fire
commands, disconnect/fresh-launch rejoin, clock/tick skew, and the same encounter with player roles
swapped.

Report the history duration, tick rate, rewind formula/cap, hitbox representation, cover policy,
command/result channel, deduplication key, and fairness tradeoffs.
