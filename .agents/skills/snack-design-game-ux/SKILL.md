---
name: snack-design-game-ux
description: Design and implement playable interfaces for generated Snack.Game projects. Use when changing HUDs, in-game menus, responsive layouts, accessibility, keyboard/mouse/touch/gamepad controls, mobile safe areas, platform declarations, or coexistence with Snack's built-in game menu and fullscreen shell.
---

# Design Snack.Game Player UX

Build one coherent player experience across layout, input, interruption, and device support. Keep
game-owned UI separate from Snack's outer host shell.

## Inspect The Game

Read:

- `AGENTS.md`, `snack.json`, and `index.html`
- the client entrypoint and existing styles/components
- the gameplay code that consumes input
- `.snack/types/client.d.ts` before relying on platform events

Inventory:

- gameplay actions
- current keyboard, pointer, touch, and gamepad bindings
- gameplay HUD, pause/settings, fail/retry, win/round-end, loading/error, and touch-control states
- information hierarchy: survival, objective, immediate feedback, then flavor
- declared `game.platforms`
- required orientations and minimum playable viewport

## Define Actions Before Devices

Create one action/state layer between device events and gameplay. Map keyboard, mouse, pointer,
touch, and gamepad inputs into the same semantic actions.

- keep held state separate from pressed/released edges
- normalize analog axes and apply deadzones
- track pointer/touch ids explicitly
- reset held state on blur, visibility change, pointer-lock loss, disconnect, and controller removal
- avoid sending render-frame-rate input directly to the server without sampling/rate bounds

Read [references/input-and-layout.md](references/input-and-layout.md) for control and responsive
layout patterns.

Read [references/ui-patterns.md](references/ui-patterns.md) before designing HUDs, menus, overlays,
touch controls, or state transitions. Keep game UI compact and gameplay-shaped rather than copying a
website dashboard or marketing layout.

## Design Responsive Game UI

- Size the game from its actual container, not a fixed desktop resolution.
- Recompute canvas/render targets on resize, orientation change, and device-pixel-ratio changes.
- Respect `env(safe-area-inset-*)` for HUD and touch controls.
- Keep primary gameplay readable without relying on hover.
- Make touch targets reachable and large enough for play.
- Keep essential controls out of gesture/navigation edges where practical.
- Provide visible feedback for focus, selection, cooldowns, disabled actions, and active touch or
  gamepad input.
- Keep changing numbers in stable-width slots and test the longest realistic values.
- Put the primary pause/retry/continue action first and keep game state wired to one source of truth.
- Preserve contrast, text scaling, reduced-motion preferences, and remappable controls where the
  game benefits from them.

## Respect The Snack Host Shell

Snack's parent shell owns launch identity, the built-in Snack menu, share/home/reload actions,
platform fullscreen, and local debug controls.

- Do not recreate platform launch, auth, share, home, debug, or fullscreen controls inside the game.
- Do not fetch `/connect-info`, construct WebTransport, or wire raw launch/menu `postMessage`
  handlers.
- Do not depend on internal `snack.pause`, `snack.resume`, or `snack.menu.open` messages; they are
  not public `snack:client` APIs.
- Do not globally pause an authoritative multiplayer server because one player opens local UI.
- Make gameplay recover from lost focus, pointer lock, or temporarily missing input.
- Keep game-specific inventory, map, loadout, tutorial, scoreboard, and settings UI in the game.

## Declare Platform Support Honestly

Update `game.platforms` only after the complete experience works:

- `desktop`: playable layout and the intended keyboard/mouse and/or gamepad path
- `phone`: touch controls, safe areas, readable layout, and supported orientation
- `tablet`: touch controls and a layout that uses the larger viewport well

A responsive canvas without touch controls is not phone/tablet support. Metadata does not make a
device playable.

## Verify

Use the `snack-playtest-game` workflow through the Snack host shell.

Test:

- keyboard-only, pointer, and gamepad paths that the game claims
- touch with multiple simultaneous pointers
- portrait and landscape where relevant
- narrow, short, and safe-area viewports
- longest score/timer/player-name values and crowded HUD states
- pause, fail/retry, round-end, loading/error, and other changed UI states
- focus loss, pointer-lock loss, controller disconnect, and tab switching
- opening/closing Snack's outer menu without stuck movement or buttons
- two players so local menus never freeze shared authoritative state

Run the project `check` and `build` scripts after implementation.
