// Browser client: first-person rendering, local prediction over a mirror Jolt
// world, remote interpolation, destruction/construction sync, and the HUD.
// The server is authoritative for everything; this file is display + input.

import { client } from "snack:client";
import * as THREE from "three";
import {
  HEADSHOT_HEIGHT,
  INPUT_REDUNDANCY,
  MAX_HP,
  OOB_LIMIT_TICKS,
  TEAM_NAMES,
  TICK_MS,
  TICK_RATE,
} from "./shared/constants.js";
import {
  CLASSES,
  WEAPON_IDX,
  WEAPON_LIST,
  classPrimaryIdx,
  secondaryIdxFor,
} from "./shared/weapons.js";
import {
  addCrater,
  APRON_OUTER,
  BACKDROP_OUTER,
  baseHeightAt,
  biomeAt,
  BIOME_FOREST,
  BIOME_MARSH,
  BIOME_ROCKY,
  chunksTouching,
  craterList,
  heightAt,
  inEnemyBase,
  initMap,
  MAP,
  mapSeed,
  PANEL_HP,
  type PanelDef,
  type PanelMaterial,
  PLAY_HALF,
  resetCraters,
  ringMesh,
  roadAt,
  slabOfPiece,
  TERRAIN_CHUNKS,
  terrainChunkMesh,
  WATER_SURFACE_Y,
  ZONES,
} from "./shared/map.js";
import { RUBBLE_HEIGHT } from "./shared/constants.js";
import { BUILT_PANEL_ID_BASE } from "./shared/map.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { parseServerMsg, SPAWN_AUTO, SPAWN_HQ, type PlayerInfo } from "./shared/messages.js";
import {
  decodeSnapshot,
  encodeInputs,
  EV_EXPLOSION,
  EV_HIT_PLAYER,
  EV_MELEE,
  EV_PANEL_HIT,
  EV_TRACER,
  type GameEvent,
  quantizeAngle,
  quantizeMove,
  RF_DEAD,
  RF_PROTECTED,
  RF_TEAM,
  type Snapshot,
  SS_DEAD,
  weaponByteActive,
  type ZoneSnap,
} from "./shared/netCodec.js";
import {
  activeWeapon,
  addPanelBody,
  addRubbleBody,
  applyCraterBodies,
  type Body,
  buildPlacement,
  type CharState,
  muzzleOrigin,
  perturb,
  spreadFor,
  createGameWorld,
  createGrenadeBody,
  createPlayerBody,
  destroyGameWorld,
  EYE_HEIGHT,
  joltFreeMemory,
  type GameWorld,
  type InputCmd,
  makeChar,
  PLAYER_FLOAT_HEIGHT,
  PLAYER_HALF_HEIGHT,
  readChar,
  removeGrenadeBody,
  pieceIdFromHit,
  rebuildSlabBody,
  removePanelBody,
  stepPlayerController,
  writeChar,
  ZERO_INPUT,
} from "./shared/physics.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";

const TEAM_COLORS = [0xd23f3f, 0x3a7be8]; // red vs blue
const TEAM_COLORS_CSS = ["#d23f3f", "#3a7be8"];

// ---------------------------------------------------------------------------
// Renderer / scene.

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.style.cssText =
  "margin:0;overflow:hidden;background:#0c0f14;touch-action:none;overscroll-behavior:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;";
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8cfe0);
scene.fog = new THREE.Fog(0xb8cfe0, 90, 230);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 360);
const hemi = new THREE.HemisphereLight(0xdcebfb, 0x5a6147, 0.62);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff1d6, 2.0);
sun.position.set(48, 40, -26); // lower & raking, for more terrain relief
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 160;
const span = MAP.size / 2 + 8;
sun.shadow.camera.left = -span;
sun.shadow.camera.right = span;
sun.shadow.camera.top = span;
sun.shadow.camera.bottom = -span;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(sun.target);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Map visuals.

// Texture-free voxel look: every piece is a crisp beveled solid in a
// hand-picked palette with deterministic per-piece variation — shape, light,
// and color variance do the work textures used to.

function hash01(id: number, salt: number): number {
  let h = Math.imul(id + Math.imul(salt, 0x9e3779b9), 2654435761);
  h ^= h >>> 15;
  return ((h >>> 8) % 10000) / 10000;
}

const voxelMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.92,
  metalness: 0,
  flatShading: true,
});
const glassMat = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  roughness: 0.08,
  metalness: 0,
  transparent: true,
  opacity: 0.32,
  depthWrite: false,
});

const ladderMat = new THREE.MeshStandardMaterial({
  color: 0x6f6356,
  roughness: 0.9,
  flatShading: true,
});

const MAT = {
  wall: new THREE.MeshStandardMaterial({ color: 0x9b958a, roughness: 1, flatShading: true }),
  rubble: new THREE.MeshStandardMaterial({ color: 0x6e6a62, roughness: 1, flatShading: true }),
};

// Unit geometries, scaled per instance to each piece's extents: beveled boxes
// for masonry (the bevel catches light, so every brick reads as a brick) and
// foliage clumps, faceted cylinders for logs and trunks, soft-cornered lumps
// for rocks.
const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  bevel: new RoundedBoxGeometry(1, 1, 1, 1, 0.055),
  rock: new RoundedBoxGeometry(1, 1, 1, 2, 0.2),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 7),
  decal: new THREE.PlaneGeometry(1, 1),
};

// How each piece material renders: shape + debris color.
const PIECE_STYLE: Record<
  PanelMaterial,
  { geo: THREE.BufferGeometry; mat: THREE.Material; debris: number }
> = {
  brick: { geo: GEO.bevel, mat: voxelMat, debris: 0xa66045 },
  log: { geo: GEO.cyl, mat: voxelMat, debris: 0x6e5439 },
  plank: { geo: GEO.bevel, mat: voxelMat, debris: 0x9a7a52 },
  post: { geo: GEO.bevel, mat: voxelMat, debris: 0x6e5439 },
  trunk: { geo: GEO.cyl, mat: voxelMat, debris: 0x6e5439 },
  canopy: { geo: GEO.bevel, mat: voxelMat, debris: 0x4d7a3a },
  crate: { geo: GEO.bevel, mat: voxelMat, debris: 0x9a7a52 },
  sandbag: { geo: GEO.bevel, mat: voxelMat, debris: 0x9a8f72 },
  rock: { geo: GEO.rock, mat: voxelMat, debris: 0x8d8a84 },
  concrete: { geo: GEO.bevel, mat: voxelMat, debris: 0x9a9da1 },
  glass: { geo: GEO.box, mat: glassMat, debris: 0xd8eef7 },
  rubble: { geo: GEO.bevel, mat: voxelMat, debris: 0x847d72 },
  metal: { geo: GEO.bevel, mat: voxelMat, debris: 0x8a949e },
  stone: { geo: GEO.bevel, mat: voxelMat, debris: 0x9a958c },
  stair: { geo: GEO.bevel, mat: voxelMat, debris: 0x6e5d49 },
};

// Pre-fractured unit boxes: one half survives, the break face is a jagged
// surface displaced by a position-hashed offset (coincident vertices get the
// same offset, so the surface stays sealed). Three deterministic variants;
// fragments pick one by palette seed.
function makeFractureGeo(variant: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1, 2, 2, 2);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (x < 0.1) continue; // keep the intact half pristine
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h = hash01(Math.round((y + 2 * z) * 97) + variant * 7919, 41);
    const h2 = hash01(Math.round((y - z) * 131) + variant * 104729, 42);
    pos.setX(i, x - 0.12 - h * 0.3);
    if (Math.abs(y) < 0.49) pos.setY(i, y + (h2 - 0.5) * 0.12);
  }
  const out = geo.toNonIndexed();
  out.computeVertexNormals();
  return out;
}

const FRACTURE_GEOS = [makeFractureGeo(0), makeFractureGeo(1), makeFractureGeo(2)];

// Canopy palettes by "band" (species/season). A tree tags every clump with a
// seed whose low 3 bits pick the band, so a whole tree shares a species/season
// while each clump still varies — see pieceColor("canopy").
const CANOPY_BANDS: number[][] = [
  [0x4e8a3c, 0x5f9c46, 0x3f7a34, 0x6fae52], // 0 summer green (broadleaf)
  [0x356f30, 0x2f6a2c, 0x428039], // 1 deep lush green
  [0x7a9a3e, 0x8aa84a, 0x6e8c34], // 2 yellow-green / late summer
  [0xc8862f, 0xd89a3a, 0xb87328], // 3 autumn gold/orange
  [0xb04e2a, 0xc25a30, 0x9a3f24], // 4 autumn red/rust
  [0x2c5733, 0x244c2c, 0x35663b], // 5 dark conifer
  [0x8a8a4a, 0x9a9656, 0x7c7c40], // 6 dry olive
  [0x6e5a3a, 0x7a6440, 0x5e4c30], // 7 dead brown
];

// The palette: deterministic per-piece color so a wall is a thousand subtly
// different bricks, not a flat sheet.
function pieceColor(def: PanelDef, out: THREE.Color): THREE.Color {
  // Runtime pieces (fallen, rubble) keep the palette of the piece they came
  // from via `seed` — a brick doesn't change color by falling off the wall.
  const basis = def.seed ?? def.id;
  const h1 = hash01(basis, 1);
  const h2 = hash01(basis, 2);
  switch (def.material) {
    case "brick": {
      out.setHSL(0.024 + h1 * 0.022, 0.52 + h2 * 0.12, 0.4 + h1 * 0.12);
      if (h2 < 0.08)
        out.multiplyScalar(0.62); // the odd over-fired dark brick
      else if (h2 > 0.94) out.multiplyScalar(1.28); // and the odd pale one
      return out;
    }
    case "log":
      return out.setHSL(0.07 + h1 * 0.02, 0.38 + h2 * 0.1, 0.33 + h1 * 0.1);
    case "plank":
      return out.setHSL(0.082 + h1 * 0.015, 0.4 + h2 * 0.08, 0.45 + h1 * 0.13);
    case "post":
      return out.setHSL(0.07 + h1 * 0.015, 0.38, 0.27 + h1 * 0.06);
    case "trunk": {
      // Low 2 bits of the seed pick the bark: oak (grey-brown), pine (red-brown), birch (pale).
      const bark = basis & 3;
      const t1 = hash01(basis >> 2, 1);
      if (bark === 2) return out.setHSL(0.1, 0.06, 0.7 + t1 * 0.12); // birch
      if (bark === 1) return out.setHSL(0.055 + t1 * 0.01, 0.45, 0.3 + t1 * 0.08); // pine
      return out.setHSL(0.072 + t1 * 0.015, 0.42, 0.24 + t1 * 0.09); // oak
    }
    case "canopy": {
      // Low 3 bits of the seed pick the species/season band; the rest varies per clump.
      const band = CANOPY_BANDS[basis & 7];
      const v = hash01(basis >> 3, 2);
      out.setHex(band[Math.floor(v * band.length) % band.length]);
      return out.multiplyScalar(0.86 + hash01(basis >> 3, 4) * 0.28);
    }
    case "crate":
      return out.setHSL(0.088 + h1 * 0.012, 0.46 + h2 * 0.08, 0.5 + h1 * 0.1);
    case "sandbag":
      return out.setHSL(0.112 + h1 * 0.012, 0.2 + h2 * 0.06, 0.5 + h1 * 0.12);
    case "rock": {
      // Low 2 bits pick rock type: granite (grey), sandstone (tan), basalt
      // (dark), mossy (green-grey). The rest drives strata lightness.
      const kind = basis & 3;
      const r1 = hash01(basis >> 2, 1);
      const r2 = hash01(basis >> 2, 2);
      if (kind === 1) return out.setHSL(0.09, 0.17, 0.44 + r1 * 0.16); // sandstone
      if (kind === 2) return out.setHSL(0.62, 0.05, 0.26 + r1 * 0.12); // basalt
      if (kind === 3) return out.setHSL(0.26, 0.16, 0.34 + r1 * 0.14); // mossy
      return out.setHSL(0.085 + r1 * 0.02, 0.04 + r2 * 0.05, 0.42 + r1 * 0.2); // granite
    }
    case "concrete":
      return out.setHSL(0.58 + h1 * 0.02, 0.02 + h2 * 0.03, 0.54 + h1 * 0.12);
    case "glass":
      return out.setHex(0xd6eef7);
    case "rubble":
      return out.setHSL(0.07 + h1 * 0.03, 0.1 + h2 * 0.1, 0.36 + h1 * 0.14);
    case "metal":
      return out.setHSL(0.57 + h1 * 0.02, 0.07, 0.5 + h1 * 0.1);
    case "stone":
      // Warm grey flagstone, piece-to-piece tonal drift so a floor reads as
      // laid slabs rather than one slab.
      return out.setHSL(0.09 + h1 * 0.03, 0.05 + h2 * 0.04, 0.46 + h1 * 0.14);
    case "stair":
      // Heavy dark timber treads.
      return out.setHSL(0.075 + h1 * 0.012, 0.34, 0.24 + h1 * 0.06);
  }
}

let mapGroup = new THREE.Group();
scene.add(mapGroup);

// Static map pieces live in one InstancedMesh pool per material (~6k pieces,
// ~12 draw calls); deployed cover and rubble chunks arrive at runtime as
// individual meshes.
interface PieceSlot {
  mesh: THREE.InstancedMesh;
  index: number;
  base: number; // palette color, hex
}
const panelSlots = new Map<number, PieceSlot>();
const builtMeshes = new Map<number, THREE.Mesh>();
const panelDefs = new Map<number, PanelDef>(); // map + built, for tint/debris

// Runtime pieces (rubble chunks, settled fallen pieces) arrive in unbounded
// numbers, so they live in pre-sized instanced pools with freelists — a
// thousand persistent loose pieces cost two draw calls, not one mesh each.
// Boxes cover everything except logs/trunks, which keep their cylinders.
class LoosePool {
  mesh: THREE.InstancedMesh | null = null;
  private readonly free: number[] = [];
  constructor(private readonly cap: number) {}

  rebuild(geo: THREE.BufferGeometry, parent: THREE.Group): void {
    this.mesh = new THREE.InstancedMesh(geo, voxelMat, this.cap);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.free.length = 0;
    for (let i = this.cap - 1; i >= 0; i--) {
      this.mesh.setMatrixAt(i, ZERO_SCALE);
      this.free.push(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    parent.add(this.mesh);
  }

  claim(def: PanelDef): PieceSlot | null {
    if (!this.mesh || this.free.length === 0) return null;
    const index = this.free.pop()!;
    pieceColor(def, _col);
    this.mesh.setMatrixAt(index, pieceMatrix(def));
    this.mesh.setColorAt(index, _col);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    return { mesh: this.mesh, index, base: _col.getHex() };
  }

  release(slot: PieceSlot): boolean {
    if (slot.mesh !== this.mesh || !this.mesh) return false;
    this.free.push(slot.index);
    return true;
  }
}

const looseBoxes = new LoosePool(1500);
const looseCyls = new LoosePool(300);
const fracturePools = [new LoosePool(450), new LoosePool(450), new LoosePool(450)];

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ZERO_SCALE = new THREE.Matrix4().makeScale(0, 0, 0);

// Logs lie on their side (cylinder axis along the wall), trunks stand up,
// canopy cubes and rocks get a per-piece twist so they don't read as tiled.
const _qDef = new THREE.Quaternion();

function pieceMatrix(def: PanelDef): THREE.Matrix4 {
  _pos.set(def.x, def.y, def.z);
  if (def.rot) {
    // A settled piece: physics box was axis-aligned, so the resting rotation
    // composes onto whatever visual orientation the material uses.
    _qDef.set(def.rot[0], def.rot[1], def.rot[2], def.rot[3]);
    if (def.material === "log" && def.ex >= def.ez) {
      _q.setFromAxisAngle(Z_AXIS, Math.PI / 2).premultiply(_qDef);
      _scl.set(def.ey, def.ex, def.ez);
    } else if (def.material === "log") {
      _q.setFromAxisAngle(X_AXIS, Math.PI / 2).premultiply(_qDef);
      _scl.set(def.ex, def.ez, def.ey);
    } else {
      _q.copy(_qDef);
      _scl.set(def.ex, def.ey, def.ez);
    }
    return _m4.compose(_pos, _q, _scl);
  }
  if (def.material === "log" && def.ex >= def.ez) {
    _q.setFromAxisAngle(Z_AXIS, Math.PI / 2);
    _scl.set(def.ey, def.ex, def.ez);
  } else if (def.material === "log") {
    _q.setFromAxisAngle(X_AXIS, Math.PI / 2);
    _scl.set(def.ex, def.ez, def.ey);
  } else {
    if (def.material === "canopy" || def.material === "rubble") {
      _q.setFromAxisAngle(Y_AXIS, (def.id % 7) * 0.9);
    } else if (def.material === "rock") {
      _q.setFromAxisAngle(Y_AXIS, (hash01(def.id, 3) - 0.5) * 0.7);
    } else {
      _q.identity();
    }
    _scl.set(def.ex, def.ey, def.ez);
  }
  return _m4.compose(_pos, _q, _scl);
}

// --- Terrain: per-chunk faceted meshes from the shared heightfield (the
// physics mesh chunks identically), low-poly flat-shaded with per-face color
// jitter. Chunks rebuild when a crater message lands.

const terrainChunkVisuals = new Map<number, THREE.Mesh>();
const terrainMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 1,
  metalness: 0,
  flatShading: true,
});
// Richer ground palette: several greens/browns plus rock + sand, blended by
// macro color-noise, slope, height, shoreline and roads (see colorTerrainFace).
const T_GRASS_A = new THREE.Color(0x5a8746);
const T_GRASS_B = new THREE.Color(0x6f9850);
const T_GRASS_C = new THREE.Color(0x466e3b);
const T_DRY = new THREE.Color(0x8d934f);
const T_HIGH = new THREE.Color(0x96a76a);
const T_ROCK = new THREE.Color(0x6b6256);
const T_ROCK_HI = new THREE.Color(0x847b6d);
const T_SAND = new THREE.Color(0xb6a578);
const TERRAIN_SCORCH = new THREE.Color(0x4f463b);
const TERRAIN_BED = new THREE.Color(0x6a6f52); // silty riverbed
const ROAD_DIRT = new THREE.Color(0x7a6446);
const ROAD_COBBLE = new THREE.Color(0x8a857d);
// Biome ground casts (lerped over the base grass so borders stay soft).
const T_FOREST_FLOOR = new THREE.Color(0x42632f); // darker, richer woodland
const T_ROCKY_GROUND = new THREE.Color(0x7d7a5e); // thin bleached highland turf
const T_MARSH = new THREE.Color(0x4c5c33); // wet olive bog

function smoothstep01(x: number, a: number, b: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Cheap 2D value noise in [0,1] for macro color variation (client-only, so it
// need not match the server's valueNoise).
function vnoise(x: number, z: number, freq: number): number {
  const xs = x * freq;
  const zs = z * freq;
  const ix = Math.floor(xs);
  const iz = Math.floor(zs);
  const fx = xs - ix;
  const fz = zs - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number): number => {
    let n = Math.imul((a | 0) + Math.imul(b | 0, 0x9e3779b9), 2654435761);
    n ^= n >>> 15;
    return ((n >>> 8) % 10000) / 10000;
  };
  const a = h(ix, iz);
  const b = h(ix + 1, iz);
  const c = h(ix, iz + 1);
  const d = h(ix + 1, iz + 1);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

// The pristine base heights, cached on a 1m grid. Terrain-face coloring reads
// the heightfield ~5× per face across ~100k faces, and every exact
// baseHeightAt walks river/road/noise tables — it was ~5s of the load. The
// pristine field never changes (craters layer on top in heightAt), so one
// grid pass + bilinear reads replaces the half-million exact calls. Visual
// path only: the shared sim keeps calling the exact function.
let baseHGrid: Float32Array | null = null;
let baseHGridN = 0; // points per side
let baseHGridMin = 0;
const BASEH_PAD = 8; // cover AO taps just past the core edge

function warmBaseHeightGrid(): void {
  if (baseHGrid) return;
  baseHGridMin = -MAP.size / 2 - BASEH_PAD;
  baseHGridN = MAP.size + 2 * BASEH_PAD + 1; // 1m step
  const g = new Float32Array(baseHGridN * baseHGridN);
  for (let j = 0; j < baseHGridN; j++) {
    const z = baseHGridMin + j;
    for (let i = 0; i < baseHGridN; i++) {
      g[j * baseHGridN + i] = baseHeightAt(baseHGridMin + i, z);
    }
  }
  baseHGrid = g;
}

// Bilinear read of the cached pristine grid; falls back to the exact function
// outside it (the apron/backdrop rings sample far past the core).
function baseHeightFast(x: number, z: number): number {
  const g = baseHGrid;
  const i = Math.floor(x - baseHGridMin);
  const j = Math.floor(z - baseHGridMin);
  if (!g || i < 0 || j < 0 || i >= baseHGridN - 1 || j >= baseHGridN - 1) {
    return baseHeightAt(x, z);
  }
  const tx = x - baseHGridMin - i;
  const tz = z - baseHGridMin - j;
  const a = g[j * baseHGridN + i];
  const b = g[j * baseHGridN + i + 1];
  const c = g[(j + 1) * baseHGridN + i];
  const d = g[(j + 1) * baseHGridN + i + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

// Analytic ambient occlusion from the heightfield: faces lower than their
// neighborhood (hollows, crater bowls, the river channel) darken; bumps lift.
function computeFaceAO(cx: number, cy: number, cz: number): number {
  const r = 3;
  const avg =
    (baseHeightFast(cx + r, cz) +
      baseHeightFast(cx - r, cz) +
      baseHeightFast(cx, cz + r) +
      baseHeightFast(cx, cz - r)) *
    0.25;
  return Math.max(0.76, Math.min(1.06, 1 + (cy - avg) * 0.35));
}

const _trock = new THREE.Color();
const _troad = new THREE.Color();

// The shared per-face ground color: macro-noise green patches, dry/high
// bleaching, slope rock, shoreline sand, crater scorch, riverbed silt, baked
// roads, and analytic AO. Used by both the core terrain and the apron/backdrop.
function colorTerrainFace(c: THREE.Color, cx: number, cy: number, cz: number, ny: number): void {
  const m1 = vnoise(cx, cz, 0.045);
  const m2 = vnoise(cx + 99, cz + 33, 0.13);
  c.copy(T_GRASS_A).lerp(T_GRASS_B, m1);
  c.lerp(T_GRASS_C, smoothstep01(m2, 0.55, 1));
  c.lerp(T_DRY, smoothstep01(m2, 0, 0.25) * 0.55);
  // Biome cast: woodland floors darken, the rocky tops bleach thin, marshes
  // go wet olive. Borders are already noise-warped map-side, so a flat lerp
  // per face reads as organic transition.
  const biome = biomeAt(cx, cz);
  if (biome === BIOME_FOREST) c.lerp(T_FOREST_FLOOR, 0.42);
  else if (biome === BIOME_ROCKY) c.lerp(T_ROCKY_GROUND, 0.4);
  else if (biome === BIOME_MARSH) c.lerp(T_MARSH, 0.5);
  c.lerp(T_HIGH, Math.max(0, Math.min(1, (cy - 0.4) / 1.2)) * 0.4);
  const slope = 1 - ny;
  const rock = smoothstep01(slope, 0.3, 0.6);
  if (rock > 0) {
    _trock.copy(T_ROCK).lerp(T_ROCK_HI, vnoise(cx + 7, cz + 7, 0.2));
    c.lerp(_trock, rock);
  }
  const aboveWater = cy - WATER_SURFACE_Y;
  const shore = smoothstep01(aboveWater, 0.5, 0) * smoothstep01(aboveWater, -0.15, 0.06);
  c.lerp(T_SAND, Math.min(1, shore) * 0.85 * (1 - rock));
  const dug = baseHeightFast(cx, cz) - cy;
  if (dug > 0.08) c.lerp(TERRAIN_SCORCH, Math.min(1, dug / 0.6));
  if (cy < WATER_SURFACE_Y + 0.05) {
    c.lerp(TERRAIN_BED, Math.min(1, (WATER_SURFACE_Y + 0.05 - cy) / 0.5));
  }
  const road = roadAt(cx, cz);
  if (road.w > 0) {
    _troad.copy(road.cobble ? ROAD_COBBLE : ROAD_DIRT);
    _troad.multiplyScalar(0.86 + vnoise(cx * 2, cz * 2, 1) * 0.26);
    c.lerp(_troad, road.w);
  }
  c.multiplyScalar(computeFaceAO(cx, cy, cz));
  c.multiplyScalar(0.95 + vnoise(cx * 3.1, cz * 3.1, 1) * 0.1);
}

const poleMat = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7 });
const flagGeo = new THREE.PlaneGeometry(1.55, 0.95);
const zoneFlags: Array<{
  flag: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  baseY: number;
  x: number;
  z: number;
}> = [];
const NEUTRAL_FLAG = 0xd0d0cc;

function stepFlags(now: number): void {
  for (let i = 0; i < zoneFlags.length && i < zoneState.length; i++) {
    const zf = zoneFlags[i];
    const zn = zoneState[i];
    const owner = zn.owner;
    const towards = zn.v < 0 ? 0 : 1;
    const color =
      owner >= 0 ? TEAM_COLORS[owner] : Math.abs(zn.v) > 5 ? TEAM_COLORS[towards] : NEUTRAL_FLAG;
    zf.mat.color.setHex(color);
    zf.mat.opacity = 1;
    const h = 1.6 + (Math.abs(zn.v) / 100) * 4.4;
    zf.flag.position.y = zf.baseY + h;
    zf.flag.rotation.y = Math.sin(now / 900 + i) * 0.25;
  }
}

// A ground-height field baked from the terrain, so the water shader knows how
// deep it is at every point (shallow->deep color, shoreline foam, edge fade).
function makeWaterHeightTexture(): THREE.DataTexture {
  // RGBA8 (universally linear-filterable) with ground height encoded into the
  // [-2,2]m range; the shader decodes r*4-2. (Float textures aren't reliably
  // linear-filterable across GPUs.)
  warmBaseHeightGrid(); // one grid pass serves this texture AND face coloring
  const N = 192;
  const span = MAP.size;
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -span / 2 + (i / (N - 1)) * span;
      const z = -span / 2 + (j / (N - 1)) * span;
      const v = Math.max(0, Math.min(255, Math.round(((baseHeightFast(x, z) + 2) / 4) * 255)));
      const o = (j * N + i) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// The river/lakes: one plane at water level, but a custom shader makes it read
// as flowing water — depth-based color, shoreline foam, a fresnel sky tint, and
// two scrolling noise layers — instead of a flat blue decal. It discards over
// dry land, so it only shows where the terrain dips below the surface.
const waterMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  fog: true,
  uniforms: THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uSurfaceY: { value: WATER_SURFACE_Y },
      uHalf: { value: MAP.size / 2 },
    },
  ]),
  vertexShader: `
    #include <fog_pars_vertex>
    varying vec3 vWorld;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      vec4 mvPosition = viewMatrix * wp;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `,
  fragmentShader: `
    #include <fog_pars_fragment>
    uniform float uTime;
    uniform float uSurfaceY;
    uniform float uHalf;
    uniform sampler2D uHeight;
    varying vec3 vWorld;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
    float noise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      float a=hash(i), b=hash(i+vec2(1.0,0.0)), c=hash(i+vec2(0.0,1.0)), d=hash(i+vec2(1.0,1.0));
      return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
    }
    void main() {
      vec2 uv = (vWorld.xz / (2.0 * uHalf)) + 0.5;
      float ground = texture2D(uHeight, uv).r * 4.0 - 2.0;
      float depth = uSurfaceY - ground;
      if (depth <= 0.002) discard; // dry land
      depth = clamp(depth, 0.0, 1.3);
      vec3 shallow = vec3(0.32, 0.55, 0.57);
      vec3 deep = vec3(0.05, 0.19, 0.34);
      vec3 col = mix(shallow, deep, smoothstep(0.0, 1.0, depth));
      float t = uTime;
      float n = noise(vWorld.xz * 0.6 + vec2(0.0, t * 0.45)) * 0.5
              + noise(vWorld.xz * 1.7 - vec2(t * 0.6, 0.0)) * 0.5;
      col += (n - 0.5) * 0.10;
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - max(V.y, 0.0), 3.0);
      col = mix(col, vec3(0.62, 0.72, 0.82), fres * 0.5);
      float foam = smoothstep(0.24, 0.0, depth) * (0.5 + 0.5 * noise(vWorld.xz * 2.6 + t * 1.2));
      col = mix(col, vec3(0.90, 0.95, 0.97), foam * 0.6);
      float alpha = smoothstep(0.0, 0.14, depth) * 0.86 + foam * 0.3;
      gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
      #include <fog_fragment>
    }
  `,
});
(waterMat.uniforms as { uHeight?: { value: THREE.Texture } }).uHeight = {
  value: makeWaterHeightTexture(),
};

function makeTerrainChunkMesh(ci: number, cj: number): THREE.Mesh {
  const data = terrainChunkMesh(ci, cj);
  let geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(data.vertices, 3));
  geo.setIndex(data.indices);
  geo = geo.toNonIndexed(); // flat faceted normals + per-face color
  geo.computeVertexNormals();
  const pos = geo.getAttribute("position");
  const norm = geo.getAttribute("normal");
  const colors: number[] = [];
  const c = new THREE.Color();
  for (let f = 0; f < pos.count; f += 3) {
    const cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
    const cy = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
    const cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
    colorTerrainFace(c, cx, cy, cz, norm.getY(f));
    colors.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, terrainMat);
  mesh.receiveShadow = true;
  return mesh;
}

function rebuildTerrainChunk(ci: number, cj: number): void {
  const key = ci * TERRAIN_CHUNKS + cj;
  const old = terrainChunkVisuals.get(key);
  if (old) {
    mapGroup.remove(old);
    old.geometry.dispose();
  }
  const mesh = makeTerrainChunkMesh(ci, cj);
  terrainChunkVisuals.set(key, mesh);
  mapGroup.add(mesh);
}

// Apron + backdrop: coarse terrain rings continuing the world past the core, so
// the arena reads as boundless (no perimeter walls). The apron is collidable
// and faceted like the core; the far backdrop fades toward the fog so its outer
// edge is never visible.
function makeRingVisual(inner: number, outer: number, cell: number, fade: boolean): THREE.Mesh {
  const data = ringMesh(inner, outer, cell);
  let geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(data.vertices, 3));
  geo.setIndex(data.indices);
  geo = geo.toNonIndexed();
  geo.computeVertexNormals();
  const pos = geo.getAttribute("position");
  const norm = geo.getAttribute("normal");
  const colors: number[] = [];
  const c = new THREE.Color();
  const fogCol = new THREE.Color(0xb8cfe0);
  for (let f = 0; f < pos.count; f += 3) {
    const cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
    const cy = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
    const cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
    colorTerrainFace(c, cx, cy, cz, norm.getY(f));
    if (fade) {
      const dist = Math.max(Math.abs(cx), Math.abs(cz));
      const k = Math.max(0, Math.min(1, (dist - APRON_OUTER) / (BACKDROP_OUTER - APRON_OUTER)));
      c.lerp(fogCol, k * 0.85);
    }
    for (let v = 0; v < 3; v++) colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const mesh = new THREE.Mesh(geo, terrainMat);
  mesh.receiveShadow = !fade;
  return mesh;
}

// --- Voxel clouds: chunky white box clusters drifting over the arena. ---

const cloudGroup = new THREE.Group();
const cloudMat = new THREE.MeshStandardMaterial({
  color: 0xf4f8fb,
  roughness: 1,
  transparent: true,
  opacity: 0.92,
  flatShading: true,
});

function makeClouds(): void {
  const span = MAP.size * 0.85;
  for (let k = 0; k < 11; k++) {
    const cluster = new THREE.Group();
    const n = 4 + Math.floor(hash01(k, 21) * 6);
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(GEO.box, cloudMat);
      m.scale.set(
        4 + hash01(k * 17 + i, 22) * 7,
        1.4 + hash01(k * 17 + i, 23) * 1.8,
        2.5 + hash01(k * 17 + i, 24) * 4,
      );
      m.position.set(
        (hash01(k * 17 + i, 25) - 0.5) * 13,
        (hash01(k * 17 + i, 26) - 0.5) * 1.6,
        (hash01(k * 17 + i, 27) - 0.5) * 8,
      );
      cluster.add(m);
    }
    cluster.position.set(
      (hash01(k, 28) - 0.5) * 2 * span,
      30 + hash01(k, 29) * 14,
      (hash01(k, 30) - 0.5) * 2 * span,
    );
    cluster.userData.drift = 0.5 + hash01(k, 31) * 0.7;
    cloudGroup.add(cluster);
  }
  scene.add(cloudGroup);
}
makeClouds();

function stepClouds(dt: number): void {
  const limit = MAP.size * 0.95;
  for (const cluster of cloudGroup.children) {
    cluster.position.x += (cluster.userData.drift as number) * dt;
    if (cluster.position.x > limit) cluster.position.x = -limit;
  }
}

// --- Bullet decals: small dark marks where shots land, capped pool. ---

const decalMat = new THREE.MeshBasicMaterial({
  color: 0x191511,
  transparent: true,
  opacity: 0.8,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  depthWrite: false,
});
const decals: THREE.Mesh[] = [];
const _decalN = new THREE.Vector3();
const FORWARD_Z = new THREE.Vector3(0, 0, 1);

// Approximate the surface normal at a hit: panels are axis-aligned boxes
// (pick the face the point is on); anything else is treated as terrain.
function surfaceNormalAt(body: Body | null, point: THREE.Vector3): THREE.Vector3 {
  const pieceId = body ? hitPieceId(body, [point.x, point.y, point.z]) : null;
  if (pieceId !== null) {
    const def = panelDefs.get(pieceId);
    if (def) {
      const rx = (point.x - def.x) / (def.ex / 2 || 1);
      const ry = (point.y - def.y) / (def.ey / 2 || 1);
      const rz = (point.z - def.z) / (def.ez / 2 || 1);
      const ax = Math.abs(rx);
      const ay = Math.abs(ry);
      const az = Math.abs(rz);
      if (ax >= ay && ax >= az) return _decalN.set(Math.sign(rx), 0, 0);
      if (ay >= az) return _decalN.set(0, Math.sign(ry), 0);
      return _decalN.set(0, 0, Math.sign(rz));
    }
  }
  // Terrain: gradient of the heightfield.
  const e = 0.25;
  const dhdx = (heightAt(point.x + e, point.z) - heightAt(point.x - e, point.z)) / (2 * e);
  const dhdz = (heightAt(point.x, point.z + e) - heightAt(point.x, point.z - e)) / (2 * e);
  return _decalN.set(-dhdx, 1, -dhdz).normalize();
}

function spawnBulletDecal(point: THREE.Vector3, normal: THREE.Vector3, panelId?: number): void {
  if (decals.length >= 240) {
    const old = decals.shift()!;
    old.parent?.remove(old);
  }
  const m = new THREE.Mesh(GEO.decal, decalMat);
  const s = 0.07 + Math.random() * 0.08;
  m.scale.set(s, s, 1);
  m.position.copy(point).addScaledVector(normal, 0.012);
  m.quaternion.setFromUnitVectors(FORWARD_Z, normal);
  m.rotateZ(Math.random() * Math.PI * 2);
  m.userData.panelId = panelId; // undefined = terrain
  mapGroup.add(m); // dies with the map on round reset
  decals.push(m);
}

// Marks die with the surface they're on: piece decals when the piece is
// destroyed, ground decals when a crater swallows the ground.
function removeDecalsForPanels(ids: ReadonlySet<number>): void {
  for (let i = decals.length - 1; i >= 0; i--) {
    const pid = decals[i].userData.panelId as number | undefined;
    if (pid !== undefined && ids.has(pid)) {
      decals[i].parent?.remove(decals[i]);
      decals.splice(i, 1);
    }
  }
}

function removeDecalsInCrater(c: { x: number; z: number; r: number }): void {
  for (let i = decals.length - 1; i >= 0; i--) {
    const d = decals[i];
    if (
      d.userData.panelId === undefined &&
      Math.hypot(d.position.x - c.x, d.position.z - c.z) < c.r + 0.3
    ) {
      d.parent?.remove(d);
      decals.splice(i, 1);
    }
  }
}

// Startup stage timings (exposed via __fps.bootPerf, logged once per stage) —
// the load screen hides real seconds of synchronous work; this says where.
const bootPerf: Record<string, number> = {};
let bootPerfSeq = 0;

function recordBootStage(stage: string, t0: number): void {
  const ms = performance.now() - t0;
  bootPerf[`${++bootPerfSeq}:${stage}`] = Math.round(ms);
  console.log(`[fps] ${stage}: ${ms.toFixed(0)}ms (at ${performance.now().toFixed(0)}ms)`);
}

let mapVisualsBuilt = false;

function buildMapVisuals(): void {
  const tBuild0 = performance.now();
  mapVisualsBuilt = true;
  scene.remove(mapGroup);
  mapGroup.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) o.dispose();
  });
  mapGroup = new THREE.Group();
  scene.add(mapGroup);
  panelSlots.clear();
  builtMeshes.clear();
  panelDefs.clear();
  terrainChunkVisuals.clear();
  decals.length = 0;
  corpses.length = 0; // their groups died with the old mapGroup
  fallingChunks.clear(); // ditto

  // The map may have been re-seeded since the last build: refresh the water
  // depth texture (which also warms the pristine height grid the face
  // coloring below reads).
  {
    const u = (waterMat.uniforms as { uHeight: { value: THREE.Texture } }).uHeight;
    u.value.dispose();
    u.value = makeWaterHeightTexture();
  }

  for (let ci = 0; ci < TERRAIN_CHUNKS; ci++) {
    for (let cj = 0; cj < TERRAIN_CHUNKS; cj++) {
      rebuildTerrainChunk(ci, cj);
    }
  }
  recordBootStage("buildMapVisuals:terrain", tBuild0);
  const tRings0 = performance.now();
  // The world beyond the core: a collidable apron then a fog-bound backdrop.
  // (Roads are baked into the terrain faces in colorTerrainFace — no overlay.)
  mapGroup.add(makeRingVisual(MAP.size / 2 - 4, APRON_OUTER, 8, false));
  mapGroup.add(makeRingVisual(APRON_OUTER, BACKDROP_OUTER, 18, true));
  recordBootStage("buildMapVisuals:rings", tRings0);

  // Conquest flags: a pole at each zone center, cloth raising toward the
  // capturing team's color.
  zoneFlags.length = 0;
  for (const def of ZONES) {
    const baseY = heightAt(def.x, def.z);
    const pole = new THREE.Mesh(GEO.box, poleMat);
    pole.scale.set(0.14, 7.2, 0.14);
    pole.position.set(def.x, baseY + 3.6, def.z);
    pole.userData.sharedGeo = true;
    pole.castShadow = true;
    mapGroup.add(pole);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd0d0cc,
      roughness: 0.85,
      side: THREE.DoubleSide,
    });
    const flag = new THREE.Mesh(flagGeo, mat);
    flag.position.set(def.x + 0.85, baseY + 2, def.z);
    mapGroup.add(flag);
    zoneFlags.push({ flag, mat, baseY, x: def.x, z: def.z });
  }

  const tRest0 = performance.now();
  // One translucent sheet at water level: it only shows where the terrain
  // dips below it (the river and the lakes).
  const water = new THREE.Mesh(new THREE.PlaneGeometry(MAP.size, MAP.size), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_SURFACE_Y;
  mapGroup.add(water);
  for (const s of MAP.statics) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), MAT.wall);
    mesh.position.set(s.x, s.y, s.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mapGroup.add(mesh);
  }

  const byMat = new Map<PanelMaterial, PanelDef[]>();
  for (const p of MAP.panels) {
    panelDefs.set(p.id, p);
    const list = byMat.get(p.material);
    if (list) list.push(p);
    else byMat.set(p.material, [p]);
  }
  for (const [material, defs] of byMat) {
    const style = PIECE_STYLE[material];
    const mesh = new THREE.InstancedMesh(style.geo, style.mat, defs.length);
    mesh.castShadow = material !== "glass";
    mesh.receiveShadow = true;
    for (let i = 0; i < defs.length; i++) {
      pieceColor(defs[i], _col);
      mesh.setMatrixAt(i, pieceMatrix(defs[i]));
      mesh.setColorAt(i, _col);
      panelSlots.set(defs[i].id, { mesh, index: i, base: _col.getHex() });
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mapGroup.add(mesh);
  }

  // Ladders: cosmetic rails + rungs over the climb volumes (the climbing
  // itself is shared controller logic on the map data).
  for (const l of MAP.ladders) {
    const group = new THREE.Group();
    group.position.set(l.x + l.nx * 0.16, 0, l.z + l.nz * 0.16);
    group.rotation.y = Math.atan2(l.nx, l.nz);
    const railGeo = new THREE.BoxGeometry(0.07, l.y1 + 0.25, 0.07);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(railGeo, ladderMat);
      rail.position.set(s * 0.31, (l.y1 + 0.25) / 2, 0);
      rail.castShadow = true;
      group.add(rail);
    }
    for (let y = 0.35; y < l.y1; y += 0.38) {
      const rung = new THREE.Mesh(GEO.box, ladderMat);
      rung.scale.set(0.62, 0.06, 0.06);
      rung.position.set(0, y, 0);
      rung.userData.sharedGeo = true;
      group.add(rung);
    }
    mapGroup.add(group);
  }

  looseBoxes.rebuild(GEO.bevel, mapGroup);
  looseCyls.rebuild(GEO.cyl, mapGroup);
  for (let i = 0; i < fracturePools.length; i++) {
    fracturePools[i].rebuild(FRACTURE_GEOS[i], mapGroup);
  }
  recordBootStage("buildMapVisuals:panels+rest", tRest0);
  recordBootStage("buildMapVisuals", tBuild0);
}

// Runtime pieces (rubble, settled fallen pieces, deployed cover) claim
// instanced pool slots, falling back to a mesh only if the pool is full.
function addBuiltPanelVisual(p: PanelDef): void {
  panelDefs.set(p.id, p);
  const cyl = p.material === "log" || p.material === "trunk";
  const pool =
    p.broken && !cyl
      ? fracturePools[(p.seed ?? p.id) % fracturePools.length]
      : cyl
        ? looseCyls
        : looseBoxes;
  const slot = pool.claim(p);
  if (slot) {
    panelSlots.set(p.id, slot);
    return;
  }
  const style = PIECE_STYLE[p.material];
  const mesh = new THREE.Mesh(style.geo, (style.mat as THREE.MeshStandardMaterial).clone());
  (mesh.material as THREE.MeshStandardMaterial).color.copy(pieceColor(p, _col));
  mesh.userData.ownMat = true;
  const m = pieceMatrix(p);
  m.decompose(mesh.position, mesh.quaternion, mesh.scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mapGroup.add(mesh);
  builtMeshes.set(p.id, mesh);
}

const RUBBLE_MAT = MAT.rubble;

function tintPanelDamage(id: number, hp: number): void {
  const def = panelDefs.get(id);
  if (!def) return;
  const damage = 1 - Math.max(0, Math.min(1, hp / PANEL_HP[def.material]));
  const slot = panelSlots.get(id);
  if (slot) {
    _col.setHex(slot.base).multiplyScalar(1 - damage * 0.6);
    slot.mesh.setColorAt(slot.index, _col);
    if (slot.mesh.instanceColor) slot.mesh.instanceColor.needsUpdate = true;
    return;
  }
  const mesh = builtMeshes.get(id);
  if (!mesh) return;
  (mesh.material as THREE.MeshStandardMaterial).color
    .copy(pieceColor(def, _col))
    .multiplyScalar(1 - damage * 0.6);
}

function addRubbleVisual(buildingId: number): void {
  const b = MAP.buildings[buildingId];
  if (!b) return;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(b.w + 0.6, RUBBLE_HEIGHT, b.d + 0.6),
    RUBBLE_MAT,
  );
  mesh.position.set(b.cx, RUBBLE_HEIGHT / 2, b.cz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mapGroup.add(mesh);
}

// The full BattleBit moment: dust, a debris shower across the footprint, a
// long rumble, and a hard shake if you're close.
function collapseFx(buildingId: number): void {
  const b = MAP.buildings[buildingId];
  if (!b) return;
  for (let i = 0; i < 5; i++) {
    const dust = new THREE.Mesh(
      FX_GEO.puff,
      new THREE.MeshBasicMaterial({ color: 0x9a948a, transparent: true, opacity: 0.55 }),
    );
    dust.scale.setScalar(1.2);
    dust.userData.sharedGeo = true;
    dust.position.set(
      b.cx + (Math.random() - 0.5) * b.w,
      0.8 + Math.random() * 1.5,
      b.cz + (Math.random() - 0.5) * b.d,
    );
    dust.userData.grow = true;
    addEffect(dust, 900 + Math.random() * 500);
  }
  for (let i = 0; i < 4; i++) {
    spawnDebris(
      new THREE.Vector3(
        b.cx + (Math.random() - 0.5) * b.w,
        1.5,
        b.cz + (Math.random() - 0.5) * b.d,
      ),
      8,
    );
  }
  noiseBurst(0.9, 0.5, true);
  blip(45, 0.8, 0.3, "sine");
  if (predState) {
    const d = Math.hypot(predState.x - b.cx, predState.z - b.cz);
    if (d < 30) shake = Math.min(1.6, shake + (1.4 - d / 30));
  }
}

function removePanelVisual(id: number, withDebris: boolean): void {
  const def = panelDefs.get(id);
  const slot = panelSlots.get(id);
  if (slot) {
    slot.mesh.setMatrixAt(slot.index, ZERO_SCALE);
    slot.mesh.instanceMatrix.needsUpdate = true;
    panelSlots.delete(id);
    if (!looseBoxes.release(slot) && !looseCyls.release(slot)) {
      for (const fp of fracturePools) {
        if (fp.release(slot)) break;
      }
    }
  } else {
    const mesh = builtMeshes.get(id);
    if (!mesh) return;
    mapGroup.remove(mesh);
    builtMeshes.delete(id);
  }
  panelDefs.delete(id);
  if (withDebris && def) {
    spawnDebris(_pos.set(def.x, def.y, def.z), 3, pieceColor(def, _col).getHex());
  }
}

// ---------------------------------------------------------------------------
// HUD.

const hud = document.createElement("div");
hud.innerHTML = `
<style>
  #hud { position:fixed; inset:0; pointer-events:none; font-family:"Trebuchet MS",system-ui,sans-serif; color:#fff; user-select:none; }
  .sh { text-shadow: 0 1px 2px rgba(0,0,0,.7); }
  #audioMenu { position:absolute; top:max(8px, env(safe-area-inset-top)); left:max(52px, calc(env(safe-area-inset-left) + 52px)); z-index:30; pointer-events:auto; font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:rgb(245,245,245); }
  #audioTrigger { width:36px; height:36px; display:grid; align-items:center; justify-items:center; padding:0; cursor:pointer; color:rgba(255,255,255,.7); background:rgba(0,0,0,.2); border:1px solid rgba(255,255,255,.2); border-radius:8px; box-shadow:0 12px 32px -18px rgba(0,0,0,1); backdrop-filter:blur(12px); transition:background 120ms ease,border-color 120ms ease,color 120ms ease; }
  #audioTrigger:hover, #audioTrigger:focus-visible, #audioMenu[data-open="true"] #audioTrigger { background:rgba(0,0,0,.6); border-color:rgba(255,255,255,.35); color:#fff; outline:2px solid rgba(255,255,255,.6); outline-offset:2px; }
  #audioTrigger svg { width:17px; height:17px; pointer-events:none; }
  #audioPanel { position:absolute; top:44px; left:0; width:260px; box-sizing:border-box; display:none; padding:16px; background:rgba(18,18,20,.92); border:1px solid rgba(255,255,255,.1); border-radius:12px; box-shadow:0 30px 110px -35px rgba(0,0,0,.95); backdrop-filter:blur(12px); }
  #audioMenu[data-open="true"] #audioPanel { display:block; }
  #audioPanel header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin:0 0 14px; }
  #audioPanel h2 { margin:0; font-size:16px; line-height:1.25; font-weight:650; letter-spacing:0; }
  #audioClose { width:32px; height:32px; display:grid; align-items:center; justify-items:center; flex:0 0 auto; padding:0; cursor:pointer; color:rgba(255,255,255,.62); background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.1); border-radius:8px; transition:background 120ms ease,color 120ms ease; }
  #audioClose:hover, #audioClose:focus-visible { background:rgba(255,255,255,.08); color:#fff; outline:2px solid rgb(0,145,255); outline-offset:2px; }
  #audioClose svg { width:16px; height:16px; pointer-events:none; }
  .audio-separator { height:1px; width:100%; background:rgba(255,255,255,.1); margin:14px 0; }
  .audio-row { display:grid; gap:8px; }
  .audio-label { display:flex; align-items:center; justify-content:space-between; gap:12px; color:rgba(255,255,255,.82); font-size:13px; font-weight:650; line-height:1.3; }
  #audioVolumeValue { color:rgba(255,255,255,.62); font-size:12px; font-weight:650; font-variant-numeric:tabular-nums; }
  #audioVolume { width:100%; accent-color:rgb(0,145,255); cursor:pointer; }
  .audio-toggle { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:42px; box-sizing:border-box; padding:9px 10px; color:rgb(245,245,245); font-size:13px; font-weight:650; background:rgba(255,255,255,.035); border:1px solid rgba(255,255,255,.1); border-radius:8px; }
  .audio-toggle input { width:18px; height:18px; margin:0; accent-color:rgb(0,145,255); cursor:pointer; }
  #cross { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); font-size:22px; opacity:.9; }
  /* Sniper scope mask (RMB while holding the sniper): a clear circle inside
     black, with thin reticle lines through the center. */
  #scope { position:absolute; inset:0; display:none; pointer-events:none;
    background:radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 30vmin, rgba(3,5,9,.985) 33vmin); }
  #scope .sv { position:absolute; left:50%; top:0; width:2px; height:100%; transform:translateX(-1px); background:rgba(8,10,14,.75); }
  #scope .shz { position:absolute; top:50%; left:0; height:2px; width:100%; transform:translateY(-1px); background:rgba(8,10,14,.75); }
  #crossname { position:absolute; left:50%; top:54%; transform:translateX(-50%); font-size:14px; font-weight:800; opacity:0; }
  #hitmark { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%) rotate(45deg); font-size:26px; color:#ff5a4a; opacity:0; font-weight:900; }
  #scores { position:absolute; top:12px; left:50%; transform:translateX(-50%); font-size:22px; font-weight:900; background:rgba(10,14,22,.55); padding:6px 18px; border-radius:10px; }
  #timer { position:absolute; top:48px; left:50%; transform:translateX(-50%); font-size:14px; font-weight:700; opacity:.85; }
  #zones { position:absolute; top:68px; left:50%; transform:translateX(-50%); display:flex; gap:6px; }
  #zones .zp { width:26px; height:26px; border-radius:6px; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:14px; background:rgba(20,24,32,.55); color:#cfd4da; position:relative; overflow:hidden; }
  #zones .zp .fill { position:absolute; left:0; bottom:0; width:100%; z-index:0; }
  #zones .zp span { position:relative; z-index:1; }
  #vitals { position:absolute; bottom:18px; left:18px; font-size:15px; font-weight:800; }
  #vitals .hpbar { width:200px; height:10px; background:rgba(0,0,0,.45); border-radius:5px; overflow:hidden; margin-top:4px; }
  #vitals .hpbar div { height:100%; background:#5ad05a; width:100%; }
  #ammo { position:absolute; bottom:18px; right:22px; text-align:right; font-weight:900; }
  #ammo .mag { font-size:34px; }
  #ammo .sub { font-size:14px; opacity:.85; }
  #feed { position:absolute; top:14px; right:14px; text-align:right; font-size:14px; font-weight:700; }
  #feed div { margin:2px 0; background:rgba(10,14,22,.5); padding:3px 9px; border-radius:7px; }
  #overlay { position:absolute; inset:0; display:none; align-items:center; justify-content:center; text-align:center; background:rgba(8,10,16,.45); }
  #overlay .panel { background:rgba(12,16,26,.9); border-radius:16px; padding:26px 44px; }
  #overlay h1 { margin:0 0 6px; font-size:40px; }
  #overlay p { margin:4px 0; font-size:17px; }
  #board { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:none; background:rgba(12,16,26,.92); border-radius:14px; padding:18px 30px; font-size:15px; }
  #board table { border-collapse:collapse; }
  #board td, #board th { padding:3px 14px; text-align:left; }
  #hint { position:absolute; bottom:6px; left:50%; transform:translateX(-50%); font-size:12px; opacity:.75; }
  #netinfo { position:absolute; bottom:4px; right:8px; font-size:11px; opacity:.65; }
  #vignette { position:absolute; inset:0; box-shadow: inset 0 0 140px rgba(255,30,30,.85); opacity:0; transition:opacity .12s; }
  #flash { position:absolute; inset:0; background:#fff; opacity:0; }
  #oob { position:absolute; inset:0; display:none; flex-direction:column; align-items:center; justify-content:center; text-align:center; pointer-events:none; box-shadow: inset 0 0 220px rgba(150,0,0,.65); }
  #oob .b { font-size:30px; font-weight:900; color:#ffe2e2; text-shadow:0 2px 8px #000; letter-spacing:2px; }
  #oob .s { font-size:15px; font-weight:700; color:#ffd0d0; opacity:.9; margin-top:4px; }
  #oob .c { font-size:72px; font-weight:900; color:#fff; text-shadow:0 3px 12px #000; margin-top:6px; }
  /* Intro / deploy screen. Opaque on purpose: it doubles as the loading screen,
     so the world (and any placeholder assets) never shows before deploy. */
  #intro { position:fixed; inset:0; z-index:100; display:flex; align-items:center; justify-content:center; pointer-events:auto;
    background:radial-gradient(1100px 620px at 50% 30%, #1a2434 0%, #0d1220 55%, #070a12 100%); }
  #intro .ip { width:min(520px, calc(100vw - 40px)); max-height:calc(100vh - 24px); overflow-y:auto; box-sizing:border-box; text-align:center;
    padding:18px 32px 16px; background:rgba(12,16,26,.78); border:1px solid rgba(255,255,255,.09); border-radius:18px;
    box-shadow:0 40px 120px -30px rgba(0,0,0,.9); }
  #intro h1 { margin:0; font-size:30px; letter-spacing:5px; }
  #intro .isub { font-size:12px; font-weight:700; letter-spacing:4px; opacity:.6; margin-top:2px; }
  #introTeam { display:inline-block; margin:10px 0 0; padding:7px 24px; border-radius:10px; font-weight:900; font-size:14px;
    letter-spacing:1.5px; background:rgba(255,255,255,.1); box-shadow:0 6px 24px -8px rgba(0,0,0,.8); }
  #intro .igoal { margin:10px auto 0; font-size:14px; line-height:1.5; opacity:.92; max-width:400px; }
  #intro .igoal b { color:#ffd76a; }
  #introKeys { display:grid; grid-template-columns:1fr 1fr; gap:5px 18px; margin:10px auto 0; max-width:410px; text-align:left; font-size:12px; }
  #introKeys .krow { display:flex; align-items:center; gap:9px; }
  #introKeys kbd { flex:0 0 auto; min-width:32px; text-align:center; padding:3px 7px; border-radius:6px; background:rgba(255,255,255,.12);
    border:1px solid rgba(255,255,255,.18); border-bottom-width:2px; font:700 12px/1.2 ui-monospace,monospace; }
  #introKeys span { opacity:.85; }
  #deploy, #respawnDeploy { margin-top:12px; width:100%; padding:13px 0; font:900 16px/1 "Trebuchet MS",system-ui,sans-serif; letter-spacing:2px;
    color:#fff; background:#2f6fe0; border:0; border-radius:12px; cursor:pointer; transition:background 120ms ease, transform 80ms ease; }
  #deploy:hover:not(:disabled), #respawnDeploy:hover:not(:disabled) { background:#3f7ff0; }
  #deploy:active:not(:disabled), #respawnDeploy:active:not(:disabled) { transform:scale(.98); }
  #deploy:disabled, #respawnDeploy:disabled { background:rgba(255,255,255,.12); color:rgba(255,255,255,.55); cursor:default; }
  #respawnDeploy { margin-top:14px; }
  #introStatus { margin-top:7px; font-size:12px; opacity:.6; min-height:14px; }
  /* Spawn-selection minimap (intro + respawn overlay). */
  .mapcap { font-size:12px; opacity:.72; margin:8px 0 5px; }
  .minimap { position:relative; width:100%; aspect-ratio:1/1; border-radius:10px; overflow:hidden;
    border:1px solid rgba(255,255,255,.16); background:#22303c; }
  .minimap canvas { position:absolute; inset:0; width:100%; height:100%; }
  .mm-flag { position:absolute; transform:translate(-50%,-50%); width:32px; height:32px; padding:0;
    border-radius:9px; display:flex; align-items:center; justify-content:center; color:#fff;
    font:900 14px "Trebuchet MS",system-ui,sans-serif; background:rgba(18,22,32,.82);
    border:2px solid rgba(255,255,255,.3); transition:transform 80ms ease; }
  .mm-flag.own { cursor:pointer; }
  .mm-flag.own:hover { transform:translate(-50%,-50%) scale(1.15); }
  .mm-flag:disabled { cursor:default; opacity:.8; }
  /* Selectable-but-not-selected points pulse so it's obvious they're choices. */
  .mm-flag.own:not(.sel) { animation:mmpulse 1.6s ease-in-out infinite; }
  @keyframes mmpulse { 0%,100% { box-shadow:0 0 0 0 rgba(255,255,255,0); } 50% { box-shadow:0 0 10px 3px rgba(255,255,255,.55); } }
  .mm-flag.sel { outline:3px solid #fff; outline-offset:1px; transform:translate(-50%,-50%) scale(1.12); }
  .mm-hq { width:42px; height:26px; border-radius:7px; font-size:12px; letter-spacing:1px; }
  .mm-hq.foe { opacity:.6; pointer-events:none; }
  .mm-status { margin-top:6px; font-size:13px; font-weight:800; letter-spacing:.5px; opacity:.95; }
  .mm-status b { letter-spacing:1px; }
  /* Class picker: one card per kit, shared by intro + respawn overlay. */
  .classrow { display:flex; gap:7px; margin:8px auto 0; max-width:430px; }
  .classbtn { flex:1; padding:8px 2px 7px; border-radius:10px; cursor:pointer; text-align:center;
    color:#fff; background:rgba(255,255,255,.05); border:2px solid rgba(255,255,255,.14);
    font-family:"Trebuchet MS",system-ui,sans-serif; transition:background 100ms ease,border-color 100ms ease; }
  .classbtn:hover { background:rgba(255,255,255,.11); }
  .classbtn.sel { border-color:#fff; background:rgba(255,255,255,.14); }
  .classbtn .ci { height:32px; display:flex; align-items:center; justify-content:center; margin-bottom:3px; }
  .classbtn .ci img { max-height:32px; max-width:92%; filter:drop-shadow(0 2px 3px rgba(0,0,0,.55)); }
  .classbtn .cn { font-size:13px; font-weight:900; letter-spacing:.5px; }
  .classbtn .cw { font-size:11px; opacity:.75; margin-top:1px; }
  #introMap { width:min(204px, 52vw); margin:0 auto; }
  #respawn { position:fixed; inset:0; z-index:120; display:none; align-items:center; justify-content:center;
    pointer-events:auto; background:rgba(6,9,15,.55); }
  #respawn .rp { width:min(440px, 94vw); max-height:calc(100vh - 24px); overflow-y:auto; box-sizing:border-box;
    text-align:center; padding:16px 24px 16px; background:rgba(12,16,26,.92);
    border:1px solid rgba(255,255,255,.09); border-radius:16px; }
  #respawn h2 { margin:0; font-size:24px; letter-spacing:2px; }
  #respawnMap { width:min(380px, 84vw); margin:0 auto; }
</style>
<div id="hud">
  <div id="audioMenu" data-open="false">
    <button id="audioTrigger" type="button" aria-label="Open settings" aria-expanded="false" aria-controls="audioPanel">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/>
        <path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.05a2.1 2.1 0 1 1-2.97 2.97l-.05-.05a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.09 1.65V21.4a2.1 2.1 0 1 1-4.2 0v-.07a1.8 1.8 0 0 0-1.13-1.66 1.8 1.8 0 0 0-1.98.36l-.05.05a2.1 2.1 0 1 1-2.97-2.97l.05-.05a1.8 1.8 0 0 0 .36-1.98 1.8 1.8 0 0 0-1.65-1.09H2.6a2.1 2.1 0 1 1 0-4.2h.07a1.8 1.8 0 0 0 1.66-1.13 1.8 1.8 0 0 0-.36-1.98l-.05-.05A2.1 2.1 0 1 1 6.89 3.66l.05.05a1.8 1.8 0 0 0 1.98.36H9a1.8 1.8 0 0 0 1.09-1.65V2.6a2.1 2.1 0 1 1 4.2 0v.07a1.8 1.8 0 0 0 1.09 1.65h.08a1.8 1.8 0 0 0 1.98-.36l.05-.05a2.1 2.1 0 1 1 2.97 2.97l-.05.05a1.8 1.8 0 0 0-.36 1.98V9a1.8 1.8 0 0 0 1.65 1.09h.1a2.1 2.1 0 1 1 0 4.2h-.07A1.8 1.8 0 0 0 19.4 15Z"/>
      </svg>
    </button>
    <section id="audioPanel" role="dialog" aria-modal="false" aria-labelledby="audioTitle">
      <header>
        <h2 id="audioTitle">Settings</h2>
        <button id="audioClose" type="button" aria-label="Close settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </header>
      <div class="audio-separator"></div>
      <div class="audio-row">
        <label class="audio-label" for="sensRange"><span>Mouse sensitivity</span><span id="sensValue">1.00x</span></label>
        <input id="sensRange" type="range" min="20" max="300" step="5" value="100" />
      </div>
      <div class="audio-separator"></div>
      <label class="audio-toggle" for="scopeMode" title="On: right-click toggles the sniper scope. Off: hold right-click to stay scoped."><span>Sniper scope: toggle zoom</span><input id="scopeMode" type="checkbox" checked /></label>
      <div class="audio-separator"></div>
      <div class="audio-row">
        <label class="audio-label" for="audioVolume"><span>Master volume</span><span id="audioVolumeValue">70%</span></label>
        <input id="audioVolume" type="range" min="0" max="100" step="1" value="70" />
      </div>
      <div class="audio-separator"></div>
      <label class="audio-toggle" for="audioMute"><span>Mute</span><input id="audioMute" type="checkbox" /></label>
    </section>
  </div>
  <div id="vignette"></div>
  <div id="flash"></div>
  <div id="oob"><div class="b">⚠ RETURN TO THE BATTLEFIELD</div><div class="s">leaving the combat area</div><div class="c" id="oobtimer"></div></div>
  <div id="cross" class="sh">+</div>
  <div id="crossname" class="sh"></div>
  <div id="scope"><div class="sv"></div><div class="shz"></div></div>
  <div id="hitmark">+</div>
  <div id="scores" class="sh"></div>
  <div id="timer" class="sh"></div>
  <div id="zones"></div>
  <div id="vitals" class="sh">HP<div class="hpbar"><div id="hpfill"></div></div></div>
  <div id="ammo" class="sh"><div class="sub" id="wpnname"></div><div class="mag" id="ammotext">30</div><div class="sub" id="gear"></div></div>
  <div id="feed"></div>
  <div id="overlay"><div class="panel" id="overlaypanel"></div></div>
  <div id="board"></div>
  <div id="hint" class="sh">click to play — WASD move · shift sprint · space jump · LMB fire · 1/2 weapons · R reload · G grenade · F sledge · Q build cover · Tab scores</div>
  <div id="netinfo" class="sh"></div>
  <div id="intro">
    <div class="ip">
      <h1>FLAG CONQUEST</h1>
      <div class="isub">CAPTURE · CONTROL · CONQUER</div>
      <div id="introTeam">ASSIGNING TEAM…</div>
      <div class="igoal"><b>Capture and hold the flags.</b></div>
      <div class="mapcap">pick your kit</div>
      <div id="introClasses"></div>
      <div class="mapcap">pick a spawn point — your HQ or any flag your team holds</div>
      <div id="introMap"></div>
      <div id="introKeys"></div>
      <button id="deploy" type="button" disabled>LOADING…</button>
      <div id="introStatus"></div>
    </div>
  </div>
  <div id="respawn">
    <div class="rp">
      <h2>YOU'RE DOWN</h2>
      <div id="respawnClasses"></div>
      <div class="mapcap">pick a spawn point — your HQ or any flag your team holds</div>
      <div id="respawnMap"></div>
      <button id="respawnDeploy" type="button" disabled></button>
    </div>
  </div>
</div>`;
document.body.appendChild(hud);
const el = {
  cross: document.getElementById("cross")!,
  audioMenu: document.getElementById("audioMenu")!,
  audioTrigger: document.getElementById("audioTrigger") as HTMLButtonElement,
  audioClose: document.getElementById("audioClose") as HTMLButtonElement,
  audioPanel: document.getElementById("audioPanel")!,
  audioVolume: document.getElementById("audioVolume") as HTMLInputElement,
  audioVolumeValue: document.getElementById("audioVolumeValue")!,
  audioMute: document.getElementById("audioMute") as HTMLInputElement,
  sensRange: document.getElementById("sensRange") as HTMLInputElement,
  sensValue: document.getElementById("sensValue")!,
  scopeMode: document.getElementById("scopeMode") as HTMLInputElement,
  crossname: document.getElementById("crossname")!,
  scope: document.getElementById("scope")!,
  hitmark: document.getElementById("hitmark")!,
  scores: document.getElementById("scores")!,
  timer: document.getElementById("timer")!,
  zones: document.getElementById("zones")!,
  hpfill: document.getElementById("hpfill")!,
  ammotext: document.getElementById("ammotext")!,
  wpnname: document.getElementById("wpnname")!,
  gear: document.getElementById("gear")!,
  feed: document.getElementById("feed")!,
  overlay: document.getElementById("overlay")!,
  overlaypanel: document.getElementById("overlaypanel")!,
  board: document.getElementById("board")!,
  netinfo: document.getElementById("netinfo")!,
  vignette: document.getElementById("vignette")!,
  flash: document.getElementById("flash")!,
  oob: document.getElementById("oob")!,
  oobtimer: document.getElementById("oobtimer")!,
  intro: document.getElementById("intro")!,
  introTeam: document.getElementById("introTeam")!,
  introKeys: document.getElementById("introKeys")!,
  introStatus: document.getElementById("introStatus")!,
  introMap: document.getElementById("introMap")!,
  introClasses: document.getElementById("introClasses")!,
  deploy: document.getElementById("deploy") as HTMLButtonElement,
  respawn: document.getElementById("respawn")!,
  respawnMap: document.getElementById("respawnMap")!,
  respawnClasses: document.getElementById("respawnClasses")!,
  respawnDeploy: document.getElementById("respawnDeploy") as HTMLButtonElement,
};

// Sniper scope input (client-side view zoom only). Toggle mode (default):
// right-click flips the scope on/off; hold mode: scoped while RMB is held.
const SENS_KEY = "breachpoint.sensitivity";
const SCOPE_MODE_KEY = "breachpoint.scopeToggle";
let sensMultiplier = (() => {
  try {
    const v = Number(localStorage.getItem(SENS_KEY));
    return Number.isFinite(v) && v >= 0.2 && v <= 3 ? v : 1;
  } catch {
    return 1;
  }
})();
let scopeToggleMode = (() => {
  try {
    return localStorage.getItem(SCOPE_MODE_KEY) !== "0"; // default: toggle
  } catch {
    return true;
  }
})();
let scopeActive = false;

function updateAudioMenu(): void {
  const pct = Math.round(masterVolume * 100);
  el.audioVolume.value = pct.toString();
  el.audioVolumeValue.textContent = `${pct}%`;
  el.audioMute.checked = masterVolume <= 0;
  el.sensRange.value = Math.round(sensMultiplier * 100).toString();
  el.sensValue.textContent = `${sensMultiplier.toFixed(2)}x`;
  el.scopeMode.checked = scopeToggleMode;
}

function audioMenuOpen(): boolean {
  return el.audioMenu.dataset.open === "true";
}

function setAudioMenuOpen(open: boolean): void {
  el.audioMenu.dataset.open = open ? "true" : "false";
  el.audioTrigger.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) updateAudioMenu();
}

el.audioTrigger.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setAudioMenuOpen(!audioMenuOpen());
});
el.audioClose.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  setAudioMenuOpen(false);
  el.audioTrigger.focus();
});
el.audioVolume.addEventListener("input", () => {
  ensureAudio();
  setMasterVolume(Number(el.audioVolume.value) / 100);
});
el.audioMute.addEventListener("change", () => {
  ensureAudio();
  if (el.audioMute.checked) {
    if (masterVolume > 0) lastAudibleVolume = masterVolume;
    setMasterVolume(0);
  } else {
    setMasterVolume(lastAudibleVolume || DEFAULT_MASTER_VOLUME);
  }
});
el.sensRange.addEventListener("input", () => {
  sensMultiplier = Math.max(0.2, Math.min(3, Number(el.sensRange.value) / 100));
  el.sensValue.textContent = `${sensMultiplier.toFixed(2)}x`;
  try {
    localStorage.setItem(SENS_KEY, sensMultiplier.toFixed(2));
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
});
el.scopeMode.addEventListener("change", () => {
  scopeToggleMode = el.scopeMode.checked;
  scopeActive = false; // switching modes never leaves you stuck zoomed
  try {
    localStorage.setItem(SCOPE_MODE_KEY, scopeToggleMode ? "1" : "0");
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
});
el.audioMenu.addEventListener("pointerdown", (event) => event.stopPropagation());
el.audioMenu.addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.code === "Escape") {
    event.preventDefault();
    setAudioMenuOpen(false);
    el.audioTrigger.focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (audioMenuOpen() && target instanceof Node && !el.audioMenu.contains(target)) {
    setAudioMenuOpen(false);
  }
});

function feed(text: string): void {
  const d = document.createElement("div");
  d.innerHTML = text;
  el.feed.prepend(d);
  while (el.feed.children.length > 6) el.feed.lastChild?.remove();
  setTimeout(() => d.remove(), 6000);
}

// ---------------------------------------------------------------------------
// Audio: sample-backed when assets are present, synthesized fallback otherwise.

const kenneyVariants = (family: string): string[] =>
  Array.from({ length: 5 }, (_, i) => `/assets/sounds/${family}_00${i}.ogg`);

const BUILT_IN_SOUND_FILES: Record<string, string[]> = {
  footstep_grass: kenneyVariants("footstep_grass"),
  footstep_concrete: kenneyVariants("footstep_concrete"),
  footstep_snow: kenneyVariants("footstep_snow"),
  footstep_wood: kenneyVariants("footstep_wood"),
  impactPunch_medium: kenneyVariants("impactPunch_medium"),
  impactPunch_heavy: kenneyVariants("impactPunch_heavy"),
  impactSoft_medium: kenneyVariants("impactSoft_medium"),
  impactSoft_heavy: kenneyVariants("impactSoft_heavy"),
  impactWood_medium: kenneyVariants("impactWood_medium"),
  impactMetal_medium: kenneyVariants("impactMetal_medium"),
};

interface SoundManifest {
  families?: Record<string, string[]>;
}

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
const MASTER_VOLUME_KEY = "breachpoint.masterVolume";
const DEFAULT_MASTER_VOLUME = 0.7;
let masterVolume = loadMasterVolume();
let lastAudibleVolume = masterVolume > 0 ? masterVolume : DEFAULT_MASTER_VOLUME;
const soundBuffers = new Map<string, AudioBuffer[]>();
// One decode per URL, shared across every family that lists it (e.g. melee
// reuses the Kenney impacts) so the same file isn't fetched or decoded twice.
const bufferPromises = new Map<string, Promise<AudioBuffer | null>>();
const soundLog: string[] = [];
let soundManifestRequested = false;

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : DEFAULT_MASTER_VOLUME));
}

function loadMasterVolume(): number {
  try {
    const raw = localStorage.getItem(MASTER_VOLUME_KEY);
    if (raw === null) return DEFAULT_MASTER_VOLUME;
    return clampVolume(Number(raw));
  } catch {
    return DEFAULT_MASTER_VOLUME;
  }
}

function saveMasterVolume(): void {
  try {
    localStorage.setItem(MASTER_VOLUME_KEY, masterVolume.toFixed(2));
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
}

function applyMasterVolume(): void {
  if (masterGain) masterGain.gain.value = masterVolume;
}

function setMasterVolume(value: number): void {
  masterVolume = clampVolume(value);
  if (masterVolume > 0) lastAudibleVolume = masterVolume;
  applyMasterVolume();
  saveMasterVolume();
  updateAudioMenu();
}
updateAudioMenu();

function ensureAudio(): void {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = masterVolume;
    masterGain.connect(audioCtx.destination);
    for (const [family, urls] of Object.entries(BUILT_IN_SOUND_FILES)) {
      loadSoundFamily(family, urls);
    }
    loadSoundManifest();
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();
}

function loadSoundManifest(): void {
  if (soundManifestRequested) return;
  soundManifestRequested = true;
  void fetch("/assets/sounds/manifest.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .then((manifest: SoundManifest | null) => {
      if (!manifest?.families) return;
      for (const [family, urls] of Object.entries(manifest.families)) {
        loadSoundFamily(family, urls);
      }
    })
    .catch(() => {});
}

function loadSoundFamily(family: string, urls: readonly string[]): void {
  const buffers = soundBuffers.get(family) ?? [];
  soundBuffers.set(family, buffers);
  for (const url of urls) {
    let pending = bufferPromises.get(url);
    if (!pending) {
      pending = fetch(url)
        .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject()))
        .then((bytes) => audioCtx!.decodeAudioData(bytes))
        .catch(() => null);
      bufferPromises.set(url, pending);
    }
    void pending.then((buffer) => {
      if (buffer) buffers.push(buffer);
    });
  }
}

function makePanner(at: THREE.Vector3): PannerNode | null {
  if (!audioCtx) return null;
  const panner = audioCtx.createPanner();
  // Equal-power (not HRTF) keeps other players' sounds crisp and clearly
  // left/right instead of spectrally muffled; a gentle linear falloff keeps
  // them audible across the battlefield.
  panner.panningModel = "equalpower";
  panner.distanceModel = "linear";
  panner.refDistance = 6;
  panner.maxDistance = 80;
  panner.rolloffFactor = 0.9;
  panner.positionX.value = at.x;
  panner.positionY.value = at.y;
  panner.positionZ.value = at.z;
  return panner;
}

function connectAudioNode(source: AudioNode, volume: number, at?: THREE.Vector3): void {
  if (!audioCtx || !masterGain) return;
  const gain = audioCtx.createGain();
  gain.gain.value = volume;
  source.connect(gain);
  if (at) {
    const panner = makePanner(at);
    if (panner) {
      gain.connect(panner).connect(masterGain);
      return;
    }
  }
  gain.connect(masterGain);
}

function playSound(family: string, volume = 1, pitch = 1): boolean {
  if (!audioCtx) return false;
  const buffers = soundBuffers.get(family);
  if (!buffers || buffers.length === 0) return false;
  const source = audioCtx.createBufferSource();
  source.buffer = buffers[Math.floor(Math.random() * buffers.length)];
  source.playbackRate.value = pitch * (0.94 + Math.random() * 0.12);
  connectAudioNode(source, volume);
  source.start();
  logSound(family);
  return true;
}

function playSoundAt(family: string, at: THREE.Vector3, volume = 1, pitch = 1): boolean {
  if (!audioCtx) return false;
  const buffers = soundBuffers.get(family);
  if (!buffers || buffers.length === 0) return false;
  const source = audioCtx.createBufferSource();
  source.buffer = buffers[Math.floor(Math.random() * buffers.length)];
  source.playbackRate.value = pitch * (0.94 + Math.random() * 0.12);
  connectAudioNode(source, volume, at);
  source.start();
  logSound(family);
  return true;
}

// Play a one-shot stretched to ~`seconds` long so a sample (e.g. the reload)
// matches a fixed gameplay duration. No random pitch jitter. Positional when
// `at` is given.
function playSoundFit(family: string, seconds: number, volume = 1, at?: THREE.Vector3): boolean {
  if (!audioCtx) return false;
  const buffers = soundBuffers.get(family);
  if (!buffers || buffers.length === 0) return false;
  const buffer = buffers[Math.floor(Math.random() * buffers.length)];
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = Math.max(0.5, Math.min(2, buffer.duration / seconds));
  connectAudioNode(source, volume, at);
  source.start();
  logSound(family);
  return true;
}

function logSound(family: string): void {
  soundLog.push(family);
  if (soundLog.length > 40) soundLog.shift();
}

function noiseBurst(dur: number, vol: number, low = false, at?: THREE.Vector3): void {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const len = Math.floor(audioCtx.sampleRate * dur);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = low ? 260 : 2600;
  src.connect(filter);
  connectAudioNode(filter, vol, at);
  src.start(t);
}

function blip(
  freq: number,
  dur = 0.07,
  vol = 0.1,
  type: OscillatorType = "square",
  at?: THREE.Vector3,
): void {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(1, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain);
  connectAudioNode(gain, vol, at);
  osc.start(t);
  osc.stop(t + dur);
}

function updateAudioListener(): void {
  if (!audioCtx) return;
  const listener = audioCtx.listener;
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  listener.positionX.value = camera.position.x;
  listener.positionY.value = camera.position.y;
  listener.positionZ.value = camera.position.z;
  listener.forwardX.value = dir.x;
  listener.forwardY.value = dir.y;
  listener.forwardZ.value = dir.z;
  listener.upX.value = camera.up.x;
  listener.upY.value = camera.up.y;
  listener.upZ.value = camera.up.z;
}

function footstepFamilyAt(x: number, y: number, z: number): string {
  const material = panelMaterialUnderfoot(x, y, z);
  if (
    material === "plank" ||
    material === "log" ||
    material === "post" ||
    material === "trunk" ||
    material === "stair" ||
    material === "crate"
  ) {
    return "footstep_wood";
  }
  if (
    material === "brick" ||
    material === "concrete" ||
    material === "metal" ||
    material === "rock" ||
    material === "rubble" ||
    material === "stone" ||
    material === "sandbag"
  ) {
    return "footstep_concrete";
  }
  const base = baseHeightAt(x, z);
  if (base < 0.05) return "footstep_concrete";
  if (base > 2.4) return "footstep_snow";
  return "footstep_grass";
}

function panelMaterialUnderfoot(x: number, y: number, z: number): PanelMaterial | null {
  let best: { material: PanelMaterial; dy: number } | null = null;
  for (const def of panelDefs.values()) {
    const dx = Math.abs(x - def.x);
    const dz = Math.abs(z - def.z);
    if (dx > def.ex / 2 + 0.16 || dz > def.ez / 2 + 0.16) continue;
    const top = def.y + def.ey / 2;
    const dy = Math.abs(y - top);
    if (dy > 0.62) continue;
    if (!best || dy < best.dy) best = { material: def.material, dy };
  }
  return best?.material ?? null;
}

// Weapon shot character: same rifle samples, re-pitched per weapon so an SMG
// chatters, a sniper booms, and the pistol cracks — no extra assets needed.
const SHOT_FX: Record<string, { pitch: number; vol: number }> = {
  Rifle: { pitch: 1, vol: 0.9 },
  SMG: { pitch: 1.2, vol: 0.75 },
  Shotgun: { pitch: 0.72, vol: 1.1 },
  Sniper: { pitch: 0.62, vol: 1.15 },
  Pistol: { pitch: 1.35, vol: 0.8 },
  Revolver: { pitch: 0.72, vol: 1.35 }, // a deep, LOUD hand-cannon boom
};

const sounds = {
  shot: (weapon = "Rifle") => {
    const fx = SHOT_FX[weapon] ?? SHOT_FX.Rifle;
    if (!playSound("rifle_shot", fx.vol, fx.pitch)) noiseBurst(0.09, 0.16);
    void playSound("rifle_tail", 0.35, fx.pitch);
  },
  shotAt: (at: THREE.Vector3, weapon = "Rifle") => {
    const fx = SHOT_FX[weapon] ?? SHOT_FX.Rifle;
    if (!playSoundAt("rifle_shot", at, fx.vol, fx.pitch)) noiseBurst(0.1, 0.15, true, at);
    void playSoundAt("rifle_tail", at, 0.35, fx.pitch);
  },
  shotFar: (d: number) => noiseBurst(0.12, Math.max(0.02, 0.14 - d * 0.002), true),
  explosionAt: (at: THREE.Vector3) => {
    // A big, LOUD blast — should dominate gunfire: a sharp crack, a longer
    // low rumble for body, the heavy impact sample, and a deep sub boom.
    noiseBurst(0.3, 1.4, false, at); // sharp crack
    noiseBurst(0.6, 1.0, true, at); // low rumble body
    void playSoundAt("impactSoft_heavy", at, 1.5, 0.9); // blast body
    blip(70, 0.5, 0.5, "sine", at); // deep sub boom
  },
  hitmarker: () => blip(1450, 0.07, 0.2),
  // Landed a bullet on an enemy: a meaty flesh thwack plus the confirm tick.
  bulletHit: () => {
    if (!playSound("impactPunch_heavy", 0.8, 1.15)) noiseBurst(0.05, 0.12);
    blip(1500, 0.06, 0.14);
  },
  // Headshot: heavier thwack + a brighter two-tone ding so it reads distinctly.
  headshot: () => {
    if (!playSound("impactPunch_heavy", 0.85, 1.35)) noiseBurst(0.04, 0.12);
    blip(2000, 0.05, 0.2);
    blip(2600, 0.07, 0.18);
  },
  // Grenade tapping the ground: a small metallic clink, scaled by impact speed.
  grenadeBounceAt: (at: THREE.Vector3, volume = 0.5) => {
    void playSoundAt("impactMetal_medium", at, Math.min(0.6, volume), 1.1);
  },
  hurt: () => {
    if (!playSound("impactPunch_medium", 0.9, 0.85)) blip(170, 0.12, 0.16, "sawtooth");
  },
  hurtAt: (at: THREE.Vector3) => {
    if (!playSoundAt("impactPunch_medium", at, 0.85, 0.85)) blip(170, 0.12, 0.13, "sawtooth", at);
  },
  reload: (seconds: number) => {
    // Stretch the sample to the weapon's reload time so audio and the dip
    // line up.
    if (!playSoundFit("reload", seconds, 0.8)) blip(700, 0.06, 0.08);
  },
  // Pump-action rack between shotgun blasts (the AK-rack sample squeezed to a
  // quick shk-shk); two dry clicks if samples haven't loaded.
  pump: () => {
    if (!playSoundFit("pump", 0.33, 0.8)) {
      blip(300, 0.04, 0.12, "square");
      setTimeout(() => blip(220, 0.05, 0.12, "square"), 110);
    }
  },
  pumpAt: (at: THREE.Vector3) => {
    if (!playSoundFit("pump", 0.33, 0.7, at)) blip(260, 0.05, 0.1, "square", at);
  },
  buildAt: (at: THREE.Vector3) => {
    if (!playSoundAt("impactWood_medium", at, 0.75, 0.9)) blip(240, 0.1, 0.14, "square", at);
  },
  melee: () => {
    if (!playSound("melee", 0.65, 0.85)) noiseBurst(0.08, 0.1, true);
  },
  meleeAt: (at: THREE.Vector3) => {
    if (!playSoundAt("melee", at, 0.65, 0.85)) noiseBurst(0.08, 0.1, true, at);
  },
  death: () => {
    // A heavy body-drop thud (pitched-down impact); synth groan if unloaded.
    if (!playSound("death", 0.8, 0.75) && !playSound("impactSoft_heavy", 0.7, 0.7)) {
      blip(110, 0.5, 0.2, "sawtooth");
    }
  },
  deathAt: (at: THREE.Vector3) => {
    if (!playSoundAt("death", at, 0.8, 0.75) && !playSoundAt("impactSoft_heavy", at, 0.7, 0.7)) {
      blip(110, 0.5, 0.16, "sawtooth", at);
    }
  },
  footstep: (x: number, y: number, z: number, volume = 0.22) => {
    void playSound(footstepFamilyAt(x, y, z), volume, 1);
  },
  footstepAt: (x: number, y: number, z: number, volume = 0.22) => {
    void playSoundAt(footstepFamilyAt(x, y, z), new THREE.Vector3(x, y + 0.1, z), volume, 1);
  },
};

// ---------------------------------------------------------------------------
// Input.

const keys = new Set<string>();
let yaw = 0;
let pitch = 0;
let pointerLocked = false;
let fireHeld = false;
// Desired weapon slot (0 primary, 1 pistol) — rides every input as slot2.
let desiredSlot = 0;
// Touch (mobile): the floating joystick writes these, blended into the keyboard
// move in sampleInput(); look + buttons drive yaw/pitch/keys/fireHeld directly,
// exactly like mouse + keyboard — so no server or netcode changes are needed.
let touchFwd = 0;
let touchSide = 0;

renderer.domElement.addEventListener("mousedown", (e) => {
  ensureAudio();
  if (!pointerLocked) {
    renderer.domElement.requestPointerLock();
    return;
  }
  if (e.button === 0) fireHeld = true;
  if (e.button === 2) scopeActive = scopeToggleMode ? !scopeActive : true;
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) fireHeld = false;
  if (e.button === 2 && !scopeToggleMode) scopeActive = false;
});
renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
  if (!pointerLocked) {
    fireHeld = false;
    scopeActive = false;
  }
});
document.addEventListener("mousemove", (e) => {
  if (!pointerLocked) return;
  // The user's sensitivity setting, additionally scaled down while scoped so
  // a scoped flick covers the same on-screen distance as an unscoped one.
  const sens = sensMultiplier / camera.zoom;
  yaw -= e.movementX * 0.0023 * sens;
  pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * 0.0021 * sens));
  while (yaw > Math.PI) yaw -= Math.PI * 2;
  while (yaw < -Math.PI) yaw += Math.PI * 2;
});
window.addEventListener("keydown", (e) => {
  if (e.code === "Tab") e.preventDefault();
  if (e.repeat) return;
  if (e.code === "Digit1") desiredSlot = 0;
  if (e.code === "Digit2") desiredSlot = 1;
  keys.add(e.code);
  ensureAudio();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => {
  keys.clear();
  fireHeld = false;
  scopeActive = false;
});

// Test hook: scripted input overrides everything for N ticks. trackIdx
// re-aims at that player's rendered position every tick (human-like tracking).
let driven: (Omit<InputCmd, "seq"> & { ticks: number; trackIdx?: number }) | null = null;

function sampleInput(seq: number): InputCmd {
  const viewTick = renderedWorldTick(performance.now()) & 0xffff;
  if (driven && driven.ticks > 0) {
    driven.ticks--;
    if (driven.trackIdx !== undefined && predState) {
      const rp = remotes.get(driven.trackIdx);
      if (rp) {
        const g = rp.group.position;
        const dx = g.x - predState.x;
        const dz = g.z - predState.z;
        const dist = Math.hypot(dx, dz) || 1;
        yaw = Math.atan2(dx, dz);
        pitch = Math.atan2(g.y + 0.9 - (predState.y + 1.45), dist);
        driven.yaw = quantizeAngle(yaw);
        driven.pitch = quantizeAngle(pitch);
      }
    }
    const { ticks: _ticks, trackIdx: _trackIdx, ...rest } = driven;
    return { seq, ...rest, viewTick };
  }
  let fwd = 0;
  let side = 0;
  if (keys.has("KeyW")) fwd += 1;
  if (keys.has("KeyS")) fwd -= 1;
  if (keys.has("KeyA")) side += 1;
  if (keys.has("KeyD")) side -= 1;
  fwd = Math.max(-1, Math.min(1, fwd + touchFwd));
  side = Math.max(-1, Math.min(1, side + touchSide));
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return {
    seq,
    moveX: quantizeMove(fwd * sin + side * cos),
    moveZ: quantizeMove(fwd * cos - side * sin),
    yaw: quantizeAngle(yaw),
    pitch: quantizeAngle(pitch),
    jump: keys.has("Space"),
    sprint: keys.has("ShiftLeft") || keys.has("ShiftRight"),
    fire: fireHeld,
    reload: keys.has("KeyR"),
    grenade: keys.has("KeyG"),
    melee: keys.has("KeyF"),
    build: keys.has("KeyQ"),
    slot2: desiredSlot === 1,
    viewTick,
  };
}

// ---------------------------------------------------------------------------
// Touch controls (mobile). Pure client-side: a floating left joystick writes
// touchFwd/touchSide, a right-side drag surface drives yaw/pitch, and on-screen
// buttons toggle the same `keys`/`fireHeld` the keyboard + mouse use. Shown only
// on coarse-pointer/touch devices so desktop mouse + keyboard is untouched.

const wantsTouch =
  matchMedia("(hover: none) and (pointer: coarse)").matches || navigator.maxTouchPoints > 0;

function setupTouchControls(): void {
  const LOOK_SENS = 0.013; // radians per CSS px of drag (tune in playtest)
  const JOY_RADIUS = 55; // px of knob travel
  const JOY_DEAD = 0.18; // fraction of radius ignored, anti-drift

  // Inline SVG glyphs (Lucide-style) so buttons need no image assets.
  const ICONS: Record<string, string> = {
    fire: '<circle cx="12" cy="12" r="8"/><line x1="12" y1="2" x2="12" y2="5.5"/><line x1="12" y1="18.5" x2="12" y2="22"/><line x1="2" y1="12" x2="5.5" y2="12"/><line x1="18.5" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/>',
    jump: '<path d="M6 13l6-6 6 6"/><path d="M6 18l6-6 6 6"/>',
    sprint: '<path d="M13 2 L5 13 h5 l-1 9 L19 10 h-5 z"/>',
    cover: '<path d="M12 2.5l7.5 2.8v5.7c0 4.6-3.2 7.4-7.5 9-4.3-1.6-7.5-4.4-7.5-9V5.3z"/>',
    reload: '<path d="M20.5 12a8.5 8.5 0 1 1-2.5-6"/><path d="M20.5 3.5v5h-5"/>',
    nade: '<circle cx="11.5" cy="14" r="6.3"/><rect x="8.5" y="3.8" width="6" height="3.7" rx="1"/><circle cx="6.5" cy="5.2" r="2"/>',
    melee: '<path d="M2 22l8.5-8.5"/><path d="M17 2l5 5-4 4-5-5z"/><path d="M9 11l4 4"/>',
    swap: '<path d="M4 7h12l-3-3"/><path d="M20 17H8l3 3"/>',
  };
  const icon = (n: string): string =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;

  const root = document.createElement("div");
  root.innerHTML = `
<style>
  #touch { position:fixed; inset:0; z-index:50; pointer-events:none;
    font-family:"Trebuchet MS",system-ui,sans-serif; -webkit-user-select:none; user-select:none; }
  #touchsurface { position:absolute; inset:0; pointer-events:auto; touch-action:none; }
  #joybase { position:absolute; width:${JOY_RADIUS * 2}px; height:${JOY_RADIUS * 2}px;
    margin:${-JOY_RADIUS}px 0 0 ${-JOY_RADIUS}px; border-radius:50%; display:none; pointer-events:none;
    background:rgba(255,255,255,.07); border:2px solid rgba(255,255,255,.25); }
  #joyknob { position:absolute; left:50%; top:50%; width:54px; height:54px; margin:-27px 0 0 -27px;
    border-radius:50%; pointer-events:none;
    background:rgba(255,255,255,.30); border:2px solid rgba(255,255,255,.55); }
  .tbtn { position:absolute; pointer-events:auto; touch-action:none; border-radius:50%;
    display:flex; align-items:center; justify-content:center; color:#fff;
    background:rgba(18,22,32,.42); border:2px solid rgba(255,255,255,.26); }
  .tbtn svg { width:46%; height:46%; display:block; }
  .tbtn.pressed { background:rgba(120,160,255,.55); }
  /* Compact thumb cluster: big FIRE in the corner, 2x3 grid of actions to its left. */
  #b-fire { right:22px; bottom:36px; width:88px; height:88px;
    background:rgba(150,40,32,.42); border-color:rgba(255,130,110,.5); }
  #b-fire svg { width:52%; height:52%; }
  #b-jump { right:122px; bottom:44px; width:52px; height:52px; }
  #b-build { right:180px; bottom:44px; width:52px; height:52px; }
  #b-sprint { right:122px; bottom:102px; width:52px; height:52px; }
  #b-reload { right:180px; bottom:102px; width:52px; height:52px; }
  #b-grenade { right:122px; bottom:160px; width:52px; height:52px; }
  #b-melee { right:180px; bottom:160px; width:52px; height:52px; }
  #b-swap { right:238px; bottom:44px; width:52px; height:52px; }
  #b-swap.pistol { background:rgba(220,170,60,.5); }
  /* Lift the ammo readout above the button cluster on touch. */
  #ammo { right:16px; bottom:226px; }
  #rotate { position:fixed; inset:0; z-index:200; display:none; background:#0c0f14; color:#fff;
    flex-direction:column; align-items:center; justify-content:center; text-align:center;
    font-family:"Trebuchet MS",system-ui,sans-serif; }
  @media (hover:none) and (pointer:coarse) and (orientation:portrait) { #rotate { display:flex; } }
</style>
<div id="touch">
  <div id="touchsurface"></div>
  <div id="joybase"><div id="joyknob"></div></div>
  <div id="b-fire" class="tbtn">${icon("fire")}</div>
  <div id="b-jump" class="tbtn">${icon("jump")}</div>
  <div id="b-sprint" class="tbtn">${icon("sprint")}</div>
  <div id="b-build" class="tbtn">${icon("cover")}</div>
  <div id="b-reload" class="tbtn">${icon("reload")}</div>
  <div id="b-grenade" class="tbtn">${icon("nade")}</div>
  <div id="b-melee" class="tbtn">${icon("melee")}</div>
  <div id="b-swap" class="tbtn">${icon("swap")}</div>
</div>
<div id="rotate">
  <div style="font-size:34px">\u{1F504}</div>
  <div style="font-size:18px;font-weight:800;margin-top:10px">Rotate your device</div>
  <div style="opacity:.7;margin-top:4px">landscape works best</div>
</div>`;
  document.body.appendChild(root);
  document.getElementById("hint")?.style.setProperty("display", "none");

  const surface = document.getElementById("touchsurface")!;
  const joybase = document.getElementById("joybase")!;
  const joyknob = document.getElementById("joyknob")!;

  let moveId = -1;
  const joyCenter = { x: 0, y: 0 };
  let lookId = -1;
  let lookX = 0;
  let lookY = 0;

  function setJoy(dx: number, dy: number): void {
    const dist = Math.hypot(dx, dy);
    const cl = dist > JOY_RADIUS ? JOY_RADIUS / dist : 1;
    const kx = dx * cl;
    const ky = dy * cl;
    joyknob.style.transform = `translate3d(${kx}px, ${ky}px, 0)`;
    const nx = kx / JOY_RADIUS;
    const ny = ky / JOY_RADIUS;
    const mag = Math.hypot(nx, ny);
    if (mag < JOY_DEAD) {
      touchFwd = 0;
      touchSide = 0;
      return;
    }
    // Remap [dead..1] -> [0..1] so there is no jump leaving the dead zone.
    const s = (mag - JOY_DEAD) / (1 - JOY_DEAD) / mag;
    touchSide = -nx * s;
    touchFwd = -ny * s;
  }

  surface.addEventListener("pointerdown", (e: PointerEvent) => {
    ensureAudio();
    if (e.pointerType !== "touch") {
      // Hybrid device on a mouse: hand off to the existing pointer-lock look.
      renderer.domElement.requestPointerLock();
      return;
    }
    e.preventDefault();
    surface.setPointerCapture(e.pointerId);
    if (e.clientX < window.innerWidth * 0.45 && moveId === -1) {
      moveId = e.pointerId;
      joyCenter.x = e.clientX;
      joyCenter.y = e.clientY;
      joybase.style.left = `${e.clientX}px`;
      joybase.style.top = `${e.clientY}px`;
      joybase.style.display = "block";
      joyknob.style.transform = "translate3d(0,0,0)";
    } else if (lookId === -1) {
      lookId = e.pointerId;
      lookX = e.clientX;
      lookY = e.clientY;
    }
  });

  surface.addEventListener("pointermove", (e: PointerEvent) => {
    if (e.pointerId === moveId) {
      setJoy(e.clientX - joyCenter.x, e.clientY - joyCenter.y);
      return;
    }
    if (e.pointerId !== lookId) return;
    const coalesced = e.getCoalescedEvents?.() ?? [];
    const list = coalesced.length > 0 ? coalesced : [e];
    let dx = 0;
    let dy = 0;
    for (const ev of list) {
      dx += ev.clientX - lookX;
      dy += ev.clientY - lookY;
      lookX = ev.clientX;
      lookY = ev.clientY;
    }
    yaw -= dx * LOOK_SENS;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * LOOK_SENS));
    while (yaw > Math.PI) yaw -= Math.PI * 2;
    while (yaw < -Math.PI) yaw += Math.PI * 2;
  });

  function endPointer(e: PointerEvent): void {
    if (e.pointerId === moveId) {
      moveId = -1;
      touchFwd = 0;
      touchSide = 0;
      joybase.style.display = "none";
    } else if (e.pointerId === lookId) {
      lookId = -1;
    }
  }
  surface.addEventListener("pointerup", endPointer);
  surface.addEventListener("pointercancel", endPointer);

  // Hold-to-press buttons: each maps to a key (or fireHeld), released on lift.
  function press(id: string, on: () => void, off: () => void): void {
    const b = document.getElementById(id)!;
    b.addEventListener("pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      b.classList.add("pressed");
      ensureAudio();
      on();
    });
    function release(e: Event): void {
      e.preventDefault();
      b.classList.remove("pressed");
      off();
    }
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
  }
  function key(code: string): [() => void, () => void] {
    return [() => keys.add(code), () => keys.delete(code)];
  }
  press(
    "b-fire",
    () => {
      fireHeld = true;
    },
    () => {
      fireHeld = false;
    },
  );
  press("b-jump", ...key("Space"));
  press("b-sprint", ...key("ShiftLeft"));
  press("b-build", ...key("KeyQ"));
  press("b-reload", ...key("KeyR"));
  press("b-grenade", ...key("KeyG"));
  press("b-melee", ...key("KeyF"));

  // Weapon swap is a toggle, not a hold: tap for pistol, tap again for primary.
  const swapBtn = document.getElementById("b-swap")!;
  swapBtn.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ensureAudio();
    desiredSlot = desiredSlot === 1 ? 0 : 1;
    swapBtn.classList.toggle("pistol", desiredSlot === 1);
  });
}

if (wantsTouch) setupTouchControls();

// ---------------------------------------------------------------------------
// Game state + prediction.

interface RemotePlayer {
  info: PlayerInfo;
  group: THREE.Group;
  buffer: Array<{
    t: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    flags: number;
  }>;
  lastFlags: number;
  lastProt: boolean;
  lastStepIndex: number;
  stepPhase: number;
  createdAt: number; // ms; used to grace-reveal the box rig if the model is slow
  // Latest weapon byte from the snapshot: active weapon (held model) low
  // nibble, class primary (character model) high nibble.
  weaponByte: number;
  heldWeapon: number; // weapon node currently shown on the rig
  lastPumpMs: number; // dedupes the pump sound across a blast's tracer events
  // Set once the Quaternius model + AnimationMixer replace the blocky fallback.
  anim?: CharacterAnim;
}

let selfIdx = -1;
let phase: "playing" | "results" = "playing";
let phaseEndTick = 0;
let mapEpoch = 0;
let scores: [number, number] = [0, 0];
const roster = new Map<number, PlayerInfo>();
const remotes = new Map<number, RemotePlayer>();
const kd = new Map<number, { k: number; d: number }>();
let selfStatus = 0;
let selfHp = MAX_HP;
let zoneState: ZoneSnap[] = ZONES.map(() => ({ owner: -1, v: 0 }));
const zonePips: HTMLElement[] = [];
const zoneFills: HTMLElement[] = [];
for (const def of ZONES) {
  const pip = document.createElement("div");
  pip.className = "zp";
  const fill = document.createElement("div");
  fill.className = "fill";
  const label = document.createElement("span");
  label.textContent = def.letter;
  pip.append(fill, label);
  el.zones.appendChild(pip);
  zonePips.push(pip);
  zoneFills.push(fill);
}
let respawnTicks = 0;
// Out-of-bounds feedback: when this client first strayed past the boundary
// (performance.now ms), or -1 in bounds. Server enforces the actual kill.
let oobStartMs = -1;
const OOB_LIMIT_SECONDS = OOB_LIMIT_TICKS / TICK_RATE;

let gw: GameWorld | null = null;
let selfBody: Body | null = null;
let worldBuildSeq = 0;
const ghostBodies = new Map<number, Body>();
let seq = 0;
let predState: CharState | null = null;
const history: Array<{ seq: number; cmd: InputCmd }> = [];
let lastAckSeq = 0;
let lastAckTick = 0;
let lastSnapAtMs = 0;
let rollbacks = 0;
let snapshotsSeen = 0;
let needHardAdopt = true;
const errOffset = new THREE.Vector3();
let lastEventSeq = 0;
let destroyedSet = new Set<number>();
const pieceAlive = (id: number): boolean => !destroyedSet.has(id);

// Resolve a mirror-world raycast hit to the piece under it (map slabs
// resolve analytically by position; runtime pieces carry their id).
function hitPieceId(body: Body, point: readonly number[]): number | null {
  return pieceIdFromHit(body, point, pieceAlive);
}
let builtList: PanelDef[] = [];
let collapsedList: number[] = [];
let welcomeHp: Array<[number, number]> = [];
let collapsedCount = 0;

// Input-rate servo (see snack-dash): hold the server buffer at a small depth.
const TARGET_DEPTH = 2;
let depthEma = TARGET_DEPTH;
let serverTickRefTick = 0;
let serverTickRefAtMs = 0;

// --- Adaptive interpolation delay (Source-style, jitter-driven). ---
// The buffer must always hold two snapshots to interpolate between, so the
// delay is sized from MEASURED inter-arrival gaps (jitter + loss), not ping:
// worst observed gap in the window plus one tick of slack, smoothly adjusted.
const INTERP_MIN_MS = 2 * TICK_MS;
// Must fit UNDER the server's 120ms lag-comp rewind cap with room for
// transit: a jitter buffer the server won't rewind for converts into misses.
const INTERP_MAX_MS = 3 * TICK_MS;
let interpDelayMs = 3 * TICK_MS;
let lastArrivalMs = 0;
let gapWindowMax = 0;
let gapWindowStart = 0;
let prevGapWindowMax = TICK_MS;
// Arrival log for mapping render time -> server tick of the rendered world.
const arrivals: Array<{ t: number; tick: number }> = [];

function noteArrival(receivedAt: number, serverTick: number): void {
  if (lastArrivalMs > 0) {
    gapWindowMax = Math.max(gapWindowMax, receivedAt - lastArrivalMs);
  }
  lastArrivalMs = receivedAt;
  if (receivedAt - gapWindowStart > 2000) {
    prevGapWindowMax = gapWindowMax;
    gapWindowMax = 0;
    gapWindowStart = receivedAt;
  }
  arrivals.push({ t: receivedAt, tick: serverTick });
  if (arrivals.length > 90) arrivals.splice(0, arrivals.length - 90);
}

function targetInterpDelayMs(): number {
  const worstGap = Math.max(gapWindowMax, prevGapWindowMax);
  return Math.max(INTERP_MIN_MS, Math.min(INTERP_MAX_MS, worstGap + TICK_MS));
}

// The server tick of the world being rendered right now (for viewTick).
function renderedWorldTick(now: number): number {
  const renderT = now - interpDelayMs;
  if (arrivals.length === 0) return Math.max(0, Math.floor(estServerTick()));
  let a = arrivals[0];
  let b = arrivals[arrivals.length - 1];
  for (let i = arrivals.length - 1; i >= 0; i--) {
    if (arrivals[i].t <= renderT) {
      a = arrivals[i];
      b = arrivals[Math.min(i + 1, arrivals.length - 1)];
      break;
    }
  }
  const span = Math.max(1, b.t - a.t);
  const u = Math.max(0, Math.min(1, (renderT - a.t) / span));
  return Math.round(a.tick + (b.tick - a.tick) * u);
}

function estimatedServerTickNow(): number {
  if (serverTickRefAtMs === 0) return 0;
  return serverTickRefTick + (performance.now() - serverTickRefAtMs) / TICK_MS;
}

function estServerTick(): number {
  return lastAckTick + (seq - lastAckSeq);
}

function copyCtrl(into: CharState, from: CharState): void {
  into.onGround = from.onGround;
  into.jumpHeld = from.jumpHeld;
  into.fireHeld = from.fireHeld;
  into.grenadeHeld = from.grenadeHeld;
  into.meleeHeld = from.meleeHeld;
  into.buildHeld = from.buildHeld;
  into.coyoteTicks = from.coyoteTicks;
  into.cooldownTicks = from.cooldownTicks;
  into.reloadTicks = from.reloadTicks;
  into.ammo = from.ammo;
  into.ammo2 = from.ammo2;
  into.slot = from.slot;
  into.primary = from.primary;
  into.recoilTicks = from.recoilTicks;
  into.grenades = from.grenades;
  into.supply = from.supply;
}

// Rebuild the shared map from the server's seed — every game is a new level.
// Idempotent per seed (reconnects mid-round pay nothing); on a real change,
// every client-side cache derived from the old terrain drops here. The scene
// itself rebuilds in buildWorlds(), which callers trigger right after.
function applyMapSeed(seed: number): void {
  if (seed >>> 0 === mapSeed()) return;
  initMap(seed);
  baseHGrid = null;
  mmBase = null;
  warmBaseHeightGrid(); // one exact pass; minimap + face coloring read it
  for (const m of minimaps) m.repaint();
}

async function buildWorlds(): Promise<void> {
  const buildId = ++worldBuildSeq;
  needHardAdopt = true;
  // Let the browser paint (the intro screen, the roster) before the scene
  // build blocks the main thread for seconds; also lets the queued model
  // fetches dispatch instead of stalling behind it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  if (buildId !== worldBuildSeq) return;
  buildMapVisuals();
  const tWorld0 = performance.now();
  const next = await createGameWorld(destroyedSet);
  recordBootStage("createGameWorld", tWorld0);
  if (buildId !== worldBuildSeq) {
    destroyGameWorld(next);
    return;
  }
  if (gw) destroyGameWorld(gw);
  ghostBodies.clear();
  gw = next;
  selfBody = createPlayerBody(gw, Math.max(0, selfIdx), [0, 2, 0]);
  if (!predState) predState = makeChar([0, 2, 0]);
  // Re-apply this round's destruction/construction.
  for (const p of builtList) {
    addPanelBody(gw, p);
    addBuiltPanelVisual(p);
  }
  for (const id of destroyedSet) removePanelVisual(id, false);
  for (const buildingId of collapsedList) {
    if (MAP.buildings[buildingId]?.kind === "tree") continue;
    addRubbleVisual(buildingId);
    addRubbleBody(gw, MAP.buildings[buildingId], RUBBLE_HEIGHT);
  }
  for (const [id, hp] of welcomeHp) tintPanelDamage(id, hp);
  welcomeHp = [];
}

// --- Streams.

async function readStreams(): Promise<void> {
  try {
    while (true) {
      const event = await client.streams.recv();
      const msg = parseServerMsg(event.json());
      if (msg) handleServerMsg(msg);
    }
  } catch {
    await client.closed;
  }
}

function nameOf(idx: number): string {
  return roster.get(idx)?.name ?? `player ${idx}`;
}

function myTeam(): number {
  return roster.get(selfIdx)?.team ?? -1;
}

function teamSpan(idx: number): string {
  const team = roster.get(idx)?.team ?? 0;
  return `<span style="color:${TEAM_COLORS_CSS[team]}">${escapeHtml(nameOf(idx))}</span>`;
}

function handleServerMsg(msg: NonNullable<ReturnType<typeof parseServerMsg>>): void {
  switch (msg.type) {
    case "welcome": {
      selfIdx = msg.selfIdx;
      roster.clear();
      for (const p of msg.players) roster.set(p.idx, p);
      phase = msg.phase;
      phaseEndTick = msg.phaseEndTick;
      scores = [msg.scores[0], msg.scores[1]];
      mapEpoch = msg.mapEpoch;
      applyMapSeed(msg.mapSeed); // BEFORE replaying destruction/craters below
      destroyedSet = new Set(msg.destroyed);
      builtList = [...msg.built];
      collapsedList = [...msg.collapsed];
      welcomeHp = [...msg.panelHp];
      resetCraters();
      for (const c of msg.craters) addCrater(c);
      lastAckTick = msg.serverTick;
      refreshAllNameTags();
      // A fresh welcome means a fresh server-side player: replay our spawn
      // and class preferences so they survive reconnects.
      if (spawnChoice !== SPAWN_AUTO) sendSpawnChoice();
      if (classChoice !== 0) sendClassChoice();
      void buildWorlds();
      break;
    }
    case "join": {
      roster.set(msg.player.idx, msg.player);
      const joinedRp = remotes.get(msg.player.idx);
      if (joinedRp) {
        joinedRp.info = msg.player;
        refreshNameTag(joinedRp);
      }
      if (msg.player.idx !== selfIdx) {
        feed(`${teamSpan(msg.player.idx)} joined`);
      }
      break;
    }
    case "leave": {
      const info = roster.get(msg.idx);
      if (info) feed(`${teamSpan(msg.idx)} left`);
      roster.delete(msg.idx);
      kd.delete(msg.idx);
      dropRemote(msg.idx);
      break;
    }
    case "kill": {
      if (msg.weapon === "oob") {
        feed(`${teamSpan(msg.victim)} ⚠ left the battlefield`);
        bumpKd(msg.victim, "d");
        if (msg.victim === selfIdx) sounds.death();
        else {
          const at = eyeOf(msg.victim);
          if (at) sounds.deathAt(at);
        }
        break;
      }
      const icon = msg.weapon === "grenade" ? "💥" : msg.weapon === "melee" ? "🔨" : "•";
      feed(`${teamSpan(msg.killer)} ${icon} ${teamSpan(msg.victim)}`);
      bumpKd(msg.killer, "k");
      bumpKd(msg.victim, "d");
      if (msg.victim === selfIdx) sounds.death();
      else {
        const at = eyeOf(msg.victim);
        if (at) sounds.deathAt(at);
      }
      if (msg.killer === selfIdx && msg.victim !== selfIdx) sounds.hitmarker();
      break;
    }
    case "panelhp": {
      for (const [id, hp] of msg.updates) tintPanelDamage(id, hp);
      break;
    }
    case "collapse": {
      collapsedCount++;
      collapseFx(msg.buildingId);
      // Trees topple piece by piece (fall/settle) — no mound; buildings
      // implode onto one.
      if (MAP.buildings[msg.buildingId]?.kind !== "tree") {
        addRubbleVisual(msg.buildingId);
        if (gw) addRubbleBody(gw, MAP.buildings[msg.buildingId], RUBBLE_HEIGHT);
      }
      collapsedList.push(msg.buildingId);
      break;
    }
    case "destroy": {
      // Collapses destroy hundreds of pieces at once — cap the debris shower.
      let debrisLeft = 50;
      const dirty = new Set<number>();
      for (const id of msg.panelIds) {
        destroyedSet.add(id);
        builtList = builtList.filter((p) => p.id !== id);
        if (id < BUILT_PANEL_ID_BASE) {
          const slabIdx = slabOfPiece(id);
          if (slabIdx >= 0) dirty.add(slabIdx);
        } else if (gw) {
          removePanelBody(gw, id);
        }
        removePanelVisual(id, debrisLeft-- > 0);
      }
      if (gw) {
        for (const slabIdx of dirty) rebuildSlabBody(gw, slabIdx, pieceAlive);
      }
      removeDecalsForPanels(new Set(msg.panelIds));
      break;
    }
    case "fall": {
      startChunkView(msg.chunkId, msg.origin, msg.pieces);
      break;
    }
    case "settle": {
      endChunkView(msg.chunkId);
      for (const piece of msg.pieces) {
        builtList.push(piece);
        if (gw) addPanelBody(gw, piece);
        addBuiltPanelVisual(piece);
      }
      break;
    }
    case "crater": {
      addCrater(msg.crater);
      if (gw) applyCraterBodies(gw, msg.crater);
      for (const [ci, cj] of chunksTouching(msg.crater)) {
        rebuildTerrainChunk(ci, cj);
      }
      removeDecalsInCrater(msg.crater);
      break;
    }
    case "build": {
      builtList.push(msg.panel);
      if (gw) addPanelBody(gw, msg.panel);
      addBuiltPanelVisual(msg.panel);
      if (msg.panel.material !== "rubble") {
        sounds.buildAt(new THREE.Vector3(msg.panel.x, msg.panel.y, msg.panel.z));
      }
      break;
    }
    case "rubble": {
      // Explosion debris, batched. Pure visuals/collision — no build sound.
      for (const panel of msg.panels) {
        builtList.push(panel);
        if (gw) addPanelBody(gw, panel);
        addBuiltPanelVisual(panel);
      }
      break;
    }
    case "score": {
      scores = [msg.scores[0], msg.scores[1]];
      break;
    }
    case "phase": {
      phase = msg.phase;
      phaseEndTick = msg.phaseEndTick;
      scores = [msg.scores[0], msg.scores[1]];
      if (msg.mapEpoch !== mapEpoch) {
        mapEpoch = msg.mapEpoch;
        applyMapSeed(msg.mapSeed); // a new epoch is a brand-new level
        destroyedSet.clear();
        builtList = [];
        collapsedList = [];
        resetCraters();
        kd.clear();
        void buildWorlds();
      }
      break;
    }
  }
}

function bumpKd(idx: number, which: "k" | "d"): void {
  const e = kd.get(idx) ?? { k: 0, d: 0 };
  if (which === "k") e.k++;
  else e.d++;
  kd.set(idx, e);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// --- Snapshots.

async function readDatagrams(): Promise<void> {
  try {
    while (true) {
      const event = await client.datagrams.recv();
      const snap = decodeSnapshot(event.bytes);
      // A throw inside the snapshot handler must NOT kill the receive loop —
      // otherwise one bad snapshot stops all further updates (remotes freeze,
      // tracers/shot sounds vanish, and you die to fire you never saw). Log and
      // keep draining; only a closed connection (recv rejecting) ends the loop.
      if (snap) {
        try {
          handleSnapshot(snap, event.receivedAt);
        } catch (err) {
          console.error("[fps] snapshot handler error:", err);
        }
      }
    }
  } catch {
    await client.closed;
  }
}

function handleSnapshot(snap: Snapshot, receivedAt: number): void {
  const tSnap0 = performance.now();
  snapshotsSeen++;
  if (lastSnapAtMs > 0 && receivedAt - lastSnapAtMs > 1500) needHardAdopt = true;
  lastSnapAtMs = receivedAt;

  noteArrival(receivedAt, snap.serverTick);
  noteChunkPoses(snap, receivedAt);
  zoneState = snap.zones;
  scores = [snap.tickets[0], snap.tickets[1]];
  const prevSelfStatus = selfStatus;
  selfStatus = snap.self.status;
  if ((prevSelfStatus & SS_DEAD) === 0 && (selfStatus & SS_DEAD) !== 0 && predState) {
    const team = roster.get(selfIdx)?.team ?? 0;
    spawnCorpse(new THREE.Vector3(predState.x, predState.y, predState.z), yaw, team);
  }
  // Back alive: the server just respawned us — face the action from the new
  // spawn position before the first rendered frame, primary in hand.
  if ((prevSelfStatus & SS_DEAD) !== 0 && (selfStatus & SS_DEAD) === 0) {
    faceTheAction(snap.self.state.x, snap.self.state.z);
    desiredSlot = 0;
  }
  selfHp = snap.self.hp;
  respawnTicks = snap.self.respawnTicks;
  phase = snap.phase === 0 ? "playing" : "results";
  phaseEndTick = snap.phaseEndTick;
  depthEma = depthEma * 0.9 + snap.self.bufferDepth * 0.1;

  const est = estimatedServerTickNow();
  if (serverTickRefAtMs === 0 || Math.abs(est - snap.serverTick) > 5) {
    serverTickRefTick = snap.serverTick;
  } else {
    serverTickRefTick = est * 0.9 + snap.serverTick * 0.1;
  }
  serverTickRefAtMs = receivedAt;

  // Remotes -> interpolation buffers.
  const seen = new Set<number>();
  for (const r of snap.remotes) {
    seen.add(r.idx);
    let rp = remotes.get(r.idx);
    if (!rp) {
      const team = (r.flags & RF_TEAM) !== 0 ? 1 : 0;
      rp = {
        info: roster.get(r.idx) ?? {
          idx: r.idx,
          name: `player ${r.idx}`,
          team,
        },
        group: makeSoldier(team, nameOf(r.idx)),
        buffer: [],
        lastFlags: 0,
        lastProt: false,
        lastStepIndex: -1,
        stepPhase: 0,
        createdAt: performance.now(),
        weaponByte: r.weapon,
        heldWeapon: -1,
        lastPumpMs: 0,
      };
      remotes.set(r.idx, rp);
      attachExternalSoldier(rp); // swaps in the animated model when ready
      refreshNameTag(rp);
    }
    if (r.weapon !== rp.weaponByte) {
      rp.weaponByte = r.weapon;
      applyRemoteWeapon(rp);
    }
    const prevFlags = rp.lastFlags;
    const wasNew = rp.buffer.length === 0;
    rp.buffer.push({
      t: receivedAt,
      x: r.x,
      y: r.y,
      z: r.z,
      yaw: r.yaw,
      pitch: r.pitch,
      flags: r.flags,
    });
    if (rp.buffer.length > 40) rp.buffer.splice(0, rp.buffer.length - 40);
    rp.lastFlags = r.flags;
    // Death transition: drop a ragdoll where viewers last saw them standing
    // (the server has already parked the body at spawn).
    if (!wasNew && (prevFlags & RF_DEAD) === 0 && (r.flags & RF_DEAD) !== 0) {
      spawnCorpse(rp.group.position, rp.group.rotation.y, rp.info.team);
    }
  }
  for (const idx of remotes.keys()) {
    if (!seen.has(idx) && !roster.has(idx)) dropRemote(idx);
  }

  processEvents(snap.events);
  updateGrenadeViews(snap);

  const ack = snap.self;
  lastAckSeq = ack.ackSeq;
  lastAckTick = ack.ackTick;

  if (!gw || !selfBody || !predState) return;

  if (needHardAdopt) {
    writeChar(selfBody, ack.state);
    copyCtrl(predState, ack.state);
    readChar(selfBody, predState);
    syncGhosts(snap);
    syncGrenades(snap);
    history.length = 0;
    errOffset.set(0, 0, 0);
    needHardAdopt = false;
    return;
  }

  // Restore whole mirror world from the snapshot, replay pending inputs.
  const before = selfBody.translation();
  writeChar(selfBody, ack.state);
  copyCtrl(predState, ack.state);
  syncGhosts(snap);
  syncGrenades(snap);

  while (history.length > 0 && history[0].seq <= ack.ackSeq) history.shift();
  const dead = (selfStatus & SS_DEAD) !== 0 || phase !== "playing";
  for (const h of history) {
    stepPlayerController(gw, selfBody, predState, h.cmd, { locked: dead });
    gw.world.step(1 / TICK_RATE);
  }
  readChar(selfBody, predState);

  const after = selfBody.translation();
  const dx = before.x - after.x;
  const dy = before.y - after.y;
  const dz = before.z - after.z;
  if (Math.hypot(dx, dy, dz) > 0.03) rollbacks++;
  errOffset.x += dx;
  errOffset.y += dy;
  errOffset.z += dz;
  if (errOffset.length() > 3) errOffset.set(0, 0, 0);
  perf.snapMs += performance.now() - tSnap0;
  perf.snapCalls++;
}

function syncGhosts(snap: Snapshot): void {
  if (!gw) return;
  const seen = new Set<number>();
  for (const r of snap.remotes) {
    if ((r.flags & RF_DEAD) !== 0) continue; // dead bodies don't collide
    seen.add(r.idx);
    let body = ghostBodies.get(r.idx);
    if (!body) {
      body = createPlayerBody(gw, 1000 + r.idx, [r.x, r.y, r.z], { kinematic: true });
      ghostBodies.set(r.idx, body);
    }
    // Match the floating collision height of the authoritative dynamic bodies
    // (the capsule hovers PLAYER_FLOAT_HEIGHT above feet) so local prediction
    // collides with remote ghosts at the same place the server sees them.
    body.setTranslation([r.x, r.y + PLAYER_HALF_HEIGHT + PLAYER_FLOAT_HEIGHT, r.z]);
    body.setLinearVelocity(0, 0, 0);
  }
  for (const [idx, body] of ghostBodies) {
    if (!seen.has(idx)) {
      gw.world.removeBody(body);
      gw.players.delete(1000 + idx);
      ghostBodies.delete(idx);
    }
  }
}

function syncGrenades(snap: Snapshot): void {
  if (!gw) return;
  const seen = new Set<number>();
  for (const e of snap.entities) {
    seen.add(e.id);
    const body = gw.grenades.get(e.id);
    if (!body) createGrenadeBody(gw, e.id, [e.x, e.y, e.z], [e.vx, e.vy, e.vz]);
    else {
      body.setTranslation([e.x, e.y, e.z]);
      body.setLinearVelocity(e.vx, e.vy, e.vz);
    }
  }
  for (const id of gw.grenades.keys()) {
    if (!seen.has(id)) removeGrenadeBody(gw, id);
  }
}

// Local closest-hit ray that skips our own capsule (mirror-world query).
function castLocal(
  origin: readonly number[],
  dir: readonly number[],
  length: number,
): { point: [number, number, number]; body: Body } | null {
  if (!gw || !selfBody) return null;
  let ox = origin[0];
  let oy = origin[1];
  let oz = origin[2];
  let remaining = length;
  for (let hop = 0; hop < 3; hop++) {
    const hit = gw.world.castRay(
      [ox, oy, oz],
      [dir[0] * remaining, dir[1] * remaining, dir[2] * remaining],
    );
    if (!hit || !hit.body) return null;
    const px = ox + dir[0] * remaining * hit.fraction;
    const py = oy + dir[1] * remaining * hit.fraction;
    const pz = oz + dir[2] * remaining * hit.fraction;
    if (hit.body !== selfBody) return { point: [px, py, pz], body: hit.body };
    const step = remaining * hit.fraction + 0.45;
    ox += dir[0] * step;
    oy += dir[1] * step;
    oz += dir[2] * step;
    remaining -= step;
    if (remaining <= 0) return null;
  }
  return null;
}

// --- Prediction loop.

let connected = false;
let tickAccum = 0;
let lastFrameAt = performance.now();

// Rolling perf counters (exposed via __fps.perf and the netinfo line).
const perf = {
  frames: 0,
  frameMs: 0,
  predictMs: 0,
  predictCalls: 0,
  snapMs: 0,
  snapCalls: 0,
  renderMs: 0,
  worstFrameMs: 0,
  windowStart: performance.now(),
  fps: 0,
  avgFrameMs: 0,
  avgPredictMs: 0,
  avgSnapMs: 0,
  avgRenderMs: 0,
  maxFrameMs: 0,
  drawCalls: 0,
  triangles: 0,
};

function rollPerfWindow(now: number): void {
  const span = now - perf.windowStart;
  if (span < 2000) return;
  perf.fps = (perf.frames / span) * 1000;
  perf.avgFrameMs = perf.frames > 0 ? perf.frameMs / perf.frames : 0;
  perf.avgPredictMs = perf.predictCalls > 0 ? perf.predictMs / perf.predictCalls : 0;
  perf.avgSnapMs = perf.snapCalls > 0 ? perf.snapMs / perf.snapCalls : 0;
  perf.avgRenderMs = perf.frames > 0 ? perf.renderMs / perf.frames : 0;
  perf.maxFrameMs = perf.worstFrameMs;
  perf.drawCalls = renderer.info.render.calls;
  perf.triangles = renderer.info.render.triangles;
  perf.frames = 0;
  perf.frameMs = 0;
  perf.predictMs = 0;
  perf.predictCalls = 0;
  perf.snapMs = 0;
  perf.snapCalls = 0;
  perf.renderMs = 0;
  perf.worstFrameMs = 0;
  perf.windowStart = now;
}

// Where the eye was after the previous tick, for render interpolation.
let prevEyeX = 0;
let prevEyeY = 0;
let prevEyeZ = 0;
let lastTickAt = 0;
let selfWalkPhase = 0;
let selfLastStepIndex = -1;

// Runs on a steady timer, NOT inside requestAnimationFrame: when rendering
// drops below the tick rate, inputs must still flow to the server at a smooth
// 30/s or the input buffer whipsaws between dry and flooded — every dry tick
// is a guaranteed misprediction (this showed up as 24% rollback rates under
// rAF throttling).
function predictionPump(): void {
  const now = performance.now();
  const dtMs = Math.min(250, now - lastPumpAt);
  lastPumpAt = now;
  const rate = 1 + Math.max(-0.06, Math.min(0.06, (TARGET_DEPTH - depthEma) * 0.025));
  tickAccum += dtMs * rate;
  // Catch up across the whole missed window (dtMs is already clamped to
  // 250ms): on a starved main thread — software rendering, background tab —
  // the pump fires rarely, and discarding the remainder used to collapse
  // input production to a trickle.
  let steps = 0;
  while (tickAccum >= TICK_MS && steps < 8) {
    tickAccum -= TICK_MS;
    predictionTick();
    steps++;
  }
  if (steps === 8) tickAccum = Math.min(tickAccum, TICK_MS); // don't spiral
}
let lastPumpAt = performance.now();
setInterval(predictionPump, 8);

function predictionTick(): void {
  if (!connected || needHardAdopt || !predState || !gw || !selfBody) return;
  const t0 = performance.now();
  if (predState) {
    prevEyeX = predState.x;
    prevEyeY = predState.y;
    prevEyeZ = predState.z;
  }
  lastTickAt = t0;
  seq++;
  const cmd = sampleInput(seq);
  const dead = (selfStatus & SS_DEAD) !== 0 || phase !== "playing";

  const ammoBefore = predState.slot === 1 ? predState.ammo2 : predState.ammo;
  const reloadBefore = predState.reloadTicks;
  stepPlayerController(gw, selfBody, predState, cmd, {
    locked: dead,
    onFire: (_eye, dir) => {
      const w = predState ? activeWeapon(predState) : WEAPON_LIST[0];
      sounds.shot(w.name);
      // Visual camera kick scales with the weapon's real recoil — heavy guns
      // (sniper, revolver) blow past the light-weapon cap and slam the view,
      // the rifle nudges it.
      recoil = Math.min(1.6, recoil + (w.kick > 0.1 ? 1.5 : w.kick > 0.06 ? 0.7 : 0.4));
      // Pump-action: rack the next shell shortly after the blast (while the
      // ~570ms cycle runs), as long as a shell is left to chamber.
      if (w.pellets && predState && (predState.slot === 1 ? predState.ammo2 : predState.ammo) > 0) {
        setTimeout(() => sounds.pump(), 230);
      }
      // Predicted tracers from local raycasts — instant feedback; the
      // server's events remain authoritative for hits and damage. Rays start
      // at the barrel like the server's (dir already carries recoil), and
      // pellet weapons show the whole spray (the server rolls its own spread,
      // so these pellets are purely visual).
      if (gw && selfBody && predState) {
        const mo = muzzleOrigin(predState, cmd.yaw, cmd.pitch);
        const from = muzzleWorld().clone();
        const pellets = w.pellets ?? 1;
        const spread = pellets > 1 ? spreadFor(predState) : 0;
        for (let i = 0; i < pellets; i++) {
          const d =
            pellets > 1
              ? perturb(dir, (Math.random() - 0.5) * 2 * spread, (Math.random() - 0.5) * 2 * spread)
              : dir;
          const hit = castLocal(mo, d, w.range);
          const end = hit
            ? new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2])
            : new THREE.Vector3(
                mo[0] + d[0] * w.range,
                mo[1] + d[1] * w.range,
                mo[2] + d[2] * w.range,
              );
          spawnTracer(from, end);
          const tag = (hit?.body.userData ?? {}) as { playerIdx?: number; grenadeId?: number };
          if (hit && i < 3 && tag.playerIdx === undefined && tag.grenadeId === undefined) {
            const pieceId = hitPieceId(hit.body, hit.point) ?? undefined;
            spawnBulletDecal(end, surfaceNormalAt(hit.body, end), pieceId);
          }
        }
      }
    },
    onMelee: () => {
      sounds.melee();
      meleeSwing = 1;
    },
    onGrenade: () => blip(380, 0.08, 0.1),
    // Build is server-validated; the predicted supply decrement shows in the
    // HUD instantly and reconciles if the server refunds it.
    onBuild: () => {},
  });
  gw.world.step(1 / TICK_RATE);
  readChar(selfBody, predState);
  stepSelfFootsteps(dead);
  if (reloadBefore === 0 && predState.reloadTicks > 0 && ammoBefore < activeWeapon(predState).mag) {
    sounds.reload(activeWeapon(predState).reloadTicks / TICK_RATE);
  }

  history.push({ seq, cmd });
  if (history.length > 240) history.shift();
  const tail = history.slice(-INPUT_REDUNDANCY).map((h) => h.cmd);
  void client.datagrams.send(encodeInputs(tail)).catch(() => {});
  perf.predictMs += performance.now() - t0;
  perf.predictCalls++;
}

function stepSelfFootsteps(dead: boolean): void {
  if (!predState || dead || !predState.onGround) {
    selfLastStepIndex = -1;
    return;
  }
  const speed = Math.hypot(predState.vx, predState.vz);
  if (speed < 1.1) {
    selfLastStepIndex = -1;
    return;
  }
  selfWalkPhase += speed * (1 / TICK_RATE) * FOOTSTEP_CADENCE;
  const stepIndex = Math.floor(selfWalkPhase / Math.PI);
  if (stepIndex !== selfLastStepIndex) {
    selfLastStepIndex = stepIndex;
    sounds.footstep(predState.x, predState.y, predState.z, 0.4);
  }
}

// ---------------------------------------------------------------------------
// Optional Quaternius Toon Shooter models.

interface ToonShooterManifest {
  characters?: string[];
  weapons?: string[];
  environment?: string[];
  vehicles?: string[];
}

interface CharacterTemplate {
  scene: THREE.Group;
  clips: THREE.AnimationClip[];
}
interface CharacterInstance {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
}
// Per-instance animation state carried on each remote player / corpse.
interface CharacterAnim {
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  base: string; // current looping locomotion clip
  shootUntil: number; // ms timestamp; play the *_Shoot variant until then
  jumpUntil: number; // ms timestamp; play the airborne clip until then
  hitUntil: number; // ms timestamp; play the HitReact flinch until then
  animSpeed: number; // smoothed locomotion speed (kills per-snapshot jitter)
  sprintAnim: boolean; // hysteresis latch for the sprint clip
}

// One Soldier model for every player — the game reads red vs blue from the
// tint + badge, and a player's class from the weapon in their hands. The rig
// carries all the kit's weapon nodes; setHeldWeapon reveals the right one.
const characterTemplates: Array<CharacterTemplate | null> = [null];
// First-person weapon templates by WEAPON_LIST index (rifle..pistol).
const viewWeaponTemplates: Array<THREE.Group | null> = WEAPON_LIST.map(() => null);
const VIEW_WEAPON_FILES: RegExp[] = [
  /\/AK\.gltf$/i,
  /\/SMG\.gltf$/i,
  /\/Shotgun\.gltf$/i,
  /\/Sniper\.gltf$/i,
  /\/Pistol\.gltf$/i,
  /\/Revolver\.gltf$/i,
];
// Bounding-height each view weapon is scaled to (the models' proportions
// differ wildly; a pistol scaled to rifle height fills the screen).
const VIEW_WEAPON_HEIGHT = [0.42, 0.34, 0.4, 0.46, 0.22, 0.26];
// The weapon node shown in a character's hands, by WEAPON_LIST index.
const WEAPON_NODE_NAMES = ["AK", "SMG", "Shotgun", "Sniper", "Pistol", "Revolver"];
let externalAssetsRequested = false;
const EXTERNAL_CHARACTER_YAW = 0; // Quaternius characters face local +Z, like the blocky rig.
const EXTERNAL_VIEW_WEAPON_YAW = -Math.PI / 2; // gun barrels run down -X; turn to the camera's -Z (forward).
const CHARACTER_WEAPON_NODES = new Set([
  "AK",
  "GrenadeLauncher",
  "Knife_1",
  "Knife_2",
  "Pistol",
  "Revolver",
  "Revolver_Small",
  "RocketLauncher",
  "ShortCannon",
  "Shotgun",
  "Shovel",
  "SMG",
  "Sniper",
  "Sniper_2",
]);

function loadExternalVisualAssets(): void {
  if (externalAssetsRequested) return;
  externalAssetsRequested = true;
  void fetch("/assets/vendor/quaternius-toon-shooter/manifest.json", { cache: "no-cache" })
    .then((response) => (response.ok ? response.json() : null))
    .then((manifest: ToonShooterManifest | null) => {
      const charUrls = manifest?.characters ?? [];
      const soldierUrl = charUrls.find((u) => /soldier/i.test(u)) ?? charUrls[0];
      if (soldierUrl) {
        void loadCharacterTemplate(soldierUrl)
          .then((t) => {
            characterTemplates[0] = t;
          })
          .catch(() => {});
      }
      const weaponUrls = manifest?.weapons ?? [];
      for (let w = 0; w < VIEW_WEAPON_FILES.length; w++) {
        const url = weaponUrls.find((u) => VIEW_WEAPON_FILES[w].test(u));
        if (!url) continue;
        const idx = w;
        void loadModel(url)
          .then(({ scene }) => {
            prepareExternalModel(scene, VIEW_WEAPON_HEIGHT[idx]);
            viewWeaponTemplates[idx] = scene;
          })
          .catch(() => {});
      }
    })
    .catch(() => {});
}

async function loadModel(
  url: string,
): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".glb") || clean.endsWith(".gltf")) {
    const result = await new GLTFLoader().loadAsync(url);
    return { scene: result.scene, animations: result.animations };
  }
  if (clean.endsWith(".fbx")) {
    const obj = await new FBXLoader().loadAsync(url);
    return { scene: obj, animations: obj.animations };
  }
  if (clean.endsWith(".obj")) {
    return { scene: await new OBJLoader().loadAsync(url), animations: [] };
  }
  throw new Error(`Unsupported model format: ${url}`);
}

// Quaternius loop clips duplicate frame 0 as their final keyframe. With
// LoopRepeat the mixer therefore holds that pose for one extra frame at the
// wrap, which reads as a hitch every cycle. When a clip's first sample equals
// its last (a genuine seamless loop), shorten its duration to the second-to-last
// keyframe so the loop wraps one frame early and skips the duplicate. One-shot
// clips (Death, Jump, HitReact) have first != last and are left untouched.
function trimDuplicateLoopFrame(clip: THREE.AnimationClip): void {
  if (clip.tracks.length === 0) return;
  let secondLast = 0;
  for (const track of clip.tracks) {
    const n = track.times.length;
    if (n < 3) return; // too short to carry a duplicate end frame
    const stride = track.values.length / n;
    for (let c = 0; c < stride; c++) {
      if (Math.abs(track.values[c] - track.values[(n - 1) * stride + c]) > 1e-4) return; // not closed
    }
    secondLast = Math.max(secondLast, track.times[n - 2]);
  }
  if (secondLast > 0) clip.duration = secondLast;
}

async function loadCharacterTemplate(url: string): Promise<CharacterTemplate> {
  const { scene, animations } = await loadModel(url);
  prepareExternalCharacterModel(scene);
  for (const clip of animations) trimDuplicateLoopFrame(clip);
  return { scene, clips: animations };
}

function prepareExternalCharacterModel(root: THREE.Group): void {
  // Hide every weapon node; instances reveal exactly one via setHeldWeapon.
  root.traverse((o) => {
    if (CHARACTER_WEAPON_NODES.has(o.name)) o.visible = false;
  });
  prepareExternalModel(root, 1.78, (o) => !hasNamedAncestor(o, CHARACTER_WEAPON_NODES));
}

// Show the weapon the player is actually holding on a character rig.
function setHeldWeapon(root: THREE.Object3D, weaponIdx: number): void {
  const want = WEAPON_NODE_NAMES[weaponIdx] ?? WEAPON_NODE_NAMES[0];
  root.traverse((o) => {
    if (WEAPON_NODE_NAMES.includes(o.name)) o.visible = o.name === want;
  });
}

function prepareExternalModel(
  root: THREE.Group,
  targetHeight: number,
  includeInBounds: (object: THREE.Object3D) => boolean = () => true,
): void {
  root.updateWorldMatrix(true, true);
  const box = boxFromObject(root, includeInBounds);
  const size = box.getSize(new THREE.Vector3());
  if (size.y > 0) root.scale.multiplyScalar(targetHeight / size.y);
  root.updateWorldMatrix(true, true);
  box.copy(boxFromObject(root, includeInBounds));
  const center = box.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.y -= box.min.y;
  root.position.z -= center.z;
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

function boxFromObject(
  root: THREE.Object3D,
  includeInBounds: (object: THREE.Object3D) => boolean,
): THREE.Box3 {
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !isVisibleInHierarchy(o) || !includeInBounds(o)) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    if (!o.geometry.boundingBox) return;
    meshBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    box.union(meshBox);
  });
  return box.isEmpty() ? new THREE.Box3().setFromObject(root) : box;
}

function hasNamedAncestor(object: THREE.Object3D, names: ReadonlySet<string>): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (names.has(current.name)) return true;
    current = current.parent;
  }
  return false;
}

function isVisibleInHierarchy(object: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

function cloneMaterials(
  material: THREE.Material | THREE.Material[],
): THREE.Material | THREE.Material[] {
  return Array.isArray(material) ? material.map((m) => m.clone()) : material.clone();
}

function visitMeshMaterials(
  object: THREE.Object3D,
  visit: (material: THREE.Material) => void,
): void {
  if (!(object instanceof THREE.Mesh)) return;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  for (const material of materials) visit(material);
}

function setEmissive(material: THREE.Material, color: number): void {
  const candidate = material as THREE.Material & { emissive?: unknown };
  if (candidate.emissive instanceof THREE.Color) {
    candidate.emissive.setHex(color);
  }
}

function setColor(material: THREE.Material, color: number): void {
  const candidate = material as THREE.Material & { color?: unknown };
  if (candidate.color instanceof THREE.Color) candidate.color.setHex(color);
}

function cloneExternalModel(template: THREE.Group, team: number, accent = true): THREE.Group {
  const clone = cloneSkeleton(template) as THREE.Group;
  clone.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.material = cloneMaterials(o.material);
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  if (accent) {
    const badge = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.16, 0.05),
      new THREE.MeshLambertMaterial({ color: TEAM_COLORS[team] }),
    );
    badge.position.set(0.24, 1.22, 0.28);
    badge.castShadow = true;
    clone.add(badge);
  }
  return clone;
}

// Speeds the animator switches on. Normal ground move is 5.2 m/s (a Run); a
// Walk only shows during accel/decel. Sprint (7.6 m/s) plays the Run clip
// faster so sprinting reads differently from a normal run.
const ANIM_MOVE_SPEED = 0.6;
const ANIM_RUN_SPEED = 3.2;
const ANIM_SPRINT_SPEED = 6.4;
const FOOTSTEP_CADENCE = 1.7; // step-phase radians per metre (~2.8 steps/s at run)

// Clone a character template into a fresh animated instance: its own skeleton,
// per-instance materials (so flash/fade/spawn-ghost don't bleed across bodies),
// and an AnimationMixer bound to the cloned rig. Everyone is the same Soldier;
// team reads from the tint.
function instantiateCharacter(team: number): CharacterInstance | null {
  const tpl = characterTemplates[0];
  if (!tpl) return null;
  const root = cloneSkeleton(tpl.scene) as THREE.Group;
  const teamTint = TEAM_COLORS[team] ?? TEAM_COLORS[0];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.material = cloneMaterials(o.material);
      // Tint the main uniform/helmet to the team colour: red vs blue soldiers.
      visitMeshMaterials(o, (m) => {
        if (m.name === "Character_Main") setColor(m, teamTint);
      });
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = false; // skinned bounds drift off-origin; don't cull limbs
    }
  });
  const mixer = new THREE.AnimationMixer(root);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of tpl.clips) actions.set(clip.name, mixer.clipAction(clip));
  return { root, mixer, actions };
}

// Crossfade the looping locomotion clip. Shoot/jump/hit variants are full-body
// clips selected the same way, so the whole body is one action at a time.
// timeScale is refreshed every call (sprint speeds the Run clip up live).
function playClip(anim: CharacterAnim, name: string, fade = 0.18, timeScale = 1): void {
  const next = anim.actions.get(name);
  if (!next) return;
  next.setEffectiveTimeScale(timeScale);
  if (anim.base === name) return;
  const prev = anim.base ? anim.actions.get(anim.base) : undefined;
  next.enabled = true;
  next.setEffectiveWeight(1);
  next.setLoop(THREE.LoopRepeat, Infinity);
  next.reset().play();
  if (prev && prev !== next) next.crossFadeFrom(prev, fade, true);
  anim.base = name;
}

// Pick + drive the clip for a remote body from its interpolated motion, and
// plant positional footsteps on the locomotion cycle.
function updateCharacterAnim(
  rp: RemotePlayer,
  speed: number,
  vy: number,
  now: number,
  dt: number,
): void {
  const anim = rp.anim;
  if (!anim) return;
  if (vy > 2.6) anim.jumpUntil = now + 360; // a hard upward step => they jumped
  const airborne = now < anim.jumpUntil;
  const hit = now < anim.hitUntil;
  const shooting = now < anim.shootUntil;
  // Smooth the per-snapshot speed estimate and gate the sprint clip with
  // hysteresis, so a body whose speed hovers near a threshold (notably the
  // ~6.4 line between a normal run at 5.2 and a sprint at 7.6) doesn't flicker
  // between the jog and sprint clips every snapshot.
  anim.animSpeed += (speed - anim.animSpeed) * Math.min(1, dt * 8);
  const sp = anim.animSpeed;
  if (anim.sprintAnim) {
    if (sp < ANIM_SPRINT_SPEED - 0.8) anim.sprintAnim = false; // exit at ~5.6
  } else if (sp > ANIM_SPRINT_SPEED + 0.4) {
    anim.sprintAnim = true; // enter at ~6.8
  }
  const running = sp > ANIM_RUN_SPEED;
  const sprinting = anim.sprintAnim;
  const moving = sp > ANIM_MOVE_SPEED;
  let clip: string;
  let timeScale = 1;
  if (hit)
    clip = "HitReact"; // a brief flinch when they take a bullet
  else if (airborne) clip = "Jump_Idle";
  else if (shooting) clip = running ? "Run_Shoot" : moving ? "Walk_Shoot" : "Idle_Shoot";
  else if (sprinting) {
    clip = "Run"; // head-down sprint, weapon lowered (and can't fire)
    timeScale = 1.2;
  } else if (moving) {
    // Jog carrying the weapon in both hands at the ready (Run_Gun), time-scaled
    // to ground speed so the feet don't slide.
    clip = "Run_Gun";
    timeScale = Math.max(0.8, Math.min(1.2, sp / 5.2));
  } else clip = "Idle";
  playClip(anim, clip, 0.18, timeScale);
  if (moving && !airborne) {
    rp.stepPhase += speed * dt * FOOTSTEP_CADENCE;
    const idx = Math.floor(rp.stepPhase / Math.PI);
    if (idx !== rp.lastStepIndex) {
      rp.lastStepIndex = idx;
      sounds.footstepAt(rp.group.position.x, rp.group.position.y, rp.group.position.z, 0.34);
    }
  } else {
    rp.lastStepIndex = -1;
  }
}

function attachExternalSoldier(rp: RemotePlayer): void {
  if (rp.anim) return;
  const inst = instantiateCharacter(rp.info.team === 1 ? 1 : 0);
  if (!inst) return;
  const fallback = rp.group.userData.visualRoot as THREE.Object3D | undefined;
  if (fallback) fallback.visible = false; // retire the blocky placeholder rig
  inst.root.name = "externalCharacter";
  inst.root.rotation.y = EXTERNAL_CHARACTER_YAW;
  rp.group.add(inst.root);
  rp.heldWeapon = weaponByteActive(rp.weaponByte);
  setHeldWeapon(inst.root, rp.heldWeapon);
  rp.anim = {
    mixer: inst.mixer,
    actions: inst.actions,
    base: "",
    shootUntil: 0,
    jumpUntil: 0,
    hitUntil: 0,
    animSpeed: 0,
    sprintAnim: false,
  };
  playClip(rp.anim, "Idle", 0);
}

// The snapshot says this remote now holds a different weapon (swap, or a new
// class after a respawn): flip the visible weapon node on their rig.
function applyRemoteWeapon(rp: RemotePlayer): void {
  if (!rp.anim) return; // attach picks the byte up when the model lands
  const active = weaponByteActive(rp.weaponByte);
  if (active !== rp.heldWeapon) {
    rp.heldWeapon = active;
    const root = rp.group.getObjectByName("externalCharacter");
    if (root) setHeldWeapon(root, active);
  }
}

// Weapon-swap draw animation: the outgoing gun dips down off the viewport
// (like the reload dip, but all the way out), the models trade at the bottom,
// and the incoming gun rises back up. Paced to the shared draw delay.
let swapDip = 0; // 0 = gun up; 1 = fully lowered off-screen

function attachViewWeapon(want: number): void {
  const tpl = viewWeaponTemplates[want];
  if (!tpl) return; // template not loaded yet; retry next frame
  const old = viewModel.getObjectByName("externalWeapon");
  if (old) viewModel.remove(old);
  const fallback = viewModel.userData.fallbackRoot as THREE.Object3D | undefined;
  if (fallback) fallback.visible = false;
  const model = cloneExternalModel(tpl, 0, false);
  model.name = "externalWeapon";
  model.position.set(0, -0.02, -0.12);
  model.rotation.y = EXTERNAL_VIEW_WEAPON_YAW;
  viewModel.add(model);
  viewModel.userData.weaponIdx = want;
  viewModel.userData.externalAttached = true;
}

// Keep the first-person weapon in sync with the predicted state: the class
// primary or the sidearm, holstered/drawn through the swap animation.
function updateViewWeapon(dt: number): void {
  const want = predState
    ? predState.slot === 1
      ? secondaryIdxFor(predState.primary)
      : predState.primary
    : WEAPON_IDX.rifle;
  const current = viewModel.userData.weaponIdx as number | undefined;
  if (current === undefined) {
    attachViewWeapon(want); // first load: no draw animation
    return;
  }
  if (current !== want) {
    swapDip = Math.min(1, swapDip + dt * 8); // holster: sink off-screen
    if (swapDip >= 0.97) attachViewWeapon(want); // trade models at the bottom
  } else {
    swapDip = Math.max(0, swapDip - dt * 6.5); // draw: rise back up
  }
}

loadExternalVisualAssets();

// ---------------------------------------------------------------------------
// Soldiers (blocky humanoids).

// Soldier palette: olive fatigues under a team-colored vest and helmet.
const SOLDIER = {
  skin: 0xd9b38c,
  fatigue: 0x5a5f4e,
  pants: 0x3e4239,
  boot: 0x2c2c28,
  visor: 0x20242a,
  gun: 0x23262b,
};

function part(w: number, h: number, d: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshLambertMaterial({
      color,
    }),
  );
  m.castShadow = true;
  return m;
}

function makeSoldier(team: number, name: string): THREE.Group {
  const g = new THREE.Group();
  const bodyRoot = new THREE.Group();
  const color = TEAM_COLORS[team];

  // Legs pivot at the hip so they can swing while walking.
  const mkLeg = (side: number): THREE.Group => {
    const hip = new THREE.Group();
    hip.position.set(0.13 * side, 0.84, 0);
    const leg = part(0.18, 0.7, 0.24, SOLDIER.pants);
    leg.position.y = -0.38;
    const boot = part(0.2, 0.13, 0.32, SOLDIER.boot);
    boot.position.set(0, -0.77, 0.04);
    hip.add(leg, boot);
    return hip;
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);

  const torso = part(0.52, 0.6, 0.32, SOLDIER.fatigue);
  torso.position.y = 1.0;
  const vest = part(0.56, 0.36, 0.38, color);
  vest.position.y = 1.04;

  const mkArm = (side: number): THREE.Group => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.34 * side, 1.26, 0);
    const arm = part(0.14, 0.52, 0.17, SOLDIER.fatigue);
    arm.position.y = -0.24;
    const hand = part(0.13, 0.12, 0.14, SOLDIER.skin);
    hand.position.y = -0.55;
    shoulder.add(arm, hand);
    return shoulder;
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);

  const headHolder = new THREE.Group();
  headHolder.name = "head";
  headHolder.position.y = 1.36;
  const head = part(0.32, 0.32, 0.32, SOLDIER.skin);
  head.position.y = 0.16;
  const visor = part(0.26, 0.08, 0.03, SOLDIER.visor);
  visor.position.set(0, 0.19, 0.17);
  const helmet = part(0.38, 0.16, 0.38, color);
  helmet.position.y = 0.36;
  const brim = part(0.4, 0.05, 0.14, color);
  brim.position.set(0, 0.27, 0.2);
  const gun = part(0.09, 0.12, 0.75, SOLDIER.gun);
  gun.position.set(0.2, -0.28, 0.35);
  headHolder.add(head, visor, helmet, brim, gun);

  bodyRoot.add(legL, legR, torso, vest, armL, armR, headHolder);
  g.add(bodyRoot);
  g.userData.limbs = { legL, legR, armL, armR };
  g.userData.walkPhase = 0;
  g.userData.visualRoot = bodyRoot;
  // Hidden by default: the GLTF model normally attaches before the soldier is
  // ever seen. Only the grace fallback reveals this blocky rig (slow/failed
  // model load) so the old procedural soldier never flashes at round start.
  bodyRoot.visible = false;

  // Name tag: hidden until refreshNameTag decides it belongs to a teammate
  // (enemies never show tags), and redrawn when the roster's real username
  // lands (the first snapshot can beat the join/welcome message).
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 56;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }),
  );
  sprite.scale.set(1.7, 0.37, 1);
  sprite.position.y = 1.95;
  sprite.visible = false;
  drawNameTag(sprite, name, TEAM_COLORS_CSS[team]);
  g.userData.nameSprite = sprite;
  g.add(sprite);

  scene.add(g);
  return g;
}

function drawNameTag(sprite: THREE.Sprite, name: string, colorCss: string): void {
  const map = (sprite.material as THREE.SpriteMaterial).map as THREE.CanvasTexture;
  const canvas = map.image as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = "bold 30px Trebuchet MS, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,.6)";
  ctx.strokeText(name, 128, 28);
  ctx.fillStyle = colorCss;
  ctx.fillText(name, 128, 28);
  map.needsUpdate = true;
}

function refreshNameTag(rp: RemotePlayer): void {
  const sprite = rp.group.userData.nameSprite as THREE.Sprite | undefined;
  if (!sprite) return;
  drawNameTag(sprite, rp.info.name, TEAM_COLORS_CSS[rp.info.team] ?? "#fff");
  sprite.visible = rp.info.team === myTeam();
}

function refreshAllNameTags(): void {
  for (const rp of remotes.values()) {
    const info = roster.get(rp.info.idx);
    if (info) rp.info = info;
    refreshNameTag(rp);
  }
}

// ---------------------------------------------------------------------------
// Falling chunks: a released cluster is ONE rigid body on the server; its
// pose streams inside snapshots, and we render the cluster's pieces parented
// to an interpolated group — what you see is the authoritative tumble.

interface FallingChunkView {
  group: THREE.Group;
  origin: [number, number, number];
  buffer: Array<{ t: number; x: number; y: number; z: number; q: THREE.Quaternion }>;
  bornAt: number;
}

const fallingChunks = new Map<number, FallingChunkView>();

function startChunkView(
  chunkId: number,
  origin: [number, number, number],
  pieces: PanelDef[],
): void {
  const group = new THREE.Group();
  group.position.set(origin[0], origin[1], origin[2]);
  for (const p of pieces) {
    const style = PIECE_STYLE[p.material];
    const mesh = new THREE.Mesh(style.geo, (style.mat as THREE.MeshStandardMaterial).clone());
    (mesh.material as THREE.MeshStandardMaterial).color.copy(pieceColor(p, _col));
    mesh.userData.sharedGeo = true;
    const m = pieceMatrix(p);
    m.decompose(mesh.position, mesh.quaternion, mesh.scale);
    mesh.position.x -= origin[0];
    mesh.position.y -= origin[1];
    mesh.position.z -= origin[2];
    mesh.castShadow = true;
    group.add(mesh);
  }
  mapGroup.add(group);
  fallingChunks.set(chunkId, { group, origin, buffer: [], bornAt: performance.now() });
}

function endChunkView(chunkId: number): void {
  const view = fallingChunks.get(chunkId);
  if (!view) return;
  for (const child of view.group.children) {
    if (child instanceof THREE.Mesh) (child.material as THREE.Material).dispose();
  }
  view.group.parent?.remove(view.group);
  fallingChunks.delete(chunkId);
}

// Buffer poses from snapshots (same delayed-interpolation as remotes).
function noteChunkPoses(snap: Snapshot, receivedAt: number): void {
  for (const c of snap.chunks) {
    const view = fallingChunks.get(c.id);
    if (!view) continue;
    view.buffer.push({
      t: receivedAt,
      x: c.x,
      y: c.y,
      z: c.z,
      q: new THREE.Quaternion(c.qx, c.qy, c.qz, c.qw),
    });
    if (view.buffer.length > 40) view.buffer.splice(0, view.buffer.length - 40);
  }
}

const _chunkQ = new THREE.Quaternion();

function renderFallingChunks(renderT: number): void {
  const now = performance.now();
  for (const [id, view] of fallingChunks) {
    if (now - view.bornAt > 10000) {
      endChunkView(id); // settle lost — give up quietly
      continue;
    }
    const buf = view.buffer;
    if (buf.length === 0) continue;
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= renderT) {
        a = buf[i];
        b = buf[Math.min(i + 1, buf.length - 1)];
        break;
      }
    }
    const span = Math.max(1, b.t - a.t);
    const u = Math.max(0, Math.min(1, (renderT - a.t) / span));
    view.group.position.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
    _chunkQ.slerpQuaternions(a.q, b.q, u);
    view.group.quaternion.copy(_chunkQ);
  }
}

// ---------------------------------------------------------------------------
// Corpses: when a soldier dies, a clone of their character model plays the
// rig's "Death" clip where they fell, then the body lingers on the battlefield
// (capped FIFO, cleared with the map on round reset). Pure visuals — the
// authoritative sim never sees it.

interface Corpse {
  group: THREE.Group;
  mixer: THREE.AnimationMixer | null;
  until: number;
  materials: THREE.Material[]; // captured once for the fade-out
  vy: number; // fall velocity — a body that died airborne drops to the ground
  groundY: number; // surface (terrain/floor/rubble) the body settles on
}

const CORPSE_GRAVITY = 18; // m/s^2 for the corpse drop

const corpses: Corpse[] = [];
const CORPSE_CAP = 18;
const CORPSE_TTL_MS = 50_000; // bodies linger, then fade away
const CORPSE_FADE_MS = 1500;

function spawnCorpse(at: THREE.Vector3, yaw: number, team: number): void {
  const group = new THREE.Group();
  group.position.set(at.x, at.y, at.z);
  group.rotation.y = yaw;
  let mixer: THREE.AnimationMixer | null = null;
  const inst = instantiateCharacter(team);
  if (inst) {
    inst.root.rotation.y = EXTERNAL_CHARACTER_YAW;
    group.add(inst.root);
    mixer = inst.mixer;
    const death = inst.actions.get("Death");
    if (death) {
      death.setLoop(THREE.LoopOnce, 1);
      death.clampWhenFinished = true; // hold the last frame: a body on the ground
      death.reset().play();
    }
  } else {
    group.add(makeFallbackCorpse(team)); // models still loading: a slumped box
  }
  const materials: THREE.Material[] = [];
  group.traverse((o) =>
    visitMeshMaterials(o, (m) => {
      if (!materials.includes(m)) materials.push(m);
    }),
  );
  mapGroup.add(group);
  // Where the body comes to rest: ray straight down for the first surface
  // (terrain, a building floor, rubble) so a soldier killed mid-air or on a
  // ledge drops to the ground instead of hanging where they died. Never above
  // the death height (a grounded body shouldn't pop up).
  let groundY = heightAt(at.x, at.z);
  // Guard the raycast: gw can be mid-rebuild on a round reset, and a throw here
  // would otherwise propagate out of handleSnapshot. Terrain height is the safe
  // fallback.
  try {
    const below = castLocal([at.x, at.y + 0.4, at.z], [0, -1, 0], 100);
    if (below) groundY = below.point[1];
  } catch {
    /* keep terrain height */
  }
  groundY = Math.min(groundY, at.y);
  corpses.push({
    group,
    mixer,
    until: performance.now() + CORPSE_TTL_MS,
    materials,
    vy: 0,
    groundY,
  });
  if (corpses.length > CORPSE_CAP) {
    const old = corpses.shift()!;
    old.mixer?.stopAllAction();
    old.group.parent?.remove(old.group);
  }
}

function makeFallbackCorpse(team: number): THREE.Group {
  const g = new THREE.Group();
  const torso = part(0.5, 0.3, 0.55, TEAM_COLORS[team]);
  torso.position.y = 0.18;
  const head = part(0.3, 0.3, 0.3, SOLDIER.skin);
  head.position.set(0, 0.2, 0.42);
  g.add(torso, head);
  return g;
}

function stepCorpses(dt: number): void {
  const now = performance.now();
  while (corpses.length > 0 && now > corpses[0].until) {
    const old = corpses.shift()!;
    old.mixer?.stopAllAction();
    old.group.parent?.remove(old.group);
  }
  for (const c of corpses) {
    c.mixer?.update(dt); // advance the Death clip (clamps on its last frame)
    if (c.group.position.y > c.groundY) {
      c.vy -= CORPSE_GRAVITY * dt;
      c.group.position.y += c.vy * dt;
      if (c.group.position.y <= c.groundY) {
        c.group.position.y = c.groundY;
        c.vy = 0;
      }
    }
    const remaining = c.until - now;
    if (remaining < CORPSE_FADE_MS) {
      const k = Math.max(0, remaining / CORPSE_FADE_MS);
      for (const m of c.materials) {
        m.transparent = true;
        m.opacity = k;
      }
    }
  }
}

// Flash a soldier red for a beat — damage must read on the target, not just
// the crosshair.
function flashRemote(idx: number): void {
  const rp = remotes.get(idx);
  if (!rp) return;
  rp.group.traverse((o) => {
    visitMeshMaterials(o, (material) => setEmissive(material, 0xa01010));
  });
  setTimeout(() => {
    rp.group.traverse((o) => {
      visitMeshMaterials(o, (material) => setEmissive(material, 0x000000));
    });
  }, 130);
}

function dropRemote(idx: number): void {
  const rp = remotes.get(idx);
  if (rp) scene.remove(rp.group);
  remotes.delete(idx);
  if (gw) {
    const body = ghostBodies.get(idx);
    if (body) {
      gw.world.removeBody(body);
      gw.players.delete(1000 + idx);
      ghostBodies.delete(idx);
    }
  }
}

// ---------------------------------------------------------------------------
// View model (first-person rifle) + build preview.

const viewModel = new THREE.Group();
{
  const fallbackRoot = new THREE.Group();
  const dark = new THREE.MeshLambertMaterial({ color: 0x23262b });
  const wood = new THREE.MeshLambertMaterial({ color: 0x4d4338 });
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.55), dark);
  barrel.position.set(0, 0.01, -0.34);
  const bodyM = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.3), wood);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.07), wood);
  grip.position.set(0, -0.11, 0.08);
  fallbackRoot.add(barrel, bodyM, grip);
  viewModel.add(fallbackRoot);
  viewModel.userData.fallbackRoot = fallbackRoot;
  // Hidden by default so the blocky placeholder gun never flashes while
  // connecting; the AK model attaches over it, and the grace fallback below
  // only reveals it if the model is slow/fails to load.
  fallbackRoot.visible = false;
  viewModel.position.set(0.2, -0.3, -0.34);
  camera.add(viewModel);
}
scene.add(camera);
const VIEW_WEAPON_BORN = performance.now();

// Barrel tip of the AK in view-model space (used as the tracer origin). The AK
// muzzle sits at the model's -X end which the view-weapon yaw turns onto -Z.
const MUZZLE_LOCAL = new THREE.Vector3(0, 0.12, -0.74);
let recoil = 0;
let meleeSwing = 0;
let viewBobPhase = 0; // accumulates while moving; drives the weapon bob
let sprintBlend = 0; // 0..1 eased sprint amount for the view-model sway
let flinch = 0; // 0..1 decaying camera jolt when hit
let flinchPitch = 0;
let flinchYaw = 0;

function kickFlinch(): void {
  flinch = 1;
  flinchPitch = 0.6 + Math.random() * 0.5; // jolt the view up
  flinchYaw = (Math.random() - 0.5) * 1.2; // and off to one side
}

const buildPreview = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshLambertMaterial({ color: 0x7d8a96, transparent: true, opacity: 0.4 }),
);
buildPreview.visible = false;
scene.add(buildPreview);

// ---------------------------------------------------------------------------
// Effects: tracers, explosions, debris, sparks.

interface Effect {
  obj: THREE.Object3D;
  until: number;
  vel?: THREE.Vector3;
  spin?: THREE.Vector3;
}
const effects: Effect[] = [];

function addEffect(
  obj: THREE.Object3D,
  lifeMs: number,
  vel?: THREE.Vector3,
  spin?: THREE.Vector3,
): void {
  scene.add(obj);
  effects.push({ obj, until: performance.now() + lifeMs, vel, spin });
}

const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });

// Effects reuse shared unit geometries (scaled per instance) and cached
// materials — spawning a tracer or spark allocates a Mesh wrapper, never new
// GPU buffers. Meshes flag sharedGeo/sharedMat so stepEffects skips dispose.
const FX_GEO = {
  sphere: new THREE.SphereGeometry(1, 12, 8),
  puff: new THREE.SphereGeometry(1, 6, 4),
};
const sparkMats = new Map<number, THREE.MeshBasicMaterial>();
const grenadeMat = new THREE.MeshLambertMaterial({ color: 0x2f5e2f });

function sparkMat(color: number): THREE.MeshBasicMaterial {
  let m = sparkMats.get(color);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color });
    sparkMats.set(color, m);
  }
  return m;
}

function spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
  const dir = to.clone().sub(from);
  const len = dir.length();
  if (len < 0.5) return;
  const mesh = new THREE.Mesh(GEO.box, tracerMat);
  mesh.scale.set(0.025, 0.025, len);
  mesh.userData.sharedGeo = true;
  mesh.position.copy(from).add(dir.multiplyScalar(0.5));
  mesh.lookAt(to);
  addEffect(mesh, 70);
}

function spawnExplosion(at: THREE.Vector3): void {
  const ball = new THREE.Mesh(
    FX_GEO.sphere,
    new THREE.MeshBasicMaterial({ color: 0xffb03a, transparent: true, opacity: 0.9 }),
  );
  ball.scale.setScalar(0.6);
  ball.userData.sharedGeo = true;
  ball.position.copy(at);
  ball.userData.grow = true;
  addEffect(ball, 240);
  spawnDebris(at, 10);
  sounds.explosionAt(at);
  if (predState) {
    const d = at.distanceTo(new THREE.Vector3(predState.x, predState.y + 1, predState.z));
    if (d < 12) shake = Math.min(1, shake + (1 - d / 12));
  }
}

const debrisMats = new Map<number, THREE.MeshLambertMaterial>();

function debrisMat(color: number): THREE.MeshLambertMaterial {
  let m = debrisMats.get(color);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    debrisMats.set(color, m);
  }
  return m;
}

function spawnDebris(at: THREE.Vector3, count: number, color = 0xa59c8e): void {
  for (let i = 0; i < count; i++) {
    const s = 0.1 + Math.random() * 0.2;
    const mesh = new THREE.Mesh(
      FRACTURE_GEOS[(Math.random() * FRACTURE_GEOS.length) | 0],
      debrisMat(color),
    );
    mesh.scale.set(s * 1.3, s * 0.6, s * 0.9); // shard, not cube
    mesh.rotation.y = Math.random() * Math.PI;
    mesh.userData.sharedMat = true;
    mesh.userData.sharedGeo = true;
    mesh.position.set(
      at.x + (Math.random() - 0.5) * 0.8,
      at.y + (Math.random() - 0.5) * 0.8,
      at.z + (Math.random() - 0.5) * 0.8,
    );
    mesh.castShadow = true;
    addEffect(
      mesh,
      900 + Math.random() * 600,
      new THREE.Vector3(
        (Math.random() - 0.5) * 5,
        2 + Math.random() * 4,
        (Math.random() - 0.5) * 5,
      ),
      new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8),
    );
  }
}

function spawnSpark(at: THREE.Vector3, color = 0xffd27a): void {
  const mesh = new THREE.Mesh(FX_GEO.puff, sparkMat(color));
  mesh.scale.setScalar(0.07);
  mesh.userData.sharedGeo = true;
  mesh.userData.sharedMat = true;
  mesh.position.copy(at);
  addEffect(mesh, 120);
}

let shake = 0;
// Sniper scope zoom state (eased 0..1) and magnification.
let scopeBlend = 0;
const SCOPE_ZOOM = 4.5;

function stepEffects(dt: number): void {
  const now = performance.now();
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i];
    if (now > e.until) {
      scene.remove(e.obj);
      if (e.obj instanceof THREE.Mesh) {
        if (!e.obj.userData.sharedGeo) e.obj.geometry.dispose();
        if (!e.obj.userData.sharedMat && e.obj.material !== tracerMat) {
          (e.obj.material as THREE.Material).dispose();
        }
      }
      effects.splice(i, 1);
      continue;
    }
    if (e.vel) {
      e.vel.y -= 12 * dt;
      e.obj.position.addScaledVector(e.vel, dt);
      const ground = heightAt(e.obj.position.x, e.obj.position.z) + 0.05;
      if (e.obj.position.y < ground) {
        e.obj.position.y = ground;
        e.vel.y *= -0.3;
        e.vel.x *= 0.7;
        e.vel.z *= 0.7;
      }
    }
    if (e.spin) {
      e.obj.rotation.x += e.spin.x * dt;
      e.obj.rotation.y += e.spin.y * dt;
    }
    if (e.obj.userData.grow) {
      const m = e.obj as THREE.Mesh;
      m.scale.multiplyScalar(1 + dt * 9);
      (m.material as THREE.MeshBasicMaterial).opacity *= 1 - dt * 5;
    }
  }
}

// --- Transient event processing (from the snapshot ring). ---

let myHits = 0;
let dbgMyTracers = 0;
let dbgHitEvents = 0;
let dbgEvents = 0;

function processEvents(list: GameEvent[]): void {
  for (const e of list) {
    const delta = (e.seq - lastEventSeq + 0x10000) % 0x10000;
    if (delta === 0 || delta > 0x8000) continue; // old or duplicate
    lastEventSeq = e.seq;
    dbgEvents++;
    const at = new THREE.Vector3(e.x, e.y, e.z);
    switch (e.kind) {
      case EV_TRACER: {
        if (e.a !== selfIdx) {
          const from = muzzleOf(e.a);
          if (from) {
            const shooterRp = remotes.get(e.a);
            const shooterWeapon = shooterRp ? weaponByteActive(shooterRp.weaponByte) : 0;
            spawnTracer(from, at);
            sounds.shotAt(from, WEAPON_LIST[shooterWeapon]?.name);
            if (shooterRp?.anim) shooterRp.anim.shootUntil = performance.now() + 280;
            // Shotgun blasts arrive as several tracer events — pump once per
            // blast, racking the next shell just after the boom.
            if (shooterRp && shooterWeapon === WEAPON_IDX.shotgun) {
              const nowMs = performance.now();
              if (nowMs - shooterRp.lastPumpMs > 300) {
                shooterRp.lastPumpMs = nowMs;
                const pumpPos = from.clone();
                setTimeout(() => sounds.pumpAt(pumpPos), 230);
              }
            }
            // Decal where the remote shot landed (skip max-range whiffs):
            // re-cast locally to learn what surface the endpoint sits on.
            const d = at.clone().sub(from);
            const len = d.length();
            if (len > 0.5 && len < 89) {
              d.divideScalar(len);
              const hit = castLocal([from.x, from.y, from.z], [d.x, d.y, d.z], len + 0.4);
              const tag = (hit?.body.userData ?? {}) as { playerIdx?: number };
              if (
                hit &&
                tag.playerIdx === undefined &&
                at.distanceToSquared(new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2])) <
                  0.36
              ) {
                const pieceId = hitPieceId(hit.body, hit.point) ?? undefined;
                spawnBulletDecal(at, surfaceNormalAt(hit.body, at), pieceId);
              }
            }
          }
        } else {
          dbgMyTracers++;
        }
        break;
      }
      case EV_HIT_PLAYER: {
        dbgHitEvents++;
        const victim = e.a & 0xf;
        const shooter = (e.a >> 4) & 0xf;
        spawnSpark(at, 0xff4a3a);
        flashRemote(victim); // the victim visibly flinches red
        const vrp = remotes.get(victim);
        if (vrp?.anim) vrp.anim.hitUntil = performance.now() + 320; // HitReact flinch
        if (victim === selfIdx) {
          el.vignette.style.opacity = "1";
          setTimeout(() => (el.vignette.style.opacity = "0"), 180);
          sounds.hurt();
          kickFlinch(); // jolt the view when you take a round
        } else {
          sounds.hurtAt(at);
        }
        if (shooter === selfIdx && victim !== selfIdx) {
          // Our hit, attributed directly by the server — no heuristics.
          myHits++;
          el.hitmark.style.opacity = "1";
          el.hitmark.style.transform = "translate(-50%,-50%) rotate(45deg) scale(1.6)";
          setTimeout(() => {
            el.hitmark.style.opacity = "0";
            el.hitmark.style.transform = "translate(-50%,-50%) rotate(45deg) scale(1)";
          }, 240);
          // Mirror the server's head check off the impact height for the cue.
          const headshot = vrp ? at.y - vrp.group.position.y >= HEADSHOT_HEIGHT : false;
          if (headshot) sounds.headshot();
          else sounds.bulletHit();
        }
        break;
      }
      case EV_EXPLOSION:
        spawnExplosion(at);
        break;
      case EV_PANEL_HIT:
        spawnSpark(at);
        sounds.hurtAt(at);
        break;
      case EV_MELEE:
        spawnSpark(at, 0xcccccc);
        sounds.meleeAt(at);
        break;
    }
  }
}

// Distance at which the view-model barrel converges with the crosshair.
const VIEWMODEL_CONVERGE_Z = -24;
const _muzzle = new THREE.Vector3();

// World-space barrel tip of the first-person rifle — tracers leave the gun,
// not the middle of the screen.
function muzzleWorld(): THREE.Vector3 {
  _muzzle.set(MUZZLE_LOCAL.x, MUZZLE_LOCAL.y, MUZZLE_LOCAL.z);
  viewModel.updateWorldMatrix(true, false);
  return viewModel.localToWorld(_muzzle);
}

// World-space gun muzzle of a remote soldier's rifle (falls back to the eye
// if the rig isn't available).
function muzzleOf(idx: number): THREE.Vector3 | null {
  const rp = remotes.get(idx);
  if (rp && rp.group.visible) {
    const head = rp.group.getObjectByName("head");
    if (head) {
      head.updateWorldMatrix(true, false);
      return head.localToWorld(new THREE.Vector3(0.2, -0.28, 0.73));
    }
  }
  return eyeOf(idx);
}

function eyeOf(idx: number): THREE.Vector3 | null {
  if (idx === selfIdx) {
    return predState ? new THREE.Vector3(predState.x, predState.y + EYE_HEIGHT, predState.z) : null;
  }
  const rp = remotes.get(idx);
  if (!rp || rp.buffer.length === 0) return null;
  const last = rp.buffer[rp.buffer.length - 1];
  return new THREE.Vector3(last.x, last.y + EYE_HEIGHT, last.z);
}

// --- Grenade views (Kenney frag model; sphere fallback until it loads).

const GRENADE_MODEL_URL = "/assets/vendor/kenney/grenade.glb";
let grenadeTemplate: THREE.Group | null = null;
const grenadeViews = new Map<number, THREE.Object3D>();

void loadModel(GRENADE_MODEL_URL)
  .then(({ scene }) => {
    // Size to the physics grenade and recentre on its bbox so it tumbles about
    // its middle (the model's pivot is at its base).
    scene.updateWorldMatrix(true, true);
    const size = new THREE.Box3().setFromObject(scene).getSize(new THREE.Vector3());
    scene.scale.multiplyScalar(0.3 / (Math.max(size.x, size.y, size.z) || 1));
    scene.updateWorldMatrix(true, true);
    scene.position.sub(new THREE.Box3().setFromObject(scene).getCenter(new THREE.Vector3()));
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    grenadeTemplate = scene;
  })
  .catch(() => {});

function makeGrenadeView(): THREE.Object3D {
  if (grenadeTemplate) return grenadeTemplate.clone();
  const mesh = new THREE.Mesh(FX_GEO.sphere, grenadeMat);
  mesh.scale.setScalar(0.14);
  mesh.castShadow = true;
  return mesh;
}

function updateGrenadeViews(snap: Snapshot): void {
  const seen = new Set<number>();
  for (const e of snap.entities) {
    seen.add(e.id);
    if (!grenadeViews.has(e.id)) {
      const view = makeGrenadeView();
      scene.add(view);
      grenadeViews.set(e.id, view);
    }
  }
  for (const [id, mesh] of grenadeViews) {
    if (!seen.has(id)) {
      scene.remove(mesh);
      grenadeViews.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// Frame loop.

function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = (now - lastFrameAt) / 1000;
  lastFrameAt = now;
  if (dt > 0.25) dt = 0.25;

  errOffset.multiplyScalar(Math.exp(-dt * 12));
  recoil *= Math.exp(-dt * 10);
  shake *= Math.exp(-dt * 5);
  flinch *= Math.exp(-dt * 9);
  if (meleeSwing > 0) meleeSwing = Math.max(0, meleeSwing - dt * 4);
  stepClouds(dt);
  stepCorpses(dt);
  stepFlags(now);
  (waterMat.uniforms.uTime as { value: number }).value = now / 1000;

  // Camera at the predicted eye, interpolated between the last two ticks so
  // 30 Hz simulation renders smoothly at any frame rate.
  if (predState) {
    const dead = (selfStatus & SS_DEAD) !== 0;
    const alpha = lastTickAt > 0 ? Math.min(1, (now - lastTickAt) / TICK_MS) : 1;
    const ix = prevEyeX + (predState.x - prevEyeX) * alpha;
    const iy = prevEyeY + (predState.y - prevEyeY) * alpha;
    const iz = prevEyeZ + (predState.z - prevEyeZ) * alpha;
    camera.position.set(
      ix + errOffset.x + (Math.random() - 0.5) * shake * 0.12,
      iy + errOffset.y + (dead ? 0.4 : EYE_HEIGHT) + (Math.random() - 0.5) * shake * 0.1,
      iz + errOffset.z,
    );
    camera.rotation.order = "YXZ";
    camera.rotation.y = yaw + Math.PI + flinch * flinchYaw * 0.05;
    camera.rotation.x = pitch + recoil * 0.045 + flinch * flinchPitch * 0.06;
    camera.rotation.z = 0;
    updateAudioListener();
  }

  // Out of bounds: no walls, so leaving the play area shows a warning + a
  // return countdown and desaturates the view; the server enforces the kill.
  // The enemy's home bowl counts too (no spawn camping).
  {
    const dead = (selfStatus & SS_DEAD) !== 0;
    const team = roster.get(selfIdx)?.team ?? -1;
    const oob =
      !dead &&
      predState != null &&
      (Math.abs(predState.x) > PLAY_HALF ||
        Math.abs(predState.z) > PLAY_HALF ||
        (team >= 0 && inEnemyBase(team, predState.x, predState.z)));
    if (oob) {
      if (oobStartMs < 0) oobStartMs = now;
      const left = Math.max(0, OOB_LIMIT_SECONDS - (now - oobStartMs) / 1000);
      (el.oob as HTMLElement).style.display = "flex";
      el.oobtimer.textContent = Math.ceil(left).toString();
      const k = 1 - left / OOB_LIMIT_SECONDS; // ramps 0->1 as the timer runs out
      renderer.domElement.style.filter = `grayscale(${(0.35 + 0.65 * k).toFixed(2)}) contrast(${(1 + 0.25 * k).toFixed(2)}) brightness(${(1 - 0.15 * k).toFixed(2)})`;
    } else if (oobStartMs >= 0) {
      oobStartMs = -1;
      (el.oob as HTMLElement).style.display = "none";
      renderer.domElement.style.filter = "";
    }
  }

  // Sniper scope (RMB with the sniper out): ease camera.zoom toward the scope
  // magnification (zoom + updateProjectionMatrix is the three.js way to zoom
  // without touching the base fov), fade in the scope mask, and hide the
  // rifle. Purely a client-side view — ballistics are unchanged.
  {
    const canScope =
      pointerLocked &&
      (selfStatus & SS_DEAD) === 0 &&
      predState !== null &&
      predState.slot === 0 &&
      predState.primary === WEAPON_IDX.sniper &&
      predState.reloadTicks === 0; // reloading forces you out of the scope
    if (!canScope) scopeActive = false; // swap/death/unlock/reload unscopes
    const scoped = scopeActive;
    scopeBlend += ((scoped ? 1 : 0) - scopeBlend) * Math.min(1, dt * 14);
    if (scopeBlend < 0.005) scopeBlend = 0;
    const zoomTarget = 1 + (SCOPE_ZOOM - 1) * scopeBlend;
    if (Math.abs(camera.zoom - zoomTarget) > 1e-3) {
      camera.zoom = zoomTarget;
      camera.updateProjectionMatrix();
    }
    const maskOn = scopeBlend > 0.6;
    (el.scope as HTMLElement).style.display = maskOn ? "block" : "none";
    el.cross.style.visibility = maskOn ? "hidden" : "visible";
  }

  // First-person weapon feel: a rest pose plus recoil, melee, a walk/sprint
  // bob, a reload dip, the swap holster/draw, and a distinct sprint sway.
  updateViewWeapon(dt);
  const grounded = !!predState?.onGround && (selfStatus & SS_DEAD) === 0;
  const localSpeed = predState ? Math.hypot(predState.vx, predState.vz) : 0;
  const movingNow = grounded && localSpeed > ANIM_MOVE_SPEED;
  const sprintingNow = grounded && localSpeed > ANIM_SPRINT_SPEED;
  sprintBlend += ((sprintingNow ? 1 : 0) - sprintBlend) * Math.min(1, dt * 9);
  viewBobPhase += movingNow ? dt * (sprintingNow ? 13 : 8.5) : 0;
  const bobAmt = movingNow ? Math.min(1, localSpeed / 5.2) : 0;
  const bobX = Math.sin(viewBobPhase) * 0.013 * bobAmt;
  const bobY = -Math.abs(Math.cos(viewBobPhase)) * 0.015 * bobAmt;
  const reloadProg =
    predState && predState.reloadTicks > 0
      ? predState.reloadTicks / activeWeapon(predState).reloadTicks
      : 0;
  const dip = reloadProg > 0 ? Math.sin((1 - reloadProg) * Math.PI) : 0; // 0→1→0 over reload
  const sway = sprintBlend;
  viewModel.position.set(
    0.2 + bobX + sway * 0.05,
    -0.3 - meleeSwing * 0.12 + bobY - dip * 0.14 - sway * 0.07 - swapDip * 0.55,
    -0.34 + recoil * 0.06 + meleeSwing * -0.25 - dip * 0.05 + sway * 0.06,
  );
  // Converge the barrel on the crosshair: aim at a point down the view ray
  // (camera space) so the gun points where bullets land, instead of sitting
  // parallel to the view axis. Recoil/melee/reload/sprint layer on top.
  {
    const dx = -viewModel.position.x;
    const dy = -viewModel.position.y - 0.01;
    const dz = VIEWMODEL_CONVERGE_Z - viewModel.position.z;
    viewModel.rotation.order = "YXZ";
    viewModel.rotation.y = Math.atan2(-dx, -dz) + sway * 0.5 + bobX * 0.6;
    viewModel.rotation.x =
      Math.atan2(dy, Math.hypot(dx, dz)) +
      recoil * 0.25 +
      meleeSwing * 0.9 -
      dip * 0.55 - // reload: drop the muzzle
      swapDip * 1.2 - // holster/draw: swing the gun down out of view
      sway * 0.3; // sprint: lower the muzzle, not raise it
    viewModel.rotation.z = sway * 0.35;
  }
  viewModel.visible = (selfStatus & SS_DEAD) === 0 && scopeBlend < 0.5;
  // Grace fallback: only show the blocky placeholder gun if the AK model never
  // arrived after a few seconds (so it doesn't flash during connect).
  if (viewModel.userData.externalAttached !== true && now - VIEW_WEAPON_BORN > 3000) {
    const fb = viewModel.userData.fallbackRoot as THREE.Object3D | undefined;
    if (fb) fb.visible = true;
  }

  // Build preview while holding Q-able state (always shown when alive + supply).
  if (predState && (selfStatus & SS_DEAD) === 0 && keys.has("KeyQ") && predState.supply > 0) {
    const placement = buildPlacement(predState, yaw);
    buildPreview.scale.set(placement.ex, placement.ey, placement.ez);
    buildPreview.position.set(placement.x, placement.y, placement.z);
    buildPreview.visible = true;
  } else {
    buildPreview.visible = false;
  }

  // Ease the interpolation delay toward its jitter-derived target (fast to
  // grow when the network degrades, slow to shrink so it doesn't oscillate).
  const interpTarget = targetInterpDelayMs();
  if (interpTarget > interpDelayMs) {
    interpDelayMs = Math.min(interpTarget, interpDelayMs + dt * 200);
  } else {
    interpDelayMs = Math.max(interpTarget, interpDelayMs - dt * 15);
  }

  // Remotes (interpolated in the past).
  const renderT = now - interpDelayMs;
  renderFallingChunks(renderT);
  for (const rp of remotes.values()) {
    // Upgrade to the GLTF model the instant the templates finish loading; only
    // reveal the blocky fallback if the model is still missing after a grace
    // (slow/failed load) — so the old procedural soldier never flashes at start.
    if (!rp.anim) {
      attachExternalSoldier(rp);
      const fallback = rp.group.userData.visualRoot as THREE.Object3D | undefined;
      if (fallback && !rp.anim && now - rp.createdAt > 3000) fallback.visible = true;
    }
    if (rp.buffer.length === 0) continue;
    const buf = rp.buffer;
    let a = buf[0];
    let b = buf[buf.length - 1];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= renderT) {
        a = buf[i];
        b = buf[Math.min(i + 1, buf.length - 1)];
        break;
      }
    }
    const span2 = Math.max(1, b.t - a.t);
    const u = Math.max(0, Math.min(1, (renderT - a.t) / span2));
    rp.group.position.set(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
    const dyaw = shortestArc(a.yaw, b.yaw);
    rp.group.rotation.y = a.yaw + dyaw * u;
    const speed = (Math.hypot(b.x - a.x, b.z - a.z) / span2) * 1000;
    const vy = ((b.y - a.y) / span2) * 1000;
    const dead = (rp.lastFlags & RF_DEAD) !== 0;
    rp.group.visible = !dead;
    if (!dead) {
      if (rp.anim) {
        // Real Quaternius rig: a clip state machine drives the whole body.
        updateCharacterAnim(rp, speed, vy, now, dt);
        rp.anim.mixer.update(dt);
      } else {
        // Blocky fallback rig: procedural walk cycle until the model loads.
        const head = rp.group.getObjectByName("head");
        if (head) head.rotation.x = -(a.pitch + (b.pitch - a.pitch) * u);
        const limbs = rp.group.userData.limbs as {
          legL: THREE.Group;
          legR: THREE.Group;
          armL: THREE.Group;
          armR: THREE.Group;
        };
        const stride = Math.min(1, speed / 5);
        rp.group.userData.walkPhase = (rp.group.userData.walkPhase as number) + speed * dt * 2.6;
        const swing = Math.sin(rp.group.userData.walkPhase as number) * 0.62 * stride;
        limbs.legL.rotation.x = swing;
        limbs.legR.rotation.x = -swing;
        limbs.armL.rotation.x = -swing * 0.7;
        limbs.armR.rotation.x = swing * 0.7;
        const stepIndex = Math.floor((rp.group.userData.walkPhase as number) / Math.PI);
        if (stride > 0.15 && stepIndex !== rp.lastStepIndex) {
          rp.lastStepIndex = stepIndex;
          sounds.footstepAt(rp.group.position.x, rp.group.position.y, rp.group.position.z, 0.18);
        } else if (stride <= 0.15) {
          rp.lastStepIndex = -1;
        }
      }
    }
    // Spawn-protection ghosting: only touch materials when the state flips,
    // not every frame for every soldier.
    const prot = (rp.lastFlags & RF_PROTECTED) !== 0;
    if (prot !== rp.lastProt) {
      rp.lastProt = prot;
      rp.group.traverse((o) => {
        visitMeshMaterials(o, (material) => {
          material.transparent = prot;
          material.opacity = prot ? 0.55 : 1;
        });
      });
    }
  }

  // Grenades render from the mirror world bodies; a local minimum in height
  // (it was falling, now rising) is a bounce — clink it, scaled by drop speed.
  if (gw) {
    for (const [id, mesh] of grenadeViews) {
      const body = gw.grenades.get(id);
      if (body) {
        const pos = body.translation();
        const rot = body.rotation();
        const ud = mesh.userData;
        const prevY = ud.prevY as number | undefined;
        if (prevY !== undefined) {
          const vy = pos.y - prevY;
          if (vy < -0.015) {
            ud.falling = true;
            ud.fallSpeed = Math.max((ud.fallSpeed as number) ?? 0, -vy);
          } else if (ud.falling === true && vy > 0.008) {
            ud.falling = false;
            const speed = (ud.fallSpeed as number) ?? 0;
            ud.fallSpeed = 0;
            if (speed > 0.03)
              sounds.grenadeBounceAt(new THREE.Vector3(pos.x, pos.y, pos.z), speed * 6);
          }
        }
        ud.prevY = pos.y;
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      }
    }
  }

  updateCrosshairTarget();
  stepEffects(dt);
  updateHud();
  const tr0 = performance.now();
  renderer.render(scene, camera);
  const tEnd = performance.now();
  perf.renderMs += tEnd - tr0;
  perf.frames++;
  const frameTotal = tEnd - now;
  perf.frameMs += frameTotal;
  if (frameTotal > perf.worstFrameMs) perf.worstFrameMs = frameTotal;
  rollPerfWindow(tEnd);
}

function shortestArc(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Friend-or-foe under the crosshair: green crosshair + name for teammates,
// red for enemies, so shooting a teammate never reads as broken hit detection.
let crossTargetIdx = -1;
const CROSS_FRIENDLY = "#3ddc78";
const CROSS_ENEMY = "#ff5a4a";

function updateCrosshairTarget(): void {
  if (!predState || !gw || !selfBody) return;
  const dir = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const eye = [predState.x, predState.y + EYE_HEIGHT, predState.z];
  const hit = castLocal(eye, dir, 60);
  const tag = (hit?.body.userData ?? {}) as { playerIdx?: number };
  const idx = tag.playerIdx !== undefined && tag.playerIdx >= 1000 ? tag.playerIdx - 1000 : -1;
  if (idx === crossTargetIdx) return;
  crossTargetIdx = idx;
  const info = idx >= 0 ? roster.get(idx) : undefined;
  if (info) {
    const friendly = info.team === myTeam();
    const color = friendly ? CROSS_FRIENDLY : CROSS_ENEMY;
    el.cross.style.color = color;
    el.crossname.style.color = color;
    el.crossname.textContent = `${info.name}${friendly ? " (friendly)" : ""}`;
    el.crossname.style.opacity = "1";
  } else {
    el.cross.style.color = "#fff";
    el.crossname.style.opacity = "0";
  }
}

// --- HUD updates.

function updateHud(): void {
  for (let i = 0; i < zonePips.length && i < zoneState.length; i++) {
    const zn = zoneState[i];
    const c = zn.owner === 0 ? "#e8743a" : zn.owner === 1 ? "#3a7be8" : "#cfd4da";
    zonePips[i].style.color = zn.owner >= 0 ? "#fff" : "#cfd4da";
    zonePips[i].style.boxShadow = zn.owner >= 0 ? `0 0 0 2px ${c} inset` : "none";
    const towards = zn.v < 0 ? "#e8743a" : "#3a7be8";
    zoneFills[i].style.height = `${Math.abs(zn.v)}%`;
    zoneFills[i].style.background = towards;
    zoneFills[i].style.opacity = "0.55";
  }
  el.scores.innerHTML = `<span style="color:${TEAM_COLORS_CSS[0]}">${scores[0]}</span> · <span style="color:${TEAM_COLORS_CSS[1]}">${scores[1]}</span>`;
  const ticksLeft = Math.max(0, phaseEndTick - estServerTick());
  const secs = Math.ceil(ticksLeft / TICK_RATE);
  el.timer.textContent =
    phase === "playing" ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "";

  (el.hpfill as HTMLElement).style.width = `${Math.max(0, (selfHp / MAX_HP) * 100)}%`;
  (el.hpfill as HTMLElement).style.background =
    selfHp > 50 ? "#5ad05a" : selfHp > 25 ? "#d0b54a" : "#d05a4a";
  if (predState) {
    const w = activeWeapon(predState);
    const ammo = predState.slot === 1 ? predState.ammo2 : predState.ammo;
    const scopeHint = w.name === "Sniper" ? " · RMB scope" : "";
    el.wpnname.textContent = `${w.name.toUpperCase()} · 1/2 swap${scopeHint}`;
    el.ammotext.textContent = predState.reloadTicks > 0 ? "…" : `${ammo}`;
    el.gear.textContent = `🧨 ${predState.grenades}  🧱 ${predState.supply}`;
  }

  const dead = (selfStatus & SS_DEAD) !== 0;
  updateRespawnOverlay(dead, performance.now());
  if (introVisible || (dead && phase === "playing")) {
    // The intro/deploy screen or the respawn overlay owns the viewport; the
    // state overlay would just bleed through behind it.
    el.overlay.style.display = "none";
  } else if (phase === "results") {
    const winner =
      scores[0] === scores[1] ? "Draw" : `${TEAM_NAMES[scores[0] > scores[1] ? 0 : 1]} wins`;
    el.overlaypanel.innerHTML = `<h1>${winner}</h1><p>${scores[0]} — ${scores[1]}</p><p>next round starting…</p>`;
    el.overlay.style.display = "flex";
  } else if (!connected) {
    el.overlaypanel.innerHTML = `<h1>Flag Conquest</h1><p>connecting…</p>`;
    el.overlay.style.display = "flex";
  } else {
    el.overlay.style.display = "none";
  }

  if (keys.has("Tab")) {
    const rows = [...roster.values()]
      .map((p) => ({ p, s: kd.get(p.idx) ?? { k: 0, d: 0 } }))
      .sort((a, b) => b.s.k - a.s.k)
      .map(
        ({ p, s }) =>
          `<tr><td style="color:${TEAM_COLORS_CSS[p.team]}">${escapeHtml(p.name)}${p.idx === selfIdx ? " (you)" : ""}</td><td>${s.k}</td><td>${s.d}</td></tr>`,
      )
      .join("");
    el.board.innerHTML = `<table><tr><th>player</th><th>K</th><th>D</th></tr>${rows}</table>`;
    el.board.style.display = "block";
  } else {
    el.board.style.display = "none";
  }

  const rtt = client.net.rtt;
  el.netinfo.textContent = `rtt ${rtt === null ? "—" : Math.round(rtt)}ms · rollbacks ${rollbacks} · ${perf.fps.toFixed(
    0,
  )}fps · ${perf.avgFrameMs.toFixed(1)}ms`;
}

// ---------------------------------------------------------------------------
// Spawn selection: a clickable minimap (in the intro and the respawn overlay)
// that lets the player deploy at their HQ or any flag their team holds. The
// choice is a reliable stream message; the server honors it at (re)spawn time
// while the flag is still held, falling back to auto otherwise.

// HQ is pre-selected so the map always shows exactly where you'll spawn;
// picking a held flag overrides it.
let spawnChoice = SPAWN_HQ;

const CLASS_STORAGE_KEY = "breachpoint.class";

function loadStoredClass(): number {
  try {
    const raw = Number(localStorage.getItem(CLASS_STORAGE_KEY));
    return Number.isInteger(raw) && raw >= 0 && raw < CLASSES.length ? raw : 0;
  } catch {
    return 0;
  }
}

function sendSpawnChoice(): void {
  void client.streams.send({ type: "spawnat", zone: spawnChoice }).catch(() => {});
}

function selectSpawn(zone: number): void {
  spawnChoice = zone;
  sendSpawnChoice();
  refreshMinimaps();
}

// Face the fight on spawn: aim at the nearest flag the team does NOT hold
// (that's where the action is in conquest), or the map centre if they hold
// everything. Spawning with your back to the battlefield reads as a bug.
function faceTheAction(fromX: number, fromZ: number): void {
  const team = myTeam();
  let tx = 0;
  let tz = 0;
  let best = Infinity;
  for (let i = 0; i < ZONES.length && i < zoneState.length; i++) {
    if (zoneState[i].owner === team) continue;
    const d = Math.hypot(ZONES[i].x - fromX, ZONES[i].z - fromZ);
    if (d < best) {
      best = d;
      tx = ZONES[i].x;
      tz = ZONES[i].z;
    }
  }
  const dx = tx - fromX;
  const dz = tz - fromZ;
  if (Math.hypot(dx, dz) < 2) return;
  yaw = Math.atan2(dx, dz);
  pitch = 0;
}

// Terrain backdrop for the minimaps, painted once from the cached pristine
// heightfield: water, height-shaded grass, and the baked roads.
const MM_N = 216; // 1px per metre across ±PLAY_HALF
let mmBase: HTMLCanvasElement | null = null;

function minimapBase(): HTMLCanvasElement {
  if (mmBase) return mmBase;
  const canvas = document.createElement("canvas");
  canvas.width = MM_N;
  canvas.height = MM_N;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(MM_N, MM_N);
  const lo = new THREE.Color(0x4a7440);
  const hi = new THREE.Color(0x93a464);
  const water = new THREE.Color(0x2a5a74);
  const mmForest = new THREE.Color(0x3c5a2c);
  const mmRocky = new THREE.Color(0x77745c);
  const mmMarsh = new THREE.Color(0x4a5a34);
  const c = new THREE.Color();
  for (let j = 0; j < MM_N; j++) {
    const z = -PLAY_HALF + ((j + 0.5) / MM_N) * 2 * PLAY_HALF;
    for (let i = 0; i < MM_N; i++) {
      const x = -PLAY_HALF + ((i + 0.5) / MM_N) * 2 * PLAY_HALF;
      const h = baseHeightFast(x, z);
      if (h < WATER_SURFACE_Y) {
        c.copy(water);
      } else {
        c.copy(lo).lerp(hi, Math.max(0, Math.min(1, (h + 0.4) / 3.5)));
        const biome = biomeAt(x, z);
        if (biome === BIOME_FOREST) c.lerp(mmForest, 0.45);
        else if (biome === BIOME_ROCKY) c.lerp(mmRocky, 0.4);
        else if (biome === BIOME_MARSH) c.lerp(mmMarsh, 0.5);
        const road = roadAt(x, z);
        if (road.w > 0.4) c.setHex(road.cobble ? 0x8a857d : 0x7a6446);
      }
      const o = (j * MM_N + i) * 4;
      img.data[o] = c.r * 255;
      img.data[o + 1] = c.g * 255;
      img.data[o + 2] = c.b * 255;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  mmBase = canvas;
  return canvas;
}

const mmPct = (v: number): string => `${(((v + PLAY_HALF) / (2 * PLAY_HALF)) * 100).toFixed(1)}%`;

interface Minimap {
  refresh(): void; // ownership/selection state
  repaint(): void; // new map: base image + flag positions
}
const minimaps: Minimap[] = [];

function makeMinimap(container: HTMLElement): void {
  const root = document.createElement("div");
  root.className = "minimap";
  const canvas = document.createElement("canvas");
  canvas.width = MM_N;
  canvas.height = MM_N;
  canvas.getContext("2d")!.drawImage(minimapBase(), 0, 0);
  root.appendChild(canvas);

  const zoneBtns = ZONES.map((def, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "mm-flag";
    b.disabled = true;
    b.textContent = def.letter;
    b.style.left = mmPct(def.x);
    b.style.top = mmPct(def.z);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!b.disabled) selectSpawn(i);
    });
    root.appendChild(b);
    return b;
  });
  const hq = document.createElement("button");
  hq.type = "button";
  hq.className = "mm-flag mm-hq own";
  hq.textContent = "HQ";
  hq.style.display = "none"; // positioned once the team is known
  hq.addEventListener("click", (e) => {
    e.stopPropagation();
    selectSpawn(SPAWN_HQ);
  });
  root.appendChild(hq);
  // The enemy base, marked but never selectable — both HQs read as the
  // anchors of the map, and yours doubles as a spawn point.
  const hqFoe = document.createElement("div");
  hqFoe.className = "mm-flag mm-hq foe";
  hqFoe.textContent = "HQ";
  hqFoe.style.display = "none";
  root.appendChild(hqFoe);
  const status = document.createElement("div");
  status.className = "mm-status";
  container.appendChild(root);
  container.appendChild(status);

  const refresh = (): void => {
    const team = myTeam();
    for (let i = 0; i < zoneBtns.length; i++) {
      const owner = zoneState[i]?.owner ?? -1;
      const own = owner >= 0 && owner === team;
      const b = zoneBtns[i];
      b.disabled = !own;
      b.classList.toggle("own", own);
      // A pick the team has since lost falls back to auto server-side, so
      // don't keep showing it as the selection.
      b.classList.toggle("sel", spawnChoice === i && own);
      b.style.borderColor = owner >= 0 ? TEAM_COLORS_CSS[owner] : "rgba(255,255,255,.3)";
      b.style.background = owner >= 0 ? `${TEAM_COLORS_CSS[owner]}cc` : "rgba(18,22,32,.82)";
    }
    if (team >= 0) {
      const base = MAP.spawns[team];
      hq.style.display = "flex";
      hq.style.left = mmPct(base[0]);
      hq.style.top = mmPct(base[2]);
      hq.style.borderColor = TEAM_COLORS_CSS[team];
      hq.style.background = `${TEAM_COLORS_CSS[team]}cc`;
      hq.classList.toggle("sel", spawnChoice === SPAWN_HQ);
      const foeBase = MAP.spawns[1 - team];
      hqFoe.style.display = "flex";
      hqFoe.style.left = mmPct(foeBase[0]);
      hqFoe.style.top = mmPct(foeBase[2]);
      hqFoe.style.borderColor = TEAM_COLORS_CSS[1 - team];
      hqFoe.style.background = `${TEAM_COLORS_CSS[1 - team]}55`;
    }
    const picked = spawnChoice >= 0 && zoneState[spawnChoice]?.owner === team;
    const label = picked
      ? `FLAG ${ZONES[spawnChoice].letter}`
      : spawnChoice >= 0
        ? "AUTO — flag lost"
        : "HQ";
    status.innerHTML = `spawning at <b style="color:${team >= 0 ? TEAM_COLORS_CSS[team] : "#fff"}">${label}</b>`;
  };
  const repaint = (): void => {
    canvas.getContext("2d")!.drawImage(minimapBase(), 0, 0);
    for (let i = 0; i < zoneBtns.length; i++) {
      const def = ZONES[i];
      if (!def) continue;
      zoneBtns[i].style.left = mmPct(def.x);
      zoneBtns[i].style.top = mmPct(def.z);
    }
    refresh();
  };
  refresh();
  minimaps.push({ refresh, repaint });
}

function refreshMinimaps(): void {
  for (const m of minimaps) m.refresh();
}

makeMinimap(el.introMap);
makeMinimap(el.respawnMap);

// --- Class picker (intro + respawn overlay). The pick is sent as a reliable
// message; the server applies it at the next spawn (or immediately while
// still untouched on the join pad).

let classChoice = loadStoredClass();
const classPickers: Array<() => void> = [];

// Weapon thumbnails for the class cards, rendered once from the real GLTF
// weapon models into data URLs. A tiny offscreen renderer does each shot and
// is disposed as soon as every card's weapon has one.
const weaponThumbs = new Map<number, string>();
let thumbRenderer: THREE.WebGLRenderer | null = null;

function weaponThumb(weaponIdx: number): string | null {
  const cached = weaponThumbs.get(weaponIdx);
  if (cached) return cached;
  const tpl = viewWeaponTemplates[weaponIdx];
  if (!tpl) return null; // model still loading; retry on the next refresh
  const W = 168;
  const H = 72;
  thumbRenderer ??= new THREE.WebGLRenderer({ alpha: true, antialias: true });
  thumbRenderer.setSize(W, H);
  const stage = new THREE.Scene();
  stage.add(new THREE.AmbientLight(0xffffff, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(1.5, 2, 3);
  stage.add(key);
  const model = cloneExternalModel(tpl, 0, false);
  model.rotation.y = Math.PI; // barrel to screen-right
  stage.add(model);
  // Frame the profile with an orthographic camera fitted to the model's
  // bounds (small margin), matched to the card's aspect.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  let halfW = (size.x / 2) * 1.15;
  let halfH = (size.y / 2) * 1.15;
  if (halfW / halfH < W / H) halfW = halfH * (W / H);
  else halfH = halfW / (W / H);
  const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, 10);
  cam.position.set(center.x, center.y, center.z + 2);
  cam.lookAt(center);
  thumbRenderer.render(stage, cam);
  const url = thumbRenderer.domElement.toDataURL();
  weaponThumbs.set(weaponIdx, url);
  const needed = CLASSES.map((_, i) => classPrimaryIdx(i));
  if (needed.every((idx) => weaponThumbs.has(idx)) && thumbRenderer) {
    thumbRenderer.dispose(); // every card has its shot: free the GL context
    thumbRenderer = null;
  }
  return url;
}

function refreshClassPickers(): void {
  for (const refresh of classPickers) refresh();
}

function sendClassChoice(): void {
  void client.streams.send({ type: "class", cls: classChoice }).catch(() => {});
}

function selectClass(cls: number): void {
  if (cls < 0 || cls >= CLASSES.length) return;
  classChoice = cls;
  try {
    localStorage.setItem(CLASS_STORAGE_KEY, String(cls));
  } catch {
    // Storage can be unavailable in private or embedded contexts.
  }
  sendClassChoice();
  for (const refresh of classPickers) refresh();
}

function makeClassPicker(container: HTMLElement): void {
  const row = document.createElement("div");
  row.className = "classrow";
  const btns = CLASSES.map((cls, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "classbtn";
    b.title = cls.blurb;
    b.innerHTML = `<div class="ci"></div><div class="cn">${cls.name.toUpperCase()}</div><div class="cw">${
      WEAPON_LIST[classPrimaryIdx(i)].name
    } + ${WEAPON_LIST[secondaryIdxFor(classPrimaryIdx(i))].name}</div>`;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      selectClass(i);
    });
    row.appendChild(b);
    return b;
  });
  container.appendChild(row);
  const refresh = (): void => {
    for (let i = 0; i < btns.length; i++) {
      btns[i].classList.toggle("sel", classChoice === i);
      // Drop the primary weapon's render in once its model has loaded.
      const slot = btns[i].querySelector(".ci")!;
      if (slot.childElementCount === 0) {
        const thumb = weaponThumb(classPrimaryIdx(i));
        if (thumb) {
          const img = document.createElement("img");
          img.src = thumb;
          img.alt = WEAPON_LIST[classPrimaryIdx(i)].name;
          slot.appendChild(img);
        }
      }
    }
  };
  refresh();
  classPickers.push(refresh);
}

makeClassPicker(el.introClasses);
makeClassPicker(el.respawnClasses);

// The respawn overlay: shown while dead (after the intro), hosting the spawn
// map + the DEPLOY button — respawning is always an explicit click, never
// automatic. Pointer lock is released so the buttons are clickable, and
// re-requested on respawn (browsers that demand a fresh gesture fall back to
// the usual click-to-lock).
let respawnShown = false;
let deployRequested = false;
let lastMinimapRefresh = 0;

el.respawnDeploy.addEventListener("click", () => {
  if (deployRequested || respawnTicks > 0) return;
  deployRequested = true;
  void client.streams.send({ type: "deploy" }).catch(() => {});
});

function updateRespawnOverlay(dead: boolean, now: number): void {
  const show = dead && !introVisible && phase === "playing" && connected;
  if (show !== respawnShown) {
    respawnShown = show;
    (el.respawn as HTMLElement).style.display = show ? "flex" : "none";
    if (show) {
      deployRequested = false;
      document.exitPointerLock();
      refreshMinimaps();
    } else if (!wantsTouch && !introVisible) {
      try {
        void (
          renderer.domElement.requestPointerLock() as unknown as Promise<void> | undefined
        )?.catch(() => {});
      } catch {
        /* needs a fresh gesture; the canvas click handler covers it */
      }
    }
  }
  if (!show) return;
  if (deployRequested) {
    el.respawnDeploy.disabled = true;
    el.respawnDeploy.textContent = "DEPLOYING…";
  } else if (respawnTicks > 0) {
    el.respawnDeploy.disabled = true;
    el.respawnDeploy.textContent = `DEPLOY IN ${Math.ceil(respawnTicks / TICK_RATE)}s`;
  } else {
    el.respawnDeploy.disabled = false;
    el.respawnDeploy.textContent = "DEPLOY";
  }
  if (now - lastMinimapRefresh > 250) {
    lastMinimapRefresh = now;
    refreshMinimaps();
    refreshClassPickers();
  }
}

// ---------------------------------------------------------------------------
// Intro / deploy screen: the opaque first-connect UI. It tells the player
// their team, the goal, and the controls, and doubles as the loading gate —
// DEPLOY only unlocks once the visual assets and the welcome message are in,
// so neither the world nor placeholder models are ever seen early.

let introVisible = true;
let introAssetsTimedOut = false;
const INTRO_BORN_AT = performance.now();
// Past this, stop holding the door for missing/failed assets — deploy with
// the procedural fallbacks rather than blocking play forever.
const INTRO_ASSET_TIMEOUT_MS = 12_000;

const keyRow = (k: string, label: string): string =>
  `<div class="krow"><kbd>${k}</kbd><span>${label}</span></div>`;
el.introKeys.innerHTML = wantsTouch
  ? keyRow("◐", "left half — drag to move") +
    keyRow("◑", "right half — drag to aim") +
    keyRow("◎", "big button — fire") +
    keyRow("▲", "side buttons — jump · sprint · build") +
    keyRow("♻", "more — reload · grenade · sledge") +
    keyRow("⚑", "stand in a zone to capture it")
  : keyRow("WASD", "move") +
    keyRow("LMB", "fire") +
    keyRow("Shift", "sprint") +
    keyRow("Space", "jump") +
    keyRow("R", "reload") +
    keyRow("G", "grenade") +
    keyRow("F", "sledgehammer") +
    keyRow("Q", "build cover") +
    keyRow("Tab", "scoreboard");

function introAssetsLoaded(): { loaded: number; total: number } {
  const parts = [
    ...characterTemplates.map((t) => t !== null),
    ...viewWeaponTemplates.map((t) => t !== null),
    grenadeTemplate !== null,
  ];
  return { loaded: parts.filter(Boolean).length, total: parts.length };
}

function introReady(): boolean {
  const { loaded, total } = introAssetsLoaded();
  // gw != null means buildWorlds finished: the scene + physics mirror are in
  // place, so deploying drops into a live world instead of a blocked frame.
  return (introAssetsTimedOut || loaded >= total) && connected && selfIdx >= 0 && gw !== null;
}

function updateIntroPanel(): void {
  const info = roster.get(selfIdx);
  if (info) {
    el.introTeam.textContent = `YOU'RE ON TEAM ${TEAM_NAMES[info.team].toUpperCase()}`;
    el.introTeam.style.background = TEAM_COLORS_CSS[info.team];
  }
  const { loaded, total } = introAssetsLoaded();
  const assetsReady = introAssetsTimedOut || loaded >= total;
  if (introReady()) {
    el.deploy.disabled = false;
    el.deploy.textContent = "DEPLOY";
    el.introStatus.textContent = wantsTouch ? "tap to enter the battlefield" : "good hunting";
  } else {
    el.deploy.disabled = true;
    if (!assetsReady) {
      el.deploy.textContent = `LOADING ASSETS ${loaded}/${total}…`;
      el.introStatus.textContent = "fetching models…";
    } else if (!connected || selfIdx < 0) {
      el.deploy.textContent = "CONNECTING…";
      el.introStatus.textContent = "waiting for the server…";
    } else {
      el.deploy.textContent = "PREPARING BATTLEFIELD…";
      el.introStatus.textContent = "building the world…";
    }
  }
}

const introTimer = setInterval(() => {
  if (!introVisible) return;
  if (performance.now() - INTRO_BORN_AT > INTRO_ASSET_TIMEOUT_MS) {
    introAssetsTimedOut = true;
    // No server in sight (e.g. the bare Vite client in dev): build the world
    // anyway so a forced deploy / free-cam inspection has something to show.
    // With a connection this never runs — the welcome triggers buildWorlds().
    if (!connected && !mapVisualsBuilt) buildMapVisuals();
  }
  updateIntroPanel();
  refreshMinimaps(); // live zone ownership on the deploy map
  refreshClassPickers(); // fills weapon thumbnails in as models load
}, 150);

function dismissIntro(): void {
  if (!introVisible) return;
  introVisible = false;
  clearInterval(introTimer);
  el.intro.style.display = "none";
  ensureAudio();
  // Deploy into the fight, not staring at the map edge.
  if (predState) faceTheAction(predState.x, predState.z);
  if (!wantsTouch) renderer.domElement.requestPointerLock();
}

function tryDeploy(): void {
  if (introReady()) dismissIntro();
}

// Clicks on the DEPLOY button bubble here too; tryDeploy gates on readiness.
el.intro.addEventListener("click", tryDeploy);
updateIntroPanel();
// The intro has taken over the viewport — retire index.html's boot splash.
document.getElementById("boot")?.remove();

// ---------------------------------------------------------------------------
// Boot.

async function boot(): Promise<void> {
  bootPerf["0:moduleEvalDoneAt"] = Math.round(performance.now());
  void readStreams();
  void readDatagrams();
  frame();
  // No scene build here: the welcome message triggers buildWorlds(), which
  // does it with the round's actual destruction state. Building eagerly too
  // used to double the load time (two ~4s builds back to back).
  try {
    await client.ready;
    connected = true;
  } catch {
    return;
  }
  void client.closed.then(() => {
    connected = false;
  });
}

void boot();

// ---------------------------------------------------------------------------
// Dev hooks for the playtest scripts.

declare global {
  interface Window {
    __fps: {
      connectionState(): string;
      playerPosition(): [number, number, number];
      hp(): number;
      phase(): string;
      scores(): [number, number];
      roster(): Array<{ idx: number; name: string; team: number }>;
      rollbacks(): number;
      snapshots(): number;
      seq(): number;
      selfStatus(): number;
      ammo(): number;
      panelCount(): number;
      myHits(): number;
      aimPanel(): number | null;
      dbgEvents(): [number, number, number];
      remotePos(idx: number): [number, number, number] | null;
      destroyedCount(): number;
      collapsedCount(): number;
      craterCount(): number;
      zones(): Array<{ owner: number; v: number }>;
      tickets(): [number, number];
      roundTicksLeft(): number;
      groundHeightAt(x: number, z: number): number;
      rubbleCount(): number;
      fallenCount(): number;
      corpseCount(): number;
      joltFree(): number;
      soundFamilies(): Record<string, number>;
      soundLog(): string[];
      externalAssets(): {
        soldierLoaded: boolean;
        enemyLoaded: boolean;
        clipCount: number;
        weaponLoaded: boolean;
        remoteAnimatedCount: number;
        corpseCount: number;
        viewWeaponLoaded: boolean;
      };
      forceAudio(): void;
      audioVolume(): number;
      setAudioVolume(value: number): void;
      introVisible(): boolean;
      bootPerf(): Record<string, number>;
      deploy(): void;
      nameTags(): Array<{ idx: number; name: string; visible: boolean }>;
      spawnChoice(): number;
      selectSpawn(zone: number): void;
      classChoice(): number;
      selectClass(cls: number): void;
      activeWeapon(): { slot: number; name: string; ammo: number };
      setSlot(slot: number): void;
      yawPitch(): [number, number];
      perf(): Record<string, number>;
      look(yawV: number, pitchV: number): void;
      drive(over: Partial<Omit<InputCmd, "seq">> & { trackIdx?: number }, ticks: number): void;
      stopDrive(): void;
    };
  }
}

window.__fps = {
  connectionState: () => (connected ? "connected" : "connecting"),
  playerPosition: () => (predState ? [predState.x, predState.y, predState.z] : [0, 0, 0]),
  hp: () => selfHp,
  phase: () => phase,
  scores: () => [scores[0], scores[1]],
  roster: () => [...roster.values()].map((p) => ({ idx: p.idx, name: p.name, team: p.team })),
  rollbacks: () => rollbacks,
  snapshots: () => snapshotsSeen,
  seq: () => seq,
  selfStatus: () => selfStatus,
  ammo: () => (predState ? predState.ammo : 0),
  panelCount: () => panelSlots.size + builtMeshes.size,
  myHits: () => myHits,
  // What the mirror world says is under the crosshair (panel id, or null).
  aimPanel: () => {
    if (!predState || !gw || !selfBody) return null;
    const dir = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const eye = [predState.x, predState.y + EYE_HEIGHT, predState.z];
    const hit = castLocal(eye, dir, 30);
    return hit ? hitPieceId(hit.body, hit.point) : null;
  },
  dbgEvents: () => [dbgEvents, dbgMyTracers, dbgHitEvents] as [number, number, number],
  remotePos: (idx) => {
    const rp = remotes.get(idx);
    if (!rp) return null;
    const g = rp.group.position;
    return [g.x, g.y, g.z];
  },
  destroyedCount: () => destroyedSet.size,
  collapsedCount: () => collapsedCount,
  craterCount: () => craterList().length,
  zones: () => zoneState.map((z) => ({ owner: z.owner, v: z.v })),
  tickets: () => [scores[0], scores[1]],
  roundTicksLeft: () => Math.max(0, phaseEndTick - estServerTick()),
  groundHeightAt: (x: number, z: number) => heightAt(x, z),
  rubbleCount: () => builtList.filter((p) => p.broken).length,
  fallenCount: () => builtList.filter((p) => !p.broken && p.material !== "metal").length,
  corpseCount: () => corpses.length,
  joltFree: () => joltFreeMemory(),
  soundFamilies: () =>
    Object.fromEntries(
      [...soundBuffers.entries()].map(([family, buffers]) => [family, buffers.length]),
    ),
  soundLog: () => [...soundLog],
  externalAssets: () => ({
    soldierLoaded: characterTemplates[0] !== null,
    enemyLoaded: false, // single Soldier model for both teams
    clipCount: characterTemplates[0]?.clips.length ?? 0,
    weaponLoaded: viewWeaponTemplates.every((t) => t !== null),
    remoteAnimatedCount: [...remotes.values()].filter((rp) => rp.anim !== undefined).length,
    corpseCount: corpses.length,
    viewWeaponLoaded: viewModel.userData.externalAttached === true,
  }),
  forceAudio: () => ensureAudio(),
  audioVolume: () => masterVolume,
  setAudioVolume: (value) => {
    ensureAudio();
    setMasterVolume(value);
  },
  introVisible: () => introVisible,
  bootPerf: () => ({ ...bootPerf }),
  deploy: () => dismissIntro(), // force-dismiss for scripted playtests
  spawnChoice: () => spawnChoice,
  selectSpawn: (zone) => selectSpawn(zone),
  classChoice: () => classChoice,
  selectClass: (cls) => selectClass(cls),
  activeWeapon: () => {
    if (!predState) return { slot: 0, name: "Rifle", ammo: 0 };
    const w = activeWeapon(predState);
    return {
      slot: predState.slot,
      name: w.name,
      ammo: predState.slot === 1 ? predState.ammo2 : predState.ammo,
    };
  },
  setSlot: (slot) => {
    desiredSlot = slot === 1 ? 1 : 0;
  },
  yawPitch: () => [yaw, pitch] as [number, number],
  nameTags: () =>
    [...remotes.entries()].map(([idx, rp]) => {
      const sprite = rp.group.userData.nameSprite as THREE.Sprite | undefined;
      return { idx, name: rp.info.name, visible: sprite?.visible === true };
    }),
  perf: () => ({
    fps: perf.fps,
    avgFrameMs: perf.avgFrameMs,
    maxFrameMs: perf.maxFrameMs,
    avgPredictMs: perf.avgPredictMs,
    avgSnapMs: perf.avgSnapMs,
    avgRenderMs: perf.avgRenderMs,
    drawCalls: perf.drawCalls,
    triangles: perf.triangles,
    pixelRatio: renderer.getPixelRatio(),
    interpDelayMs,
  }),
  look: (yawV, pitchV) => {
    yaw = yawV;
    pitch = pitchV;
  },
  drive: (over, ticks) => {
    driven = { ...ZERO_INPUT, yaw, pitch, ...over, ticks };
  },
  stopDrive: () => {
    driven = null;
  },
};
