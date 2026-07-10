---
name: snack-playtest-game
description: Run and verify generated Snack.Game projects locally. Use when verifying multiplayer behavior, local profiles, latency/jitter/datagram loss, disconnect and fresh-launch rejoin, server reloads, mobile viewports, controls, visual regressions, scripted gameplay automation, softlocks, or pre-publish gameplay readiness.
---

# Playtest A Snack.Game Project

Test the real Snack local launch path with multiple players and adverse conditions. Do not treat a
typecheck, one browser client, or the Vite-only page as gameplay verification.

## Prepare

Read:

- `AGENTS.md`
- `package.json`
- `snack.json`
- the changed client, server, and shared files

Detect the package manager from `package.json.packageManager`. Use the project's scripts; do not
replace them with Snack-owned install, typecheck, lint, or orchestration commands.

Identify:

- the `dev` script
- the Snack host-shell port from `snack.json` or environment overrides
- declared `game.platforms`
- the gameplay paths affected by the change
- whether the protocol uses datagrams, reliable streams, or both

Read [references/visual-regression.md](references/visual-regression.md) when stable visual states,
responsive UI, imported assets, or release-quality presentation should be protected. Read
[references/scripted-playtests.md](references/scripted-playtests.md) when a repeatable input path can
measure progress, failure, recovery, fairness, or softlocks.

## Start The Real Local Stack

Run:

```sh
<package-manager> run dev
```

Wait for both Vite and `snack dev` to become ready. Open the Snack host shell:

```txt
http://127.0.0.1:3030/
```

Use the configured host-shell port when it differs. Never validate networked gameplay through the
Vite-only client port `3031`; it lacks the required Snack launch envelope.

Use an available browser-testing tool or a real browser. Keep the dev process attached so errors
and rebuilds remain visible.

## Establish The Multiplayer Baseline

1. Open at least two host-shell tabs or create/switch local profiles with the debug menu.
2. Confirm each player has a distinct identity and connection.
3. Exercise join, ready/start, core gameplay, score/state changes, and leave.
4. Verify clients agree with authoritative state.
5. Try invalid or impossible input relevant to the change and confirm the server rejects it.
6. Check the terminal and browser consoles for build, runtime, and decode errors.

Do not keep hidden inactive profiles connected merely to raise the player count.

## Test Network Behavior

Use the host shell's network simulation controls.

Test:

1. no added latency, jitter, or loss
2. stable latency
3. latency plus jitter
4. datagram loss when gameplay uses datagrams

Verify:

- input remains bounded and does not queue indefinitely
- remote interpolation remains stable
- local prediction reconciles without runaway correction
- reliable actions do not duplicate after retries
- stale/out-of-order datagrams do not rewind state incorrectly
- disconnect/timeout behavior is understandable
- disconnect/rejoin does not leak players, histories, or timers

Packet loss applies to datagrams; reliable stream messages should arrive late rather than
disappear. Do not claim loss handling from a stream-only test.

## Test Reload And Rejoin

- Reload one client while another continues. A plain local reload creates a new guest identity by
  default; use a selected debug profile or `SNACK_DEV_PERSIST_GUEST_IDENTITY=true` when testing the
  same trusted user returning.
- Rejoin or switch the active local profile through the debug menu. Treat this as a fresh launch with
  a new connection id, not in-place transport reconnection.
- Change server code, save it, and observe the coordinated server restart/client reload.
- Confirm a failed server rebuild leaves the last working runtime usable when the local tooling
  reports that behavior.
- Confirm the next successful server build relaunches clients cleanly.
- Start a fresh tab with no prior in-memory game state.

Also test two simultaneous connections with the same `userId` and verify the game's explicit policy:
merge into one logical seat, replace/reject one connection, or keep separate seats.

Check that old connections, held input, interpolation buffers, pending requests, and timers are
discarded or safely replaced.

## Test Declared Devices

For every value in `game.platforms`:

- verify layout at representative viewport sizes
- verify all essential actions with the intended input method
- verify safe areas and both orientations when supported
- test focus loss, pointer-lock loss, touch cancellation, and gamepad disconnect
- open and close Snack's built-in menu and confirm input does not remain stuck

Remove an unsupported platform declaration or finish its controls/layout before reporting success.

## Add Repeatable Evidence When Warranted

For stable, valuable visual states, add or extend screenshot baselines through the Snack host shell.
Seed project-owned randomness, stabilize presentation-only motion, use fixed viewports, and keep
thresholds narrow enough to catch real regressions. Record an explicit added/extended/skipped
decision.

For a release-ready gameplay claim, add or run a scripted playtest that drives real input and records
objective progress, score/state transitions, failure/retry, frames advanced, and stalled windows.
Project-owned test hooks may expose read-only diagnostics or deterministic setup in development;
they must not become a production backdoor into authoritative server state.

## Run Completion Gates

Stop the dev process before running one-shot scripts if the package manager or environment requires
it.

Run:

```sh
<package-manager> run check
<package-manager> run build
```

Report:

- player count and flows tested
- network conditions tested
- devices/viewports/input methods tested
- reload/disconnect/rejoin results and identity policy
- visual-regression and scripted-playtest decisions, states, seeds, metrics, and artifacts
- command results
- any untested risk or limitation

Stop every local process started for the playtest. Do not push, preview, or publish unless the user
explicitly asks for that external action and the `snack-game-publish` workflow is used.
