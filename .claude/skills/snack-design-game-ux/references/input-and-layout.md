# Input And Responsive Layout Patterns

## Contents

- Action layer
- Keyboard, pointer, touch, and gamepad
- Canvas and viewport
- Snack shell boundary
- Accessibility and comfort

## Action Layer

Represent player intent independently from devices:

```ts
export interface PlayerActions {
  moveX: number;
  moveY: number;
  aimX: number;
  aimY: number;
  primaryHeld: boolean;
  primaryPressed: boolean;
  interactPressed: boolean;
  menuPressed: boolean;
}
```

Update one action snapshot per game/simulation frame. Clear edge-triggered fields after consumption.
Keep input collection and gameplay simulation separate so another device mapping does not fork game
logic.

## Keyboard And Pointer

- Track `keydown` and `keyup` by `KeyboardEvent.code` when physical position matters.
- Ignore repeated keydown events for pressed-edge actions.
- Prevent default browser behavior only inside the active game surface and only for claimed keys.
- Use Pointer Events for mouse, pen, and touch where one path is practical.
- Capture pointers during drags/virtual controls and release capture on end/cancel.
- Reset held input on `blur`, `visibilitychange`, and `pointerlockchange`.
- Treat pointer lock as revocable. Never leave movement/fire latched when it exits.

## Touch Controls

- Use stable pointer ids so two thumbs can move and aim simultaneously.
- Apply `touch-action: none` to the game interaction surface that owns gestures, not indiscriminately
  to unrelated document UI.
- Put virtual movement and action controls in reachable thumb zones.
- Keep controls away from safe-area and browser navigation edges.
- Provide visual pressed/drag feedback and cancellation behavior.
- Let controls adapt to viewport and handedness when the game warrants it.

Do not emulate every touch as a mouse click if the game needs simultaneous or analog input.

## Gamepad

Poll `navigator.getGamepads()` during the game frame and map buttons/axes to the same action layer.

- handle connect/disconnect and changing array slots
- apply a radial or per-axis deadzone before normalization
- clamp normalized values to `[-1, 1]`
- detect pressed edges from previous and current button state
- avoid assuming one browser's button labels or controller model
- offer keyboard/touch fallback unless gamepad-only play is an explicit product choice

Do not send raw high-frequency axis samples to the server. Quantize/sample according to the
multiplayer protocol.

## Canvas And Viewport

Size from the container:

```ts
const observer = new ResizeObserver(([entry]) => {
  if (!entry) return;
  const width = entry.contentRect.width;
  const height = entry.contentRect.height;
  const scale = Math.min(window.devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
});

observer.observe(canvas.parentElement ?? canvas);
```

Clamp device-pixel ratio according to performance needs. Update the renderer/camera projection, not
only the DOM element.

Use dynamic viewport units and safe areas:

```css
.game-root {
  min-height: 100dvh;
}

.hud {
  padding-top: max(12px, env(safe-area-inset-top, 0px));
  padding-right: max(12px, env(safe-area-inset-right, 0px));
  padding-bottom: max(12px, env(safe-area-inset-bottom, 0px));
  padding-left: max(12px, env(safe-area-inset-left, 0px));
}
```

Keep logical world coordinates independent from CSS pixels. Re-evaluate fixed HUD assumptions on
very wide, very tall, and short landscape screens.

## Snack Shell Boundary

The game lives inside a Snack-controlled iframe. The parent shell owns launch, platform menu,
fullscreen, share/home/reload, and local debug UI.

The public creator boundary is the generated `snack:client` API. Do not add raw window messaging to
observe undocumented shell messages. Until a public menu/pause signal exists, design multiplayer
correctness so it does not rely on knowing whether the outer menu is open.

Recover safely from interruption:

- neutralize or stop sending stale local input
- release pointer capture/lock assumptions
- keep authoritative server time moving
- resume rendering/input without duplicating one-shot actions
- let server timeout or neutral-input rules handle a temporarily silent client

## Accessibility And Comfort

- make important state distinguishable without color alone
- maintain readable contrast and scalable text
- respect `prefers-reduced-motion` for camera shake and large transitions
- avoid unavoidable rapid flashing
- provide visible control hints that match the active device
- allow remapping or alternate bindings when the control set is complex
- avoid making audio the only carrier of critical information
