---
name: snack-design-gameplay
description: Design and implement the playable game loop for a generated Snack.Game project. Use when defining or changing mechanics, objectives, scoring, levels, arenas, waves, encounters, difficulty, progression, failure and retry, game feel, feedback, or the first playable slice before visual polish or publishing.
---

# Design Snack.Game Gameplay

Turn a game idea into a small, testable player-facing contract before expanding its systems or art.
Keep authoritative rules separate from local presentation and prove the core loop with real players.

## Inspect The Project

Read:

- `AGENTS.md`, `snack.json`, and `package.json`
- the client, server, and shared entrypoints
- the selected multiplayer approach skill when the game is networked
- current controls, rules, state transitions, levels, UI, and tests

Identify what the server owns, what the client presents, and which mechanics already work through
the real Snack launch path.

## Write The Playable Contract

Before broad implementation, define:

- player promise and target feeling
- primary and secondary verbs
- 5–30 second core loop
- objective, pressure, reward, and failure
- skill expression and meaningful player decisions
- multiplayer interaction: cooperation, competition, interference, or shared goals
- first-session learning path and fast retry behavior
- explicit non-goals for the current slice

Read [references/game-design.md](references/game-design.md) for the design brief, level/encounter
planning, pacing, multiplayer questions, and rejection tests.

## Implement A Playable Slice

Build in player-visible increments:

1. input intent
2. authoritative rule or state transition
3. client presentation
4. objective or pressure
5. success/failure feedback
6. restart or next-round path

Do not build a decorative scene and add rules later. Greybox spaces and placeholder art are valid
when they prove scale, route, timing, readability, and player decisions.

For multiplayer games:

- keep score, damage, inventory, collision outcomes, timers, and match results authoritative
- do not let visual effects or local hitstop pause the server simulation
- make join, leave, disconnect, fresh-launch rejoin, and temporarily missing input part of the rules
- separate deterministic simulation state from non-deterministic presentation
- if no netcode is selected, define acceptable feedback latency, state frequency, replayability,
  determinism, and rewind needs, then use `snack-build-multiplayer` to select it
- use the selected Snack multiplayer leaf skill for transport, prediction, snapshots, or rollback

Hosted creator state is session-local and ephemeral. Do not design durable inventories, accounts,
meta-progression, or cross-session saves unless a real project-owned service exists outside the
current Snack creator runtime. Outbound `fetch` and a Snack persistence API are not available today.
End a completed hosted match with `server.end()` only after final results have had a bounded delivery
window.

Treat new durations, distances, rates, health values, and thresholds as named tuning hypotheses unless
they come from an existing project or platform contract. Validate them in play rather than presenting
them as fixed Snack defaults.

## Add Game Feel Deliberately

Read [references/game-feel.md](references/game-feel.md) before tuning movement response, impact,
camera, animation, audio coupling, or other feedback.

Treat game feel as state communication. Make the primary verb respond immediately, then tune motion,
contact feedback, camera, and audio without hiding the next decision. Respect reduced-motion settings
and keep predicted effects correctable or deduplicated when authority confirms an event.

## Verify With Players

Use `snack-playtest-game` through the Snack host shell. Verify:

- a new player can discover the primary verb and objective
- pressure or a meaningful decision appears early
- rewards alter strategy, progress, score, or future choices
- failure is understandable and retry is quick
- at least two players can affect the same match as designed
- invalid or impossible actions are rejected by authority
- the loop survives latency, disconnect/rejoin, focus loss, and round restart
- feedback remains readable with reduced motion and on small screens

Run the project `check` and `build` scripts after implementation.
