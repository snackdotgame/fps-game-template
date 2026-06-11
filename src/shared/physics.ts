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
  TICK_RATE,
} from "./constants.js";
import { type BuildingDef, MAP, type PanelDef, type PanelOrient, panelExtents } from "./map.js";

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
const GROUND_ACCEL = 60;
const AIR_ACCEL = 14;
const GROUND_FRICTION = 50;
const JUMP_VEL = 6.8;
const COYOTE_TICKS = 4;
const GROUND_PROBE = 0.09;

export function makeChar(spawn: readonly number[]): CharState {
  return {
    x: spawn[0],
    y: spawn[1],
    z: spawn[2],
    vx: 0,
    vy: 0,
    vz: 0,
    onGround: false,
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

export function joltModule(): Promise<unknown> {
  rawModulePromise ??= (initJolt as unknown as () => Promise<unknown>)();
  return rawModulePromise;
}

// ---------------------------------------------------------------------------
// Game world.

interface BodyTag {
  panelId?: number;
  playerIdx?: number;
  grenadeId?: number;
  static?: boolean;
}

export interface GameWorld {
  world: World;
  panels: Map<number, Body>; // destructible, by panel id (map + built)
  players: Map<number, Body>; // by player idx
  grenades: Map<number, Body>; // by grenade id
}

export async function createGameWorld(): Promise<GameWorld> {
  const raw = await joltModule();
  const world = await World.create({
    raw: raw as never,
    gravity: [0, -GRAVITY, 0],
    deterministic: "cross-platform",
  });
  const gw: GameWorld = { world, panels: new Map(), players: new Map(), grenades: new Map() };

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
  for (const p of MAP.panels) addPanelBody(gw, p);
  return gw;
}

export function destroyGameWorld(gw: GameWorld): void {
  gw.world.dispose();
  gw.panels.clear();
  gw.players.clear();
  gw.grenades.clear();
}

export function addPanelBody(gw: GameWorld, p: PanelDef): Body {
  const [w, h, d] = panelExtents(p.orient);
  const body = gw.world.createBody({
    type: "static",
    shape: Shape.box({ halfExtents: [w / 2, h / 2, d / 2] }),
    position: [p.x, p.y, p.z],
    layer: "static",
    friction: 0.6,
    userData: { panelId: p.id } satisfies BodyTag,
  });
  gw.panels.set(p.id, body);
  return body;
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
  return body;
}

export function removePlayerBody(gw: GameWorld, idx: number): void {
  const body = gw.players.get(idx);
  if (body) {
    gw.world.removeBody(body);
    gw.players.delete(idx);
  }
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
    friction: 0.95,
    restitution: 0.22,
    linearDamping: 0.3,
    angularDamping: 2.2,
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
  const orient: PanelOrient = Math.abs(dx) > Math.abs(dz) ? "z" : "x";
  return {
    id: 0, // assigned by the server
    x: Math.round(px * 2) / 2,
    y: s.y + 1.25 / 2,
    z: Math.round(pz * 2) / 2,
    orient,
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
  const pos = body.translation();
  const vel = body.linearVelocity();
  const feetY = pos.y - PLAYER_HALF_HEIGHT;

  // --- Ground probe. ---
  let grounded = false;
  for (const [ox, oz] of PROBE_OFFSETS) {
    const hit = gw.world.castRay(
      [pos.x + ox, feetY + 0.02, pos.z + oz],
      [0, -(GROUND_PROBE + 0.02), 0],
    );
    if (hit && hit.body && hit.body !== body) {
      grounded = true;
      break;
    }
  }
  if (vel.y > 1.0) grounded = false;
  s.onGround = grounded;

  let mx = input.moveX;
  let mz = input.moveZ;
  const mag = Math.sqrt(mx * mx + mz * mz);
  if (mag > 1) {
    mx /= mag;
    mz /= mag;
  }
  const locked = opts.locked === true;
  if (locked) {
    mx = 0;
    mz = 0;
  }

  // Sprint only applies moving forward-ish relative to view.
  const fdx = Math.sin(input.yaw);
  const fdz = Math.cos(input.yaw);
  const forwardness = mx * fdx + mz * fdz;
  const sprinting = input.sprint && forwardness > 0.5 && grounded && !locked;
  const speed = sprinting ? SPRINT_SPEED : WALK_SPEED;

  let vx = vel.x;
  let vy = vel.y;
  let vz = vel.z;
  const accel = grounded ? GROUND_ACCEL : AIR_ACCEL;
  if (mx !== 0 || mz !== 0) {
    vx = approach(vx, mx * speed, accel * DT);
    vz = approach(vz, mz * speed, accel * DT);
  } else if (grounded) {
    vx = approach(vx, 0, GROUND_FRICTION * DT);
    vz = approach(vz, 0, GROUND_FRICTION * DT);
  }

  // --- Jump. ---
  const jumpPressed = input.jump && !s.jumpHeld && !locked;
  if (jumpPressed && (grounded || s.coyoteTicks > 0)) {
    vy = JUMP_VEL;
    grounded = false;
    s.onGround = false;
    s.coyoteTicks = 0;
  }
  s.jumpHeld = input.jump;

  body.setLinearVelocity(vx, vy, vz);

  // --- Weapons (deterministic state; effects via hooks). ---
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
    } else if (input.fire && s.cooldownTicks === 0 && s.ammo > 0) {
      // Full-auto: held fire keeps shooting on cooldown.
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

const PROBE_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.22, 0],
  [-0.22, 0],
  [0, 0.22],
  [0, -0.22],
];

function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
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
    const tag = hit.body.userData as { playerIdx?: number };
    if (tag.playerIdx === undefined) {
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
  return distSq <= PLAYER_RADIUS * PLAYER_RADIUS ? t : null;
}

// Current rifle spread (radians) — worse while moving or airborne.
export function spreadFor(s: CharState): number {
  const moveFactor = Math.min(1, Math.hypot(s.vx, s.vz) / WALK_SPEED);
  let spread = SPREAD_BASE + moveFactor * SPREAD_MOVE;
  if (!s.onGround) spread += SPREAD_AIR;
  return spread;
}
