# Three.js Rendering Patterns For Snack.Game

## Contents

- Renderer ownership
- Resize and frame loop
- Authoritative-state presentation
- Materials, lighting, and VFX
- Imported assets and animation
- Performance strategy
- Diagnostics
- Resource disposal
- Visual verification

## Renderer Ownership

Create one owner for the renderer, active camera, scene, resize lifecycle, and animation frame. Keep
gameplay state outside Three.js objects; map authoritative entities to presentation objects using
stable ids.

Recommended client update order:

1. collect local actions
2. send or sample input according to the multiplayer approach
3. update local prediction or presentation proxy
4. sample authoritative snapshot/interpolation state
5. update Three.js transforms and animation
6. update camera, UI, and cosmetic effects
7. render once

Do not create physics bodies or authoritative rules inside render methods. Do not run multiple
`requestAnimationFrame` loops for gameplay, effects, and rendering.

## Resize And Frame Loop

Size from the embedded game container and cap device-pixel ratio according to evidence:

```ts
import * as THREE from "three";

export function resizeRenderer(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  container: HTMLElement,
  maxPixelRatio = 2,
): void {
  const width = Math.max(1, container.clientWidth);
  const height = Math.max(1, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
```

Use `ResizeObserver` for the container and also handle orientation and device-pixel-ratio changes.
Clamp long frame deltas after tab sleep. Keep fixed-step simulation separate from variable render
delta, and let the selected multiplayer skill define how simulation advances.

## Authoritative-State Presentation

Keep a presentation map:

```ts
interface EntityView {
  object: THREE.Object3D;
  lastSeenTick: number;
}

const entityViews = new Map<string, EntityView>();

export function syncEntityView(
  id: string,
  tick: number,
  position: Readonly<{ x: number; y: number; z: number }>,
): void {
  const view = entityViews.get(id);
  if (!view || tick < view.lastSeenTick) return;
  view.lastSeenTick = tick;
  view.object.position.set(position.x, position.y, position.z);
}
```

Create and remove views from authoritative lifecycle data. Render remote objects at interpolated
positions and keep interpolation offsets outside authoritative state. For non-deterministic games,
limit immediate local response to a non-authoritative presentation proxy corrected to snapshots.

If an effect may be predicted, key it by a stable input/event id so confirmation does not duplicate
particles, audio, animation, or camera response.

## Materials, Lighting, And VFX

Build visual quality in layers:

- readable silhouette and scale
- authored forms and distinct gameplay roles
- a small shared material palette
- lighting that separates player, threats, objectives, and world
- event-driven animation and VFX
- optional post-processing after readability is proven

Prefer shared geometries, materials, and textures. Use physically based materials deliberately;
verify color space, environment lighting, roughness, metalness, transparency, depth, fog, and tone
mapping in the project rather than applying universal values.

Keep custom shaders narrowly owned and tested. Preserve required Three.js chunks, defines, fog,
skinning, morph targets, instancing, depth, and shadow behavior when modifying materials. Provide a
fallback for unsupported hardware or failed compilation.

Use VFX to communicate confirmed state. Cap particles, lights, decals, trails, and full-screen
effects. Make reduced-motion mode suppress camera/FOV motion and excessive animation without
removing essential game feedback.

## Imported Assets And Animation

For each GLB/GLTF or other imported asset, record:

- source and license
- runtime path and compressed/uncompressed size
- scale, orientation, pivot, bounds, and expected world units
- triangle, material, texture, bone, and animation-clip counts
- required Draco, Meshopt, KTX2, or other decoder support
- simplified collision or selection proxy
- loading, failure, and retry behavior

Never use a detailed render mesh as an authoritative collision shape by default. Keep collision and
gameplay proxies explicit and appropriate to server/runtime capabilities.

Create one `AnimationMixer` per independently animated root when appropriate. Stop actions,
uncache clips/roots, and release references on entity removal or scene replacement. Do not assume
generated clip names or root motion are correct; inspect them.

## Performance Strategy

Measure active play at representative desktop and mobile settings. Start with:

- frame time, not only FPS
- `renderer.info.render.calls` and triangles
- geometries and textures
- shadow casters and map sizes
- transparent/particle coverage
- post-processing passes and render targets
- imported asset sizes and texture dimensions
- device-pixel ratio and canvas resolution

Optimize based on the limiting stage:

- repeated objects: `InstancedMesh` or batching
- distant detail: LOD, distance culling, or cheaper impostors
- temporary effects: object pools and hard caps
- materials: share instances and reduce switches
- geometry: simpler support assets and collision proxies
- textures: compression, atlases, mipmaps, and bounded dimensions
- fill cost: lower DPR, transparency, particles, shadows, or post passes
- CPU: avoid per-frame allocation, redundant matrix work, and broad scene traversal

Do not publish one universal draw-call or triangle budget as a guarantee. Establish a target by game,
device tier, resolution, visual style, and measured frame-time headroom.

## Diagnostics

Expose read-only diagnostics in development:

```ts
export interface ThreeDiagnostics {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
}

export function readThreeDiagnostics(renderer: THREE.WebGLRenderer): ThreeDiagnostics {
  return {
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
  };
}
```

Reset or interpret renderer counters consistently. Pair counts with viewport, DPR, camera, active
state, entity count, and sample duration. A lower count is not an improvement if readability or
playability regresses.

## Resource Disposal

On entity, round, connection, or scene teardown:

- cancel owned animation frames and async loads where possible
- remove listeners, observers, timers, and callbacks
- stop and uncache animation actions
- dispose owned geometries, materials, textures, render targets, and composer passes
- remove scene objects and map entries
- stop audio sources tied to the removed state
- avoid disposing resources still shared by surviving objects

Verify disposal by repeating fresh-launch rejoins and round restarts while watching resource counts.

## Visual Verification

Capture active gameplay through the Snack host shell. Test:

- desktop and every declared mobile orientation
- pause/menu, fail/retry, and high-load gameplay states
- longest UI values and crowded scenes
- asset-visible states under real lighting and camera distance
- fresh-launch rejoin and restart after assets and effects have been active
- deterministic visual baselines when stable states can be exposed safely

Check browser console errors, WebGL context loss, shader compilation, missing assets, and nonblank
canvas output. Use `snack-playtest-game` for player flows and `snack-debug-performance` for measured
before/after claims.
