# Character Movement With jolt-ts-character-controller

## Contents

- Choose the pre-built controller
- Keep one shared simulation
- Create the capsule and controller
- Step from deterministic input
- Synchronize prediction and authority
- Handle platforms, contacts, and special movement
- Clean up and verify

## Choose The Pre-Built Controller

Use
[`snackdotgame/jolt-ts-character-controller`](https://github.com/snackdotgame/jolt-ts-character-controller)
for a player who walks, runs, jumps, follows moving platforms, or needs Ecctrl-style floating-capsule
movement. It is an imperative, rendering-free controller built for `jolt-ts`; the game continues to
own its Jolt world, fixed tick, networking, rendering, and asset scene. Read its
[documentation and interactive demos](https://snackdotgame.github.io/jolt-ts-character-controller/)
for the current options and API.

Prefer `CharacterController` over a hand-written ground ray, acceleration, friction, slope,
step-up, jump, or platform-carry implementation. Keep game-specific mechanics such as ladders,
knockback, crouch shape changes, respawn, weapons, and hazards outside the controller, then express
their physical effects through the body or a full controller state restore.

The package also exports imperative vehicle and drone controllers. Use those exports when the game
needs their matching control model; keep the same shared-world, fixed-step, and synchronization
rules described below.

## Keep One Shared Simulation

- Put physics and locomotion in a browser-safe module under `src/shared/`. Do not import Three.js,
  DOM APIs, `snack:client`, or `snack:server` there.
- Build structurally identical client and server worlds from the same ordered level data. Create
  bodies and controllers in a stable order.
- Memoize the embedded `jolt-ts` `wasm-compat` initializer and pass its resolved module as `raw` to
  `World.create`, as shown in the parent skill.
- Use one fixed `dt` and the same controller options on client and server. Treat option changes as
  simulation state: derive them from deterministic inputs or restore them immediately after the
  tick-local override.

## Create The Capsule And Controller

Choose one owner for body creation:

- Pass `world` and a `body` to `new CharacterController(...)` when the game needs exact body tags,
  collision layers, degrees-of-freedom locks, or separate kinematic ghost bodies. This is the usual
  Snack.Game pattern.
- Pass `world` and `position` when the controller's default dynamic capsule is sufficient. Read the
  created body from `controller.body`.

For an upright player body:

- use a dynamic capsule with translation-only allowed degrees of freedom when character rotation is
  presentation-owned
- set body friction and damping deliberately; the controller supplies its own movement response
- disable sleeping when gameplay requires a stationary player to react immediately to disappearing
  floors, movers, or rollback replay
- use `motionQuality: "linearCast"` when the dynamic capsule must sweep against thin or fast-moving
  geometry
- store controllers by stable player or entity id; keep a body-to-controller lookup only when
  existing helpers receive bodies instead of entity ids

Track the coordinate convention explicitly. Jolt bodies use the capsule center, while gameplay and
rendering often use a feet position. Define one offset from feet to body center that includes the
capsule half-height and the controller's `floatHeight`; apply the same conversion on spawn, read,
teleport, snapshot encode, and snapshot decode.

The floating spring is sensitive to body mass. If the chosen capsule density or mass differs from
the controller's defaults, tune `springK` and `dampingC` together against that mass. Test settling,
stairs, slopes, and moving platforms rather than copying constants without measuring the result.

## Step From Deterministic Input

Convert device input into a small simulation command before it reaches the shared module. Prefer a
world-space movement vector plus explicit jump/run flags; quantize it before network transmission
when prediction replays the same command.

For every fixed tick, in this order:

1. call `setForwardDirection(...)` for the desired movement basis
2. call `setMovement(...)` with the tick's movement flags
3. call `controller.step(dt)` once for each controlled character in stable entity-id order
4. apply other deterministic forces or impulses in their canonical order
5. move deterministic kinematic platforms to their tick pose
6. call `world.step(dt, collisionSteps)` once
7. read the resulting controller/body state for gameplay and presentation

Use `useCustomForward: true` when the input already contains a world-space move direction. Otherwise
pass the camera world direction and camera up vector to `setForwardDirection` for camera-relative
movement. Use `step(dt)` in the simulation loop because it avoids allocating a snapshot; call
`snapshot()` or read the exposed fields only when presentation needs them.

Send the held jump value expected for each replayed tick, not a render-frame-only event. If the game
needs edge-triggered behavior beyond the controller's latch, keep that latch in deterministic game
state and restore it with the rest of the prediction checkpoint.

## Synchronize Prediction And Authority

The server owns the authoritative character. A predicting client runs the same controller with the
same initial world, fixed inputs, body creation order, and controller options.

- Use `getSyncState()` to capture the controller's restorable state. It includes body pose and
  velocity plus gravity direction, grounding, jump eligibility, jump activity, and jump elapsed
  time.
- Encode every `SyncState` field in a stable binary wire format. If values are encoded as `float32`,
  compare or replay the decoded `float32` values rather than the pre-encoding JavaScript numbers.
- Use `applySyncState()` for authoritative correction, teleport, respawn, or rollback restore. Do
  not restore only position and velocity; omitted controller latches cause the next predicted jump
  or grounded tick to diverge.
- Save game-owned locomotion state—coyote time, crouch, knockback, ladders, cooldowns, and similar
  mechanics—beside `SyncState` in the same tick checkpoint.
- After correction, replay unacknowledged inputs from the corrected tick through the normal fixed
  simulation path.

Remote players that are not locally predicted should usually be kinematic snapshot/interpolation
ghosts without a `CharacterController`. Keep them out of authority, hit decisions, and the local
player's prediction unless the selected multiplayer design explicitly simulates them.

## Handle Platforms, Contacts, And Special Movement

- Drive moving platforms with deterministic `Body.moveKinematic(...)` calls after controller input
  and before `world.step`. This lets Jolt derive the platform velocity that carries or shoves the
  character during the world step. Keep platform poses a pure function of tick or include their
  state in checkpoints.
- Tag non-ground bodies such as other players or loose props so the controller's ground cast can
  ignore them when appropriate. Collision can remain enabled while the float/ground query excludes
  the body.
- Keep conveyor motion in a clear reference frame. Remove the surface velocity before controller
  movement and add it back after when the desired behavior is belt-relative locomotion.
- For ladders, knockback, or ragdoll windows that temporarily bypass normal movement, update the
  dynamic body and use `applySyncState()` to keep controller latches consistent before normal
  controller stepping resumes.
- Keep animation outside physics. Drive animation state from a controller snapshot or its
  animation helpers, but never write render interpolation or animation-root motion back into the
  authoritative body unless it is an explicit deterministic mechanic.

## Clean Up And Verify

- Remove the controller from entity maps and body lookups before removing its body. Dispose the
  Jolt world once when the simulation ends; clear all maps so reconnect/restart loops do not retain
  old objects.
- Run a headless fixed-input test twice and require identical controller sync bytes at every
  checkpoint.
- Force a client misprediction, apply the authoritative binary `SyncState`, replay pending inputs,
  and require the client to converge.
- Test idle settling, slopes, stairs, thin geometry, jumping, moving platforms, player-on-player
  contact, respawn, and every special movement mode.
- Measure `controller.step` plus `world.step` at the maximum player and body count on both client and
  server. Use the low-allocation `step(dt)` path in the hot loop.
