# Game UI Patterns

## Contents

- Information hierarchy
- Required states
- HUD composition
- Menus and overlays
- Touch controls
- Responsive constraints
- State wiring
- Verification

## Information Hierarchy

Design the interface around player decisions:

1. survival and immediate danger
2. current objective and progress
3. short-lived action feedback
4. score, resources, inventory, or team state
5. flavor and decoration

Prefer game-native forms—meters, reticles, badges, cooldown rings, inventory slots, minimaps,
off-screen indicators, and compact clusters—over generic cards and analytics-dashboard layouts.
Keep UI away from the player, threats, pickups, targets, and the next route decision.

Use icons only when their meaning is familiar or taught. Use text where ambiguity would cost the
player a decision. Do not fill the play area with persistent control instructions after the player
has learned them.

## Required States

Inventory the states the game actually needs:

- connecting or loading
- lobby, ready, or waiting for players
- active gameplay
- local pause/settings when appropriate
- disconnected, relaunching to rejoin, or unable to rejoin
- fail/retry, eliminated/spectating, round end, win, or match result
- empty/error states for asynchronous assets or data
- touch controls for declared phone/tablet support
- debug and tuning UI, gated separately from player UI

Do not globally pause an authoritative multiplayer match because one client opens local UI. Show
the appropriate local state while the server and other players continue according to game rules.

## HUD Composition

Choose zones by camera and genre rather than applying one fixed template. Common roles:

- top/edge: objective, wave, timer, route, round, or progress
- peripheral corner: score, resources, inventory, team, or pause affordance
- near crosshair/player: brief interaction, target, combo, or damage information
- world anchored: objective markers, names, health, and off-screen direction
- bottom thumb zones: touch movement and actions

Keep score, timers, ammo, health, speed, and similar changing values in stable-width containers.
Use consistent semantic roles for danger, reward, team, objective, disabled, and selected state.
Animate changes briefly without keeping large banners over active play.

For multiplayer, distinguish local-only, team, opponent, and match-wide information. Never reveal
hidden hands, fog-of-war state, secret roles, or private inventory because the client happened to
receive or retain it.

## Menus And Overlays

Order actions by the player's likely next step:

- resume, retry, continue, ready, or rematch first
- settings and secondary actions next
- destructive leave/restart actions last and clearly labeled

Keep panels stable across viewport changes. Provide keyboard focus, pointer hover/press, touch press,
disabled, busy, and error states. Restore focus intentionally when an overlay closes.

Do not recreate Snack-owned share, home, reload, launch identity, fullscreen, or debug controls. Keep
game-specific inventory, loadout, map, tutorial, scoreboard, accessibility, and match actions inside
the game.

## Touch Controls

- emit the same semantic actions as keyboard, mouse, and gamepad
- support simultaneous pointers where movement and aiming/actions overlap
- handle release, cancel, lost capture, blur, and visibility changes
- keep targets approximately 44 CSS pixels or larger when practical
- separate adjacent actions and keep them out of browser-gesture/safe-area edges
- show active, dragged, disabled, and cooldown state
- apply `touch-action` only where the game owns the gesture

Avoid simply translating every touch into a mouse click when the control requires analog or
multi-touch input.

## Responsive Constraints

- use stable icon slots, grid tracks, `clamp`, dynamic viewport units, and safe-area insets
- cap renderer DPR separately from CSS layout size
- test phone portrait, phone landscape, short landscape, tablet, laptop, and desktop as declared
- test long player names, large scores, multi-digit timers, translated-length labels, and crowded
  team states
- avoid text sized only from viewport width or controls that become unreachable offscreen
- keep required information readable without hover

Adapt the amount and placement of information; do not merely scale the desktop HUD down.

## State Wiring

Read UI from a single local view of authoritative game state. Dispatch semantic intents rather than
mutating simulation objects from controls.

Update correctly on:

- bootstrap and fresh-launch rejoin replacement
- player join/leave and team changes
- turn/round/match transitions
- score, health, cooldown, inventory, and objective changes
- pause/settings, focus loss, and device changes
- viewport/orientation and accessibility preferences

Clear stale banners, pressed controls, optimistic state, and timers on fresh-launch rejoin or round
restart.

## Verification

Capture and interact with:

- active gameplay on desktop
- active gameplay on every declared mobile orientation
- lobby/loading/disconnected/rejoin state when networked
- pause/settings and the primary return action
- fail/retry or round-end/rematch state
- longest values and crowded player/team state
- keyboard-only focus order and pointer/touch/gamepad paths

Check text clipping, overlap, safe areas, target size, input cancellation, reduced motion, contrast,
and console errors. Verify through the Snack host shell with at least two players when UI represents
shared state.
