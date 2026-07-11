# Scripted Gameplay Tests

## Contents

- Purpose and scope
- Observable contract
- Input scripts
- Multiplayer scenarios
- Metrics
- Difficulty and fairness
- Failure and cleanup
- Reporting

## Purpose And Scope

Use a scripted playtest to prove that the game advances under repeatable player actions. A visual
test shows composition; a scripted playtest shows that inputs, rules, objectives, failure, and retry
remain connected.

Prefer real keyboard, pointer, touch, or gamepad-like browser input. Use project-owned hooks for
read-only observations, deterministic cosmetic setup, or actions a normal player can perform only
through complex spatial UI. Do not use hooks to manufacture success or bypass authoritative rules.

## Observable Contract

Expose bounded development/test diagnostics when repeatable assertions need them:

```ts
export interface SnackPlaytestSnapshot {
  frame: number;
  phase: string;
  localPlayerId: string | null;
  position?: Readonly<{ x: number; y: number; z?: number }>;
  score?: number;
  objectiveProgress?: number;
  failed?: boolean;
  completed?: boolean;
}

declare global {
  interface Window {
    __SNACK_PLAYTEST_SNAPSHOT__?: () => SnackPlaytestSnapshot;
  }
}
```

Return copies rather than mutable internals. Gate the function to test/development builds. Do not
include credentials, signed tickets, private opponent data, or a mutation surface.

For turn-based games, observe revision, phase, active actor, legal-action summary, and result. For
real-time games, observe frame/tick progress, local position, objective/score, and fail/complete
state. Avoid exposing the entire authoritative state when a smaller contract suffices.

## Input Scripts

Model a naive but valid player path:

- start or ready
- exercise the primary verb
- make objective progress
- trigger or avoid pressure
- cause at least one meaningful state transition
- reach failure or completion when the game supports it
- retry, continue, or rematch

Use game-specific scripts. A lane game may hold forward and change lanes; a board game may choose
legal moves; a party game may ready two profiles and submit simultaneous choices. Record the seed
and action timing.

Do not assert only that a frame counter changes. Require a player-facing outcome such as movement,
score, objective progress, turn revision, damage, failure, or round completion.

## Multiplayer Scenarios

Launch through the Snack host shell with distinct local profiles. Cover:

- both players join and become distinguishable
- ready/start or first-turn selection
- each player performs an action that affects shared state
- clients converge on the same authoritative revision/tick/outcome
- one player leaves, reloads, or rejoins through a fresh launch while another continues
- invalid or impossible input is rejected
- round end and rematch/restart replace old state cleanly

Add the selected network conditions: latency, jitter, and datagram loss only where datagrams are
used. Reliable stream tests should expect delay/backpressure rather than disappearance.

## Metrics

Choose metrics that explain the loop:

- frames or authoritative ticks advanced
- time/input steps to first meaningful action and first progress
- score/objective delta
- turns or revisions completed
- distance or zones traversed
- hits, pickups, builds, captures, or valid commands
- failure/completion/rematch reached
- stalled windows where time advances but input produces no movement or progress
- corrections, rejoin duration, duplicate events, or divergent revisions
- console, terminal, protocol, and page errors

Keep absolute counts and durations. A ratio without scale can hide a test that advanced only a few
frames or performed one command.

## Difficulty And Fairness

When tuning difficulty, run at least two intentionally different strategies or reaction cadences.
Compare time-to-progress, score, survival, resource use, and failure cause.

For competitive games, swap side, spawn, player order, team, and input profile when relevant. Under
network simulation, test whether one role gains a systematic advantage. Do not interpret a scripted
bot as human fun evidence; use it to detect broken, unreachable, trivial, unfair, or softlocked
states.

## Failure And Cleanup

Test a path that intentionally fails or violates a rule:

- collide with or accept a hazard
- submit an illegal turn command
- allow a timeout
- disconnect during an important transition
- exceed a bounded input or message condition in a safe local test

Assert that the failure is understandable and that retry/rejoin restores a playable state.
Inspect players, connections, entities, histories, timers, listeners, effects, and pending promises
after repeated runs.

## Reporting

Report:

```text
Scripted playtest: added / extended / run / skipped
Profiles and seed:
Input script:
Network conditions:
Assertions:
Metrics:
Failure/retry result:
Rejoin result:
Errors:
Artifacts:
Limitations:
```

If skipped for a release-ready claim, give a concrete reason and list the manual evidence that
covers the risk instead.
