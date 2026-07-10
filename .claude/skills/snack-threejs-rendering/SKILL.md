---
name: snack-threejs-rendering
description: Build, polish, debug, and optimize Three.js client rendering in generated Snack.Game projects. Use only when a project actually depends on Three.js and work involves scenes, cameras, materials, lighting, shaders, imported models, animation, VFX, draw calls, GPU cost, disposal, visual regressions, or synchronizing authoritative Snack state into Three.js presentation.
---

# Build Snack.Game Three.js Rendering

Treat Three.js as a client presentation layer. Snack remains engine-neutral, and authoritative rules
stay in the server entrypoint regardless of how the client renders them.

## Confirm The Boundary

Before using this skill:

- confirm `three` is a project dependency or the existing renderer is Three.js
- read `AGENTS.md`, `snack.json`, and the client/shared entrypoints
- identify the selected multiplayer approach and authoritative state shape
- inspect current renderer ownership, animation loop, assets, resize behavior, and diagnostics

Do not add Three.js merely because this skill exists. Do not copy a standalone Vite scaffold over a
Snack project or move authoritative physics and rules into the browser.

## Organize Presentation

Keep clear owners for:

- renderer, camera, resize, and render loop
- scene/entity presentation mapped from stable game ids
- assets and loading state
- materials, lighting, animation, and VFX
- interpolation, correction, and presentation-only prediction
- resource disposal and diagnostics

Read [references/rendering-patterns.md](references/rendering-patterns.md) before changing renderer
configuration, assets, shaders, visual architecture, or performance-sensitive systems.

## Build In This Order

1. prove the active gameplay camera and readable silhouettes
2. establish authored forms and collision proxies
3. create reusable materials and lighting roles
4. add event-driven animation and VFX
5. add post-processing only when it improves readability
6. measure calls, triangles, textures, memory, and frame time in active play
7. add instancing, culling, LOD, pooling, compression, or quality tiers where evidence requires them

Do not use glow, fog, darkness, or post-processing to conceal missing geometry or weak gameplay
readability.

## Preserve Multiplayer Correctness

- render remote entities from buffered authoritative snapshots
- keep smoothing offsets out of simulation state
- use a narrow presentation proxy for non-deterministic local response
- never trust client meshes, raycasts, physics contacts, or positions as match authority
- create effects from stable event ids so prediction and later confirmation do not double-play them
- keep camera shake, particles, and cosmetic randomness out of deterministic rollback state

## Verify

Use `snack-playtest-game` through the host shell and `snack-debug-performance` for measurements.
Capture active-play desktop and supported mobile states, not only title screens.

Verify:

- resize, orientation, device-pixel ratio, focus loss, fresh-launch rejoin, and restart
- asset loading, scale, pivot, animation clips, and simplified collision proxies
- renderer calls, triangles, textures, and resource counts before and after risky changes
- no duplicate animation loops, entities, effects, listeners, or GPU resources after rejoin/restart
- visual baselines or an explicit reason they are inappropriate

Run the project `check` and `build` scripts after implementation.
