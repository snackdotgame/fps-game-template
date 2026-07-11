# Game And Level Design

## Contents

- Design brief
- Core loop
- Multiplayer contract
- Level and encounter plan
- Difficulty and pacing
- Genre prompts
- Rejection tests
- Implementation handoff

## Design Brief

Write a compact brief before broad implementation:

| Question         | Required answer                                   |
| ---------------- | ------------------------------------------------- |
| Player promise   | What fantasy can the player actually perform?     |
| Target feeling   | What should moment-to-moment play feel like?      |
| Primary verb     | What action defines the game?                     |
| Secondary verbs  | Which actions create mastery or variety?          |
| Objective        | What visible state is the player trying to reach? |
| Pressure         | What makes delay, mistakes, or choices matter?    |
| Reward           | What changes after success?                       |
| Failure          | What state ends or sets back the attempt?         |
| Skill expression | What does a stronger player do differently?       |
| Readability      | How does the player recognize the next decision?  |
| Non-goals        | What will this slice intentionally omit?          |

Reject a brief that describes only a setting, visual theme, or explorable scene. Require decisions,
consequences, and a repeatable interaction.

## Core Loop

Express the short loop in one sentence:

```text
Use [primary verb] to reach [objective] while [pressure] creates risk; success grants [reward], and
failure leads to [setback or retry].
```

Prove each clause:

- map the verb to real input intent
- make the objective visible in the world or interface
- introduce pressure before the first session becomes passive
- change authoritative game state when a reward is earned
- explain failure through visible state and feedback
- return to a meaningful decision quickly after failure

Define a longer progression loop only after the short loop works. Progression can add choices,
rules, spaces, abilities, opponents, or strategic tradeoffs; avoid making it only a rising number.

## Multiplayer Contract

Answer before adding networked mechanics:

- Is the player relationship cooperative, competitive, team-based, asymmetric, or indirectly
  shared?
- What can one player do that changes another player's decision?
- Which actions require immediate local feedback, and which can wait for authority?
- Which rules, clocks, collisions, scores, inventories, and outcomes does the server own?
- What happens when a player joins late, leaves, disconnects, returns through a fresh launch, or
  stops sending input?
- Can a match continue with fewer players? Does a bot, timeout, pause, or forfeit rule apply?
- What is public to every player, private to one player, or hidden until reveal?
- Which messages must be reliable and ordered? Which replace older state?

Use `snack-build-multiplayer` to choose the netcode architecture. Do not choose client-side physics
or prediction because it is convenient for rendering. If the project has no selected approach,
finish the player-facing latency, state-frequency, determinism, replay, and rewind requirements in
this design pass, then route them through the multiplayer flowchart before specifying transport
cadence or correction behavior.

For social or party games, define waiting-room, ready, start, round, score, intermission, and final
states explicitly. For competitive games, define tie, timeout, disconnect, rematch, and invalid-action
rules before polishing presentation.

## Level And Encounter Plan

For each arena, track, map, wave, round, puzzle, board, or course, define:

- spatial or logical format
- camera and information contract
- player start and first safe observation
- first meaningful decision
- first threat and first reward
- landmarks, routes, lanes, zones, or board regions
- optional risk/reward choice
- escalation and recovery beats
- failure telegraphs and escape/defense options
- reusable, parameterized, or randomized pieces
- multiplayer spawn fairness and contested resources

Greybox first. Use simple geometry or placeholder UI to verify scale, traversal time, sight lines,
collision, timing, route choice, and network behavior before producing expensive assets.

For a real-time arena, test all spawn points against immediate line-of-sight threats and escape
routes. For a turn-based board, test legal-move clarity and whether hidden information leaks. For a
cooperative encounter, ensure players have complementary decisions rather than merely attacking the
same health bar.

## Difficulty And Pacing

Introduce one concept, then test it in combination with known concepts. Increase challenge through
specific tuning dimensions:

- timing windows
- speed or cadence
- spatial restriction
- opponent composition
- resource pressure
- information uncertainty
- coordination demand
- risk/reward exposure

Add recovery after sustained pressure. Keep early mistakes recoverable unless harsh failure is part
of the stated promise. Store tuning values under clear names and change one family at a time during
playtests.

For multiplayer balance, test advantage by spawn, side, team size, latency, input device, and player
order. Compare absolute outcomes as well as win ratios; a small ratio can hide a large difference in
time-to-score or control.

## Genre Prompts

Use only the prompts relevant to the project:

- **Action arena:** telegraphs, punish windows, mobility options, target selection, off-screen
  threats, and phase escalation.
- **Racer:** handling promise, readable route, recovery width, overtaking decisions, shortcuts, and
  collision policy.
- **Shooter or dogfight:** engagement distance, aiming affordance, projectile travel, escape,
  reacquisition, and spawn safety.
- **Tower defense:** path topology, build tradeoffs, economy cadence, tower roles, enemy tells, and
  wave composition.
- **Board or card game:** legal actions, turn ownership, hidden information, revision history,
  timeout, undo policy, and rejoin reconstruction.
- **Physics sport:** aim, force, spin, legal-target feedback, foul state, reset, and authoritative
  simulation boundary.
- **Puzzle:** rule taught, confirmation, twist, failure information, and reset cost.
- **Party game:** instruction time, simultaneous comprehension, round duration, elimination/waiting,
  spectators, catch-up, and rematch cadence.

## Rejection Tests

Iterate when any statement is true:

- The opening contains no meaningful decision.
- The primary mechanic can be ignored while still progressing.
- The objective requires reading source code or a long explanation.
- Failure arrives before its cause can be understood.
- Difficulty adds volume without creating new decisions.
- Rewards change only decoration or an unused number.
- The space does not affect strategy, movement, or information.
- Multiplayer players coexist but do not meaningfully interact.
- A disconnected or late player permanently corrupts the round.
- The game sounds enjoyable in a design description but is passive in active play.

## Implementation Handoff

Before coding, record:

- design brief and non-goals
- core and progression loops
- authoritative rule/state diagram
- level or encounter plan
- multiplayer lifecycle and information visibility
- named tuning constants
- first playable acceptance tests

Keep the document small enough to update after real play. Treat playtest evidence as authority over
the initial design hypothesis.
