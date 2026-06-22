// Jolt physics world + deterministic FPS controller, shared by server
// (authority) and client (prediction). Players are rotation-locked dynamic
// capsules; the destructible panels and statics are static boxes; grenades
// are dynamic spheres. The controller also owns the deterministic weapon
// state (ammo, cooldowns, reload, supplies) so firing is predicted — the
// side-effects of a shot (hit detection, damage, destruction) happen only in
// the server's hooks.
//
// No three.js and no DOM here.

import initJolt from "jolt-ts/native/jolt/dist/jolt-physics.wasm-compat.js";
import { type Body, Shape, World } from "jolt-ts";
import { EcctrlJoltController, type EcctrlSyncState } from "jolt-ts-character-controller";
import {
  BUILD_COOLDOWN_TICKS,
  SPREAD_AIR,
  SPREAD_BASE,
  SPREAD_MOVE,
  BUILD_RANGE,
  BUILD_SUPPLY,
  GRENADE_COUNT,
  GRENADE_RADIUS,
  GRENADE_THROW_SPEED,
  MELEE_COOLDOWN_TICKS,
  RELOAD_TICKS,
  RIFLE_COOLDOWN_TICKS,
  RIFLE_MAG,
  SANDBOX,
  TICK_RATE,
} from "./constants.js";
import {
  type BuildingDef,
  type Crater,
  chunksTouching,
  MAP,
  type PanelDef,
  TERRAIN_CHUNKS,
  terrainChunkMesh,
} from "./map.js";

export type { Body } from "jolt-ts";

export interface InputCmd {
  seq: number;
  // World-space move intent (already yaw-relative), quantized at sample time.
  moveX: number;
  moveZ: number;
  // View angles ride every input: the server aims hitscan/throws with them.
  yaw: number;
  pitch: number;
  jump: boolean;
  sprint: boolean;
  fire: boolean;
  reload: boolean;
  grenade: boolean;
  melee: boolean;
  build: boolean;
  // Low 16 bits of the server tick of the world the client was rendering
  // when this input was sampled. Lag compensation rewinds hit tests to it.
  viewTick: number;
}

export const ZERO_INPUT: Omit<InputCmd, "seq"> = {
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  jump: false,
  sprint: false,
  fire: false,
  reload: false,
  grenade: false,
  melee: false,
  build: false,
  viewTick: 0,
};

// Body pose + deterministic controller/weapon state. This is what crosses the
// wire in the self block and restores prediction.
export interface CharState {
  x: number; // feet position
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  onGround: boolean;
  canJump: boolean; // character-controller jump latch (released between jumps)
  jumpActive: boolean; // a jump impulse is mid-application
  jumpElapsed: number; // seconds the active jump has been applied
  jumpHeld: boolean;
  fireHeld: boolean;
  grenadeHeld: boolean;
  meleeHeld: boolean;
  buildHeld: boolean;
  coyoteTicks: number;
  cooldownTicks: number; // rifle/melee/build shared cooldown
  reloadTicks: number;
  ammo: number;
  grenades: number;
  supply: number; // buildable cover left this life
}

export const PLAYER_RADIUS = 0.35;
export const PLAYER_HALF_CYL = 0.45;
export const PLAYER_HALF_HEIGHT = PLAYER_RADIUS + PLAYER_HALF_CYL; // 0.8
export const PLAYER_HEIGHT = PLAYER_HALF_HEIGHT * 2; // 1.6
export const EYE_HEIGHT = 1.45; // above feet

export const DT = 1 / TICK_RATE;
export const GRAVITY = 22;
const WALK_SPEED = 5.2;
const SPRINT_SPEED = 7.6;
const JUMP_VEL = 6.8;
const COYOTE_TICKS = 4;
export const STEP_MAX = 0.55; // kept for importers; step-up not yet ported to the controller
// NOTE(branch): the bespoke ground probe, ground/air accel, friction, ladder,
// and step-up constants were removed when EcctrlJoltController took over
// locomotion. Re-add equivalents when porting ladders + step-up onto it.

export function makeChar(spawn: readonly number[]): CharState {
  return {
    x: spawn[0],
    y: spawn[1],
    z: spawn[2],
    vx: 0,
    vy: 0,
    vz: 0,
    onGround: false,
    canJump: true,
    jumpActive: false,
    jumpElapsed: 0,
    jumpHeld: false,
    fireHeld: false,
    grenadeHeld: false,
    meleeHeld: false,
    buildHeld: false,
    coyoteTicks: 0,
    cooldownTicks: 0,
    reloadTicks: 0,
    ammo: RIFLE_MAG,
    grenades: GRENADE_COUNT,
    supply: BUILD_SUPPLY,
  };
}

// ---------------------------------------------------------------------------
// Jolt module bootstrap.

let rawModulePromise: Promise<unknown> | null = null;
let rawModule: unknown = null;

export function joltModule(): Promise<unknown> {
  rawModulePromise ??= (initJolt as unknown as () => Promise<unknown>)().then((m) => {
    rawModule = m;
    return m;
  });
  return rawModulePromise;
}

// Free bytes left in the fixed 128MB Jolt WASM heap (the module aborts with
// OOM when an allocation no longer fits). Diagnostic gauge for leak hunts.
export function joltFreeMemory(): number {
  const m = rawModule as {
    _emscripten_bind_JoltInterface_sGetFreeMemory_0?: () => number;
  } | null;
  return m?._emscripten_bind_JoltInterface_sGetFreeMemory_0?.() ?? -1;
}

// ---------------------------------------------------------------------------
// Game world.

interface BodyTag {
  panelId?: number; // a single runtime piece (deployed cover, rubble, settled)
  slabIdx?: number; // a map structure slab (one body, many pieces)
  playerIdx?: number;
  grenadeId?: number;
  fallingId?: number; // a released chunk mid-tumble (server-side dynamic)
  static?: boolean;
}

export interface GameWorld {
  world: World;
  slabs: Map<number, Body>; // map structure slabs, by slab index
  panels: Map<number, Body>; // runtime single pieces, by panel id
  players: Map<number, Body>; // by player idx
  grenades: Map<number, Body>; // by grenade id
  terrain: Map<number, Body>; // by chunk key ci * TERRAIN_CHUNKS + cj
  controllers: Map<number, EcctrlJoltController>; // jolt-ts character controller, by player idx
}

// Body -> controller, so the body-only readChar/writeChar can sync the
// controller's full deterministic state without threading it through everywhere.
const playerControllers = new WeakMap<Body, EcctrlJoltController>();

// Controller equilibrium: the floating capsule rests this far above where the
// grounded capsule sat, so feet = bodyCenterY - PLAYER_HALF_HEIGHT - FLOAT_OFFSET
// keeps CharState in the same feet-space the rest of the game uses.
const FLOAT_OFFSET = 0;

// Build the per-player character controller options once (client and server
// must match exactly for deterministic prediction).
function makePlayerController(world: World, body: Body): EcctrlJoltController {
  return new EcctrlJoltController({
    world,
    body,
    useCustomForward: true, // we feed a world-space move direction as "forward"
    enableToggleRun: false,
    autoBalance: false,
    capsuleHalfHeight: PLAYER_HALF_CYL,
    capsuleRadius: PLAYER_RADIUS,
    maxWalkVel: WALK_SPEED,
    maxRunVel: SPRINT_SPEED,
    jumpVel: JUMP_VEL,
  });
}

function syncStateFromChar(s: CharState): EcctrlSyncState {
  return {
    position: [s.x, s.y + PLAYER_HALF_HEIGHT + FLOAT_OFFSET, s.z],
    linearVelocity: [s.vx, s.vy, s.vz],
    rotation: [0, 0, 0, 1],
    angularVelocity: [0, 0, 0],
    gravityDir: [0, -1, 0],
    onGround: s.onGround,
    canJump: s.canJump,
    jumpActive: s.jumpActive,
    jumpElapsed: s.jumpElapsed,
  };
}

export type AliveFn = (pieceId: number) => boolean;

export async function createGameWorld(destroyed?: ReadonlySet<number>): Promise<GameWorld> {
  const raw = await joltModule();
  const world = await World.create({
    raw: raw as never,
    gravity: [0, -GRAVITY, 0],
    deterministic: "cross-platform",
  });
  const gw: GameWorld = {
    world,
    slabs: new Map(),
    panels: new Map(),
    players: new Map(),
    grenades: new Map(),
    terrain: new Map(),
    controllers: new Map(),
  };
  const alive: AliveFn = destroyed ? (id) => !destroyed.has(id) : () => true;

  // Terrain: chunked triangle meshes from the shared heightfield (chunked so
  // crater digs only rebuild the touched tiles), plus a safety slab
  // underneath so nothing ever falls out of the world.
  for (let ci = 0; ci < TERRAIN_CHUNKS; ci++) {
    for (let cj = 0; cj < TERRAIN_CHUNKS; cj++) addTerrainChunkBody(gw, ci, cj);
  }
  world.createBody({
    type: "static",
    shape: Shape.box({ halfExtents: [MAP.size / 2 + 2, 0.5, MAP.size / 2 + 2] }),
    position: [0, -0.55, 0],
    layer: "static",
    friction: 0.7,
    userData: { static: true } satisfies BodyTag,
  });

  for (const s of MAP.statics) {
    world.createBody({
      type: "static",
      shape: Shape.box({ halfExtents: [s.w / 2, s.h / 2, s.d / 2] }),
      position: [s.x, s.y, s.z],
      layer: "static",
      friction: 0.6,
      userData: { static: true } satisfies BodyTag,
    });
  }
  for (let slabIdx = 0; slabIdx < MAP.slabs.length; slabIdx++) {
    rebuildSlabBody(gw, slabIdx, alive);
  }
  return gw;
}

export function destroyGameWorld(gw: GameWorld): void {
  gw.world.dispose();
  gw.slabs.clear();
  gw.panels.clear();
  gw.players.clear();
  gw.grenades.clear();
  gw.terrain.clear();
  gw.controllers.clear();
}

function addTerrainChunkBody(gw: GameWorld, ci: number, cj: number): void {
  const mesh = terrainChunkMesh(ci, cj);
  const body = gw.world.createBody({
    type: "static",
    shape: { kind: "mesh", vertices: mesh.vertices, indices: mesh.indices },
    position: [0, 0, 0],
    layer: "static",
    friction: 0.7,
    userData: { static: true } satisfies BodyTag,
  });
  gw.terrain.set(ci * TERRAIN_CHUNKS + cj, body);
}

// Rebuild the terrain tiles a fresh crater touches. Call AFTER addCrater()
// so the chunk meshes bake the new heightAt. Deterministic given the same
// crater list, so server and client mirror stay in lockstep.
export function applyCraterBodies(gw: GameWorld, c: Crater): void {
  for (const [ci, cj] of chunksTouching(c)) {
    const key = ci * TERRAIN_CHUNKS + cj;
    const old = gw.terrain.get(key);
    if (old) gw.world.removeBody(old);
    addTerrainChunkBody(gw, ci, cj);
  }
}

// ---------------------------------------------------------------------------
// Slab collision: one static body per structure face/sheet/stack. The shape
// is a compound of boxes GREEDY-MERGED from the slab's alive pieces — a
// pristine wall is a handful of boxes, not 750 — rebuilt whenever the
// slab's damage set changes. Deterministic (stable sorts over exact piece
// coordinates), so server and prediction worlds build identical shapes.

interface MergeBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

const TOUCH = 1e-3;

// One pass: merge boxes that touch along `axis` and match exactly on the
// other two. Returns true if anything merged.
function mergeAlong(boxes: MergeBox[], axis: 0 | 1 | 2): boolean {
  const lo = ["x0", "y0", "z0"] as const;
  const hi = ["x1", "y1", "z1"] as const;
  const a = lo[axis];
  const b = hi[axis];
  const others: Array<0 | 1 | 2> = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  const key = (m: MergeBox): string =>
    `${m[lo[others[0]]].toFixed(4)},${m[hi[others[0]]].toFixed(4)},${m[lo[others[1]]].toFixed(4)},${m[hi[others[1]]].toFixed(4)}`;
  const groups = new Map<string, MergeBox[]>();
  for (const m of boxes) {
    const k = key(m);
    const list = groups.get(k);
    if (list) list.push(m);
    else groups.set(k, [m]);
  }
  let merged = false;
  boxes.length = 0;
  for (const group of groups.values()) {
    group.sort((p, q) => p[a] - q[a]);
    let cur = group[0];
    for (let i = 1; i < group.length; i++) {
      const next = group[i];
      if (next[a] <= cur[b] + TOUCH) {
        cur[b] = Math.max(cur[b], next[b]);
        merged = true;
      } else {
        boxes.push(cur);
        cur = next;
      }
    }
    boxes.push(cur);
  }
  return merged;
}

export function mergeSlabBoxes(pieces: readonly PanelDef[], alive: AliveFn): MergeBox[] {
  const boxes: MergeBox[] = [];
  for (const p of pieces) {
    if (!alive(p.id)) continue;
    boxes.push({
      x0: p.x - p.ex / 2,
      y0: p.y - p.ey / 2,
      z0: p.z - p.ez / 2,
      x1: p.x + p.ex / 2,
      y1: p.y + p.ey / 2,
      z1: p.z + p.ez / 2,
    });
  }
  // Row runs first, then stack runs vertically, then across; repeat once to
  // catch merges the first ordering missed.
  for (let round = 0; round < 2; round++) {
    let any = false;
    any = mergeAlong(boxes, 0) || any;
    any = mergeAlong(boxes, 2) || any;
    any = mergeAlong(boxes, 1) || any;
    if (!any) break;
  }
  return boxes;
}

// (Re)build a slab's body from its alive pieces. No alive pieces = no body.
export function rebuildSlabBody(gw: GameWorld, slabIdx: number, alive: AliveFn): void {
  const old = gw.slabs.get(slabIdx);
  if (old) {
    gw.world.removeBody(old);
    gw.slabs.delete(slabIdx);
  }
  const slab = MAP.slabs[slabIdx];
  const pieces = MAP.panels.slice(slab.first - 1, slab.last); // ids are 1-based & sequential
  const boxes = mergeSlabBoxes(pieces, alive);
  if (boxes.length === 0) return;
  const body = gw.world.createBody({
    type: "static",
    shape: Shape.compound(
      boxes.map((m) => ({
        shape: Shape.box({
          halfExtents: [(m.x1 - m.x0) / 2, (m.y1 - m.y0) / 2, (m.z1 - m.z0) / 2],
        }),
        position: [(m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2, (m.z0 + m.z1) / 2] as [
          number,
          number,
          number,
        ],
      })),
    ),
    position: [0, 0, 0],
    layer: "static",
    friction: 0.6,
    userData: { slabIdx } satisfies BodyTag,
  });
  gw.slabs.set(slabIdx, body);
}

// Which alive piece of a slab contains this (surface) point? Hits land on
// faces, so accept the piece whose box the point is closest to inside a
// small tolerance.
export function pieceAt(slabIdx: number, point: readonly number[], alive: AliveFn): number | null {
  const slab = MAP.slabs[slabIdx];
  let best = -1;
  let bestD = 0.06;
  for (let id = slab.first; id <= slab.last; id++) {
    if (!alive(id)) continue;
    const p = MAP.panels[id - 1];
    const d = Math.max(
      Math.abs(point[0] - p.x) - p.ex / 2,
      Math.abs(point[1] - p.y) - p.ey / 2,
      Math.abs(point[2] - p.z) - p.ez / 2,
    );
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best >= 0 ? best : null;
}

// Resolve a raycast hit to a piece id: runtime pieces carry their id; slab
// hits resolve analytically from the hit position.
export function pieceIdFromHit(
  body: Body,
  point: readonly number[],
  alive: AliveFn,
): number | null {
  const tag = body.userData as BodyTag;
  if (tag.panelId !== undefined) return tag.panelId;
  if (tag.slabIdx !== undefined) return pieceAt(tag.slabIdx, point, alive);
  return null;
}

export function addPanelBody(gw: GameWorld, p: PanelDef): Body {
  const body = gw.world.createBody({
    type: "static",
    shape: Shape.box({ halfExtents: [p.ex / 2, p.ey / 2, p.ez / 2] }),
    position: [p.x, p.y, p.z],
    rotation: p.rot ?? [0, 0, 0, 1],
    layer: "static",
    friction: 0.6,
    userData: { panelId: p.id } satisfies BodyTag,
  });
  gw.panels.set(p.id, body);
  return body;
}

// A connected cluster of released pieces as ONE rigid dynamic body: a
// compound of boxes at their offsets from the cluster origin. The slab tips
// and tumbles coherently under the server's simulation (server-only; clients
// render the streamed pose and get the resting split on settle).
export function createFallingChunkBody(
  gw: GameWorld,
  id: number,
  origin: readonly number[],
  pieces: readonly PanelDef[],
  vel: readonly number[],
): Body {
  return gw.world.createBody({
    type: "dynamic",
    shape: Shape.compound(
      pieces.map((p) => ({
        shape: Shape.box({ halfExtents: [p.ex / 2, p.ey / 2, p.ez / 2] }),
        position: [p.x - origin[0], p.y - origin[1], p.z - origin[2]] as [number, number, number],
      })),
    ),
    position: [origin[0], origin[1], origin[2]],
    layer: "moving",
    friction: 0.85,
    restitution: 0.05,
    linearDamping: 0.15,
    angularDamping: 0.6,
    // Continuous collision: thin pieces falling a few meters tunnel through
    // the terrain mesh with discrete steps and vanish below the world.
    motionQuality: "linearCast",
    linearVelocity: [vel[0], vel[1], vel[2]],
    userData: { fallingId: id } satisfies BodyTag,
  });
}

// A collapsed building leaves a low rubble mound over its footprint —
// indestructible cover that reads as wreckage. Deterministic from map data,
// so client and server create identical bodies on the collapse event.
export function addRubbleBody(gw: GameWorld, b: BuildingDef, rubbleHeight: number): Body {
  return gw.world.createBody({
    type: "static",
    shape: Shape.box({ halfExtents: [b.w / 2 + 0.3, rubbleHeight / 2, b.d / 2 + 0.3] }),
    position: [b.cx, rubbleHeight / 2, b.cz],
    layer: "static",
    friction: 0.8,
    userData: { static: true } satisfies BodyTag,
  });
}

export function removePanelBody(gw: GameWorld, panelId: number): void {
  const body = gw.panels.get(panelId);
  if (body) {
    gw.world.removeBody(body);
    gw.panels.delete(panelId);
  }
}

export function createPlayerBody(
  gw: GameWorld,
  idx: number,
  feet: readonly number[],
  opts?: { kinematic?: boolean },
): Body {
  const body = gw.world.createBody({
    type: opts?.kinematic ? "kinematic" : "dynamic",
    shape: Shape.capsule({ halfHeight: PLAYER_HALF_CYL, radius: PLAYER_RADIUS }),
    position: [feet[0], feet[1] + PLAYER_HALF_HEIGHT, feet[2]],
    layer: "moving",
    friction: 0,
    restitution: 0,
    linearDamping: 0,
    angularDamping: 0,
    allowSleeping: false,
    allowedDofs: ["translation-x", "translation-y", "translation-z"],
    userData: { playerIdx: idx } satisfies BodyTag,
  });
  gw.players.set(idx, body);
  // Real (dynamic) players are driven by the character controller; kinematic
  // ghosts (remote collision proxies) are posed straight from snapshots.
  if (!opts?.kinematic) {
    const controller = makePlayerController(gw.world, body);
    gw.controllers.set(idx, controller);
    playerControllers.set(body, controller);
  }
  return body;
}

export function removePlayerBody(gw: GameWorld, idx: number): void {
  const body = gw.players.get(idx);
  if (body) {
    playerControllers.delete(body);
    gw.world.removeBody(body);
    gw.players.delete(idx);
  }
  gw.controllers.delete(idx);
}

export function createGrenadeBody(
  gw: GameWorld,
  id: number,
  pos: readonly number[],
  vel: readonly number[],
): Body {
  const body = gw.world.createBody({
    type: "dynamic",
    shape: Shape.sphere(GRENADE_RADIUS),
    position: [pos[0], pos[1], pos[2]],
    layer: "moving",
    friction: 0.45, // low enough that the sphere rolls instead of sticking
    restitution: 0.4, // a livelier bounce off ground/walls
    linearDamping: 0.2,
    angularDamping: 1.4,
    allowSleeping: false,
    motionQuality: "linearCast",
    linearVelocity: [vel[0], vel[1], vel[2]],
    userData: { grenadeId: id } satisfies BodyTag,
  });
  gw.grenades.set(id, body);
  return body;
}

export function removeGrenadeBody(gw: GameWorld, id: number): void {
  const body = gw.grenades.get(id);
  if (body) {
    gw.world.removeBody(body);
    gw.grenades.delete(id);
  }
}

// Copy body pose into a CharState; push it back (reconciliation/teleport).
export function readChar(body: Body, s: CharState): void {
  const controller = playerControllers.get(body);
  if (controller) {
    const st = controller.getSyncState();
    s.x = st.position[0];
    s.y = st.position[1] - PLAYER_HALF_HEIGHT - FLOAT_OFFSET;
    s.z = st.position[2];
    s.vx = st.linearVelocity[0];
    s.vy = st.linearVelocity[1];
    s.vz = st.linearVelocity[2];
    s.onGround = st.onGround;
    s.canJump = st.canJump;
    s.jumpActive = st.jumpActive;
    s.jumpElapsed = st.jumpElapsed;
    return;
  }
  const pos = body.translation();
  const vel = body.linearVelocity();
  s.x = pos.x;
  s.y = pos.y - PLAYER_HALF_HEIGHT;
  s.z = pos.z;
  s.vx = vel.x;
  s.vy = vel.y;
  s.vz = vel.z;
}

export function writeChar(body: Body, s: CharState): void {
  const controller = playerControllers.get(body);
  if (controller) {
    // Restore the full controller state (pose + latches) so prediction replay
    // and server reconciliation reproduce it exactly.
    controller.applySyncState(syncStateFromChar(s));
    return;
  }
  body.setTranslation([s.x, s.y + PLAYER_HALF_HEIGHT, s.z]);
  body.setLinearVelocity(s.vx, s.vy, s.vz);
}

// View ray helpers (aim from the eye).
export function eyePosition(s: CharState): [number, number, number] {
  return [s.x, s.y + EYE_HEIGHT, s.z];
}

export function aimDirection(yaw: number, pitch: number): [number, number, number] {
  const cp = Math.cos(pitch);
  return [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
}

// Where a deployed cover panel would go: snapped in front of the player.
export function buildPlacement(s: CharState, yaw: number): PanelDef {
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  const px = s.x + dx * BUILD_RANGE;
  const pz = s.z + dz * BUILD_RANGE;
  // Face the player: wall axis perpendicular to view.
  const alongX = Math.abs(dx) <= Math.abs(dz);
  return {
    id: 0, // assigned by the server
    x: Math.round(px * 2) / 2,
    y: s.y + 1.25 / 2,
    z: Math.round(pz * 2) / 2,
    ex: alongX ? 2 : 0.22,
    ey: 1.25,
    ez: alongX ? 0.22 : 2,
    material: "metal",
  };
}

export interface StepHooks {
  // Server: resolve the shot (hit detection, damage, tracer event).
  // Client (prediction): muzzle flash / sound / local tracer.
  onFire?: (origin: [number, number, number], dir: [number, number, number]) => void;
  onMelee?: (origin: [number, number, number], dir: [number, number, number]) => void;
  // Server spawns the grenade body; the client only plays the throw.
  onGrenade?: (origin: [number, number, number], vel: [number, number, number]) => void;
  // Server validates and creates the cover panel.
  onBuild?: (panel: PanelDef) => void;
}

export interface StepOptions extends StepHooks {
  locked?: boolean; // dead / round over: ignore all action inputs
}

// Per-tick FPS controller. Movement + deterministic weapon state. Call for
// every player before world.step().
export function stepPlayerController(
  gw: GameWorld,
  body: Body,
  s: CharState,
  input: InputCmd,
  opts: StepOptions = {},
): void {
  const controller = playerControllers.get(body);
  const locked = opts.locked === true;

  // --- Locomotion via the jolt-ts character controller. ---
  // moveX/moveZ is already a world-space, yaw-relative move vector, so feed it
  // straight in as the controller's custom forward axis and walk along it.
  const mx = locked ? 0 : input.moveX;
  const mz = locked ? 0 : input.moveZ;
  const mag = Math.hypot(mx, mz);
  const moving = mag > 1e-3;
  // Sprint only when moving roughly toward where the player is looking.
  const fdx = Math.sin(input.yaw);
  const fdz = Math.cos(input.yaw);
  const forwardness = moving ? (mx * fdx + mz * fdz) / mag : 0;
  const sprinting = !locked && input.sprint && moving && forwardness > 0.5;
  if (controller) {
    if (moving) controller.setForwardDirection({ x: mx / mag, y: 0, z: mz / mag });
    controller.setMovement({ forward: moving, run: sprinting, jump: !locked && input.jump });
    controller.step(DT);
  }
  s.jumpHeld = input.jump;
  // Post-step body velocity (inherited by thrown grenades); ground state comes
  // back through readChar below.
  const vel = body.linearVelocity();
  const vx = vel.x;
  const vz = vel.z;
  const grounded = controller ? controller.getSyncState().onGround : false;
  s.onGround = grounded;
  // TODO(branch): ladder climbing and stair step-up are not yet reimplemented
  // on top of the character controller (the prior bespoke logic handled them).

  // --- Weapons (deterministic state; effects via hooks). ---
  if (SANDBOX) {
    // Bottomless supplies in the test environment (shared constant, so
    // prediction and server still agree exactly).
    s.ammo = Math.max(s.ammo, RIFLE_MAG);
    s.grenades = Math.max(s.grenades, GRENADE_COUNT);
    s.supply = Math.max(s.supply, BUILD_SUPPLY);
  }
  if (s.cooldownTicks > 0) s.cooldownTicks--;
  if (s.reloadTicks > 0) {
    s.reloadTicks--;
    if (s.reloadTicks === 0) s.ammo = RIFLE_MAG;
  }

  readChar(body, s); // refresh pos before aiming from the eye
  const eye = eyePosition(s);
  const dir = aimDirection(input.yaw, input.pitch);

  if (!locked && s.reloadTicks === 0) {
    if (input.reload && s.ammo < RIFLE_MAG) {
      s.reloadTicks = RELOAD_TICKS;
    } else if (input.fire && !sprinting && s.cooldownTicks === 0 && s.ammo > 0) {
      // Full-auto: held fire keeps shooting on cooldown. Can't fire while
      // sprinting — the gun is lowered.
      s.ammo--;
      s.cooldownTicks = RIFLE_COOLDOWN_TICKS;
      opts.onFire?.(eye, dir);
    } else if (input.fire && s.cooldownTicks === 0 && s.ammo === 0 && !s.fireHeld) {
      s.reloadTicks = RELOAD_TICKS; // dry fire -> auto reload
    }

    const meleePressed = input.melee && !s.meleeHeld;
    if (meleePressed && s.cooldownTicks === 0) {
      s.cooldownTicks = MELEE_COOLDOWN_TICKS;
      opts.onMelee?.(eye, dir);
    }

    const grenadePressed = input.grenade && !s.grenadeHeld;
    if (grenadePressed && s.grenades > 0 && s.cooldownTicks === 0) {
      s.grenades--;
      s.cooldownTicks = MELEE_COOLDOWN_TICKS;
      opts.onGrenade?.(
        [eye[0] + dir[0] * 0.5, eye[1] + dir[1] * 0.5, eye[2] + dir[2] * 0.5],
        [
          dir[0] * GRENADE_THROW_SPEED + vx * 0.5,
          dir[1] * GRENADE_THROW_SPEED + 2.5,
          dir[2] * GRENADE_THROW_SPEED + vz * 0.5,
        ],
      );
    }

    const buildPressed = input.build && !s.buildHeld;
    if (buildPressed && s.supply > 0 && s.cooldownTicks === 0) {
      s.supply--;
      s.cooldownTicks = BUILD_COOLDOWN_TICKS;
      opts.onBuild?.(buildPlacement(s, input.yaw));
    }
  }
  s.fireHeld = input.fire;
  s.meleeHeld = input.melee;
  s.grenadeHeld = input.grenade;
  s.buildHeld = input.build;

  // --- Timers. ---
  if (grounded) s.coyoteTicks = COYOTE_TICKS;
  else if (s.coyoteTicks > 0) s.coyoteTicks--;
}

// Distance along the ray to the first WALL (panels/statics), hopping over
// every player capsule — player hits are decided by the rewound test below.
export function castWallDistance(
  gw: GameWorld,
  origin: readonly number[],
  dir: readonly number[],
  length: number,
): { dist: number; body: Body | null; point: [number, number, number] } {
  let ox = origin[0];
  let oy = origin[1];
  let oz = origin[2];
  let traveled = 0;
  for (let hop = 0; hop < 6; hop++) {
    const remaining = length - traveled;
    if (remaining <= 0) break;
    const hit = gw.world.castRay(
      [ox, oy, oz],
      [dir[0] * remaining, dir[1] * remaining, dir[2] * remaining],
    );
    if (!hit || !hit.body) break;
    const hitDist = traveled + remaining * hit.fraction;
    const tag = hit.body.userData as { playerIdx?: number; fallingId?: number };
    if (tag.playerIdx === undefined && tag.fallingId === undefined) {
      return {
        dist: hitDist,
        body: hit.body,
        point: [
          origin[0] + dir[0] * hitDist,
          origin[1] + dir[1] * hitDist,
          origin[2] + dir[2] * hitDist,
        ],
      };
    }
    traveled = hitDist + 0.45;
    ox = origin[0] + dir[0] * traveled;
    oy = origin[1] + dir[1] * traveled;
    oz = origin[2] + dir[2] * traveled;
  }
  return {
    dist: length,
    body: null,
    point: [origin[0] + dir[0] * length, origin[1] + dir[1] * length, origin[2] + dir[2] * length],
  };
}

// Ray vs a vertical capsule at `feet` — returns the ray distance of the
// closest approach if within the capsule radius, else null.
export function rayVsCapsule(
  origin: readonly number[],
  dir: readonly number[],
  maxDist: number,
  feet: readonly number[],
): number | null {
  const a: [number, number, number] = [feet[0], feet[1] + PLAYER_RADIUS, feet[2]];
  const segY = PLAYER_HEIGHT - 2 * PLAYER_RADIUS; // capsule core segment
  // Closest approach between ray (origin + t*dir) and vertical segment
  // (a + u*[0,segY,0], u in 0..1).
  const rx = origin[0] - a[0];
  const ry = origin[1] - a[1];
  const rz = origin[2] - a[2];
  const dDotD = 1; // dir is unit
  const eDotE = segY * segY;
  const dDotE = dir[1] * segY;
  const rDotD = rx * dir[0] + ry * dir[1] + rz * dir[2];
  const rDotE = ry * segY;
  const denom = dDotD * eDotE - dDotE * dDotE;
  let t: number;
  let u: number;
  if (Math.abs(denom) > 1e-9) {
    u = (dDotE * -rDotD + dDotD * rDotE) / denom;
    u = Math.max(0, Math.min(1, u));
    t = u * dDotE - rDotD;
  } else {
    u = 0;
    t = -rDotD;
  }
  t = Math.max(0, Math.min(maxDist, t));
  // Re-clamp u for the clamped t.
  u = Math.max(0, Math.min(1, (origin[1] + dir[1] * t - a[1]) / (segY || 1)));
  const cx = a[0];
  const cy = a[1] + u * segY;
  const cz = a[2];
  const px = origin[0] + dir[0] * t;
  const py = origin[1] + dir[1] * t;
  const pz = origin[2] + dir[2] * t;
  const distSq = (px - cx) ** 2 + (py - cy) ** 2 + (pz - cz) ** 2;
  // Small hit slop: shots that graze the capsule edge register. FPS hitboxes
  // are conventionally a touch generous — tight ones read as missed hits.
  const r = PLAYER_RADIUS + 0.05;
  return distSq <= r * r ? t : null;
}

// Current rifle spread (radians) — worse while moving or airborne.
export function spreadFor(s: CharState): number {
  const moveFactor = Math.min(1, Math.hypot(s.vx, s.vz) / WALK_SPEED);
  let spread = SPREAD_BASE + moveFactor * SPREAD_MOVE;
  if (!s.onGround) spread += SPREAD_AIR;
  return spread;
}
