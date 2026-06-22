// Browser client: first-person rendering, local prediction over a mirror Jolt
// world, remote interpolation, destruction/construction sync, and the HUD.
// The server is authoritative for everything; this file is display + input.

import { client } from "snack:client";
import * as THREE from "three";
import {
  HEADSHOT_HEIGHT,
  INPUT_REDUNDANCY,
  MAX_HP,
  RELOAD_TICKS,
  TEAM_NAMES,
  TICK_MS,
  TICK_RATE,
} from "./shared/constants.js";
import {
  addCrater,
  baseHeightAt,
  chunksTouching,
  craterList,
  heightAt,
  MAP,
  PANEL_HP,
  type PanelDef,
  type PanelMaterial,
  resetCraters,
  slabOfPiece,
  TERRAIN_CHUNK,
  TERRAIN_CHUNKS,
  terrainChunkMesh,
  WATER_SURFACE_Y,
  ZONES,
} from "./shared/map.js";
import { RUBBLE_HEIGHT } from "./shared/constants.js";
import { BUILT_PANEL_ID_BASE } from "./shared/map.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { parseServerMsg, type PlayerInfo } from "./shared/messages.js";
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
  type ZoneSnap,
} from "./shared/netCodec.js";
import {
  addPanelBody,
  addRubbleBody,
  applyCraterBodies,
  type Body,
  buildPlacement,
  type CharState,
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
document.body.style.cssText = "margin:0;overflow:hidden;background:#0c0f14;";
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb8cfe0);
scene.fog = new THREE.Fog(0xb8cfe0, 90, 230);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.08, 360);
const hemi = new THREE.HemisphereLight(0xe8f1fa, 0x6e6a5e, 1.0);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
sun.position.set(35, 50, -25);
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
// for masonry (the bevel catches light, so every brick reads as a brick),
// faceted cylinders for logs and trunks, soft-cornered lumps for rocks.
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

const CANOPY_GREENS = [0x4e8a3c, 0x5f9c46, 0x3f7a34, 0x6fae52, 0x35703a];

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
    case "trunk":
      return out.setHSL(0.072 + h1 * 0.015, 0.42, 0.25 + h1 * 0.08);
    case "canopy":
      out.setHex(CANOPY_GREENS[Math.floor(h1 * CANOPY_GREENS.length)]);
      return out.multiplyScalar(0.88 + h2 * 0.24);
    case "crate":
      return out.setHSL(0.088 + h1 * 0.012, 0.46 + h2 * 0.08, 0.5 + h1 * 0.1);
    case "sandbag":
      return out.setHSL(0.112 + h1 * 0.012, 0.2 + h2 * 0.06, 0.5 + h1 * 0.12);
    case "rock":
      return out.setHSL(0.085 + h1 * 0.02, 0.04 + h2 * 0.05, 0.4 + h1 * 0.2);
    case "concrete":
      return out.setHSL(0.58 + h1 * 0.02, 0.02 + h2 * 0.03, 0.54 + h1 * 0.12);
    case "glass":
      return out.setHex(0xd6eef7);
    case "rubble":
      return out.setHSL(0.07 + h1 * 0.03, 0.1 + h2 * 0.1, 0.36 + h1 * 0.14);
    case "metal":
      return out.setHSL(0.57 + h1 * 0.02, 0.07, 0.5 + h1 * 0.1);
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
const TERRAIN_LOW = new THREE.Color(0x5e8a4a);
const TERRAIN_HIGH = new THREE.Color(0x8aa763);
const TERRAIN_SCORCH = new THREE.Color(0x4f463b);
const TERRAIN_BED = new THREE.Color(0x6a6f52); // silty riverbed

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

const waterMat = new THREE.MeshStandardMaterial({
  color: 0x3e6f9d,
  roughness: 0.12,
  metalness: 0,
  transparent: true,
  opacity: 0.72,
});

function makeTerrainChunkMesh(ci: number, cj: number): THREE.Mesh {
  const data = terrainChunkMesh(ci, cj);
  let geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(data.vertices, 3));
  geo.setIndex(data.indices);
  geo = geo.toNonIndexed(); // flat faceted normals + per-face color
  geo.computeVertexNormals();
  const pos = geo.getAttribute("position");
  const colors: number[] = [];
  const c = new THREE.Color();
  for (let f = 0; f < pos.count; f += 3) {
    const cx = (pos.getX(f) + pos.getX(f + 1) + pos.getX(f + 2)) / 3;
    const cy = (pos.getY(f) + pos.getY(f + 1) + pos.getY(f + 2)) / 3;
    const cz = (pos.getZ(f) + pos.getZ(f + 1) + pos.getZ(f + 2)) / 3;
    const t = Math.max(0, Math.min(1, cy / 1.5));
    c.copy(TERRAIN_LOW).lerp(TERRAIN_HIGH, t);
    // Crater bowls read as scorched earth; riverbeds as silt.
    const dug = baseHeightAt(cx, cz) - cy;
    if (dug > 0.08) c.lerp(TERRAIN_SCORCH, Math.min(1, dug / 0.6));
    if (cy < WATER_SURFACE_Y + 0.05) {
      c.lerp(TERRAIN_BED, Math.min(1, (WATER_SURFACE_Y + 0.05 - cy) / 0.5));
    }
    const j = 0.93 + hash01(Math.round(cx * 7 + cz * 131), 5) * 0.14;
    colors.push(c.r * j, c.g * j, c.b * j, c.r * j, c.g * j, c.b * j, c.r * j, c.g * j, c.b * j);
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

// --- Grass: per-chunk blade triangles with a wind-sway vertex shader,
// tinted to the terrain. Blades resample the heightfield on crater rebuilds
// (and skip scorched bowls).

const GRASS_PER_CHUNK = 110; // 256 chunks now — ~28k blades total
const grassChunkVisuals = new Map<number, THREE.Mesh>();
const grassMat = new THREE.ShaderMaterial({
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]),
  vertexShader: `
    #include <fog_pars_vertex>
    uniform float uTime;
    attribute float aTip;
    attribute float aSway;
    varying vec3 vColor;
    attribute vec3 aColor;
    void main() {
      vec3 p = position;
      p.x += sin(uTime * 1.9 + aSway * 6.2832 + position.x * 0.45 + position.z * 0.3)
        * 0.14 * aTip;
      p.z += cos(uTime * 1.4 + aSway * 6.2832) * 0.06 * aTip;
      vColor = aColor;
      vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `,
  fragmentShader: `
    #include <fog_pars_fragment>
    varying vec3 vColor;
    void main() {
      gl_FragColor = vec4(vColor, 1.0);
      #include <fog_fragment>
    }
  `,
  side: THREE.DoubleSide,
  fog: true,
});

function makeGrassChunkMesh(ci: number, cj: number): THREE.Mesh | null {
  const x0 = -MAP.size / 2 + ci * TERRAIN_CHUNK;
  const z0 = -MAP.size / 2 + cj * TERRAIN_CHUNK;
  const positions: number[] = [];
  const colors: number[] = [];
  const tips: number[] = [];
  const sways: number[] = [];
  const cLow = new THREE.Color(0x57843f);
  const cHigh = new THREE.Color(0x9dba59);
  const blade = new THREE.Color();
  const seedBase = (ci * 31 + cj) * 7919;
  for (let i = 0; i < GRASS_PER_CHUNK; i++) {
    const x = x0 + hash01(seedBase + i, 11) * TERRAIN_CHUNK;
    const z = z0 + hash01(seedBase + i, 12) * TERRAIN_CHUNK;
    const baseH = baseHeightAt(x, z);
    if (baseH < 0.04) continue; // pads, spawns, perimeter skirt, water
    const y = heightAt(x, z);
    if (baseH - y > 0.12) continue; // scorched crater bowl
    const h = 0.22 + hash01(seedBase + i, 13) * 0.3;
    const w = 0.05 + hash01(seedBase + i, 14) * 0.05;
    const yaw = hash01(seedBase + i, 15) * Math.PI;
    const dx = Math.cos(yaw) * w;
    const dz = Math.sin(yaw) * w;
    const sway = hash01(seedBase + i, 16);
    blade.copy(cLow).lerp(cHigh, hash01(seedBase + i, 17));
    // One triangle per blade: two roots, one tip.
    positions.push(x - dx, y, z - dz, x + dx, y, z + dz, x, y + h, z);
    const r = blade.clone().multiplyScalar(0.74);
    colors.push(r.r, r.g, r.b, r.r, r.g, r.b, blade.r, blade.g, blade.b);
    tips.push(0, 0, 1);
    sways.push(sway, sway, sway);
  }
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("aColor", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("aTip", new THREE.Float32BufferAttribute(tips, 1));
  geo.setAttribute("aSway", new THREE.Float32BufferAttribute(sways, 1));
  return new THREE.Mesh(geo, grassMat);
}

function rebuildGrassChunk(ci: number, cj: number): void {
  const key = ci * TERRAIN_CHUNKS + cj;
  const old = grassChunkVisuals.get(key);
  if (old) {
    mapGroup.remove(old);
    old.geometry.dispose();
    grassChunkVisuals.delete(key);
  }
  const mesh = makeGrassChunkMesh(ci, cj);
  if (mesh) {
    grassChunkVisuals.set(key, mesh);
    mapGroup.add(mesh);
  }
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

function buildMapVisuals(): void {
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
  grassChunkVisuals.clear();
  decals.length = 0;
  corpses.length = 0; // their groups died with the old mapGroup
  fallingChunks.clear(); // ditto

  for (let ci = 0; ci < TERRAIN_CHUNKS; ci++) {
    for (let cj = 0; cj < TERRAIN_CHUNKS; cj++) {
      rebuildTerrainChunk(ci, cj);
      rebuildGrassChunk(ci, cj);
    }
  }

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
  #cross { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); font-size:22px; opacity:.9; }
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
</style>
<div id="hud">
  <div id="vignette"></div>
  <div id="flash"></div>
  <div id="cross" class="sh">+</div>
  <div id="crossname" class="sh"></div>
  <div id="hitmark">+</div>
  <div id="scores" class="sh"></div>
  <div id="timer" class="sh"></div>
  <div id="zones"></div>
  <div id="vitals" class="sh">HP<div class="hpbar"><div id="hpfill"></div></div></div>
  <div id="ammo" class="sh"><div class="mag" id="ammotext">30</div><div class="sub" id="gear"></div></div>
  <div id="feed"></div>
  <div id="overlay"><div class="panel" id="overlaypanel"></div></div>
  <div id="board"></div>
  <div id="hint" class="sh">click to play — WASD move · shift sprint · space jump · LMB fire · R reload · G grenade · F sledge · Q build cover · Tab scores</div>
  <div id="netinfo" class="sh"></div>
</div>`;
document.body.appendChild(hud);
const el = {
  cross: document.getElementById("cross")!,
  crossname: document.getElementById("crossname")!,
  hitmark: document.getElementById("hitmark")!,
  scores: document.getElementById("scores")!,
  timer: document.getElementById("timer")!,
  zones: document.getElementById("zones")!,
  hpfill: document.getElementById("hpfill")!,
  ammotext: document.getElementById("ammotext")!,
  gear: document.getElementById("gear")!,
  feed: document.getElementById("feed")!,
  overlay: document.getElementById("overlay")!,
  overlaypanel: document.getElementById("overlaypanel")!,
  board: document.getElementById("board")!,
  netinfo: document.getElementById("netinfo")!,
  vignette: document.getElementById("vignette")!,
  flash: document.getElementById("flash")!,
};

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
const soundBuffers = new Map<string, AudioBuffer[]>();
// One decode per URL, shared across every family that lists it (e.g. melee
// reuses the Kenney impacts) so the same file isn't fetched or decoded twice.
const bufferPromises = new Map<string, Promise<AudioBuffer | null>>();
const soundLog: string[] = [];
let soundManifestRequested = false;

function ensureAudio(): void {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.7;
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
// matches a fixed gameplay duration. No random pitch jitter.
function playSoundFit(family: string, seconds: number, volume = 1): boolean {
  if (!audioCtx) return false;
  const buffers = soundBuffers.get(family);
  if (!buffers || buffers.length === 0) return false;
  const buffer = buffers[Math.floor(Math.random() * buffers.length)];
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = Math.max(0.5, Math.min(2, buffer.duration / seconds));
  connectAudioNode(source, volume);
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

const sounds = {
  shot: () => {
    if (!playSound("rifle_shot", 0.9)) noiseBurst(0.09, 0.16);
    void playSound("rifle_tail", 0.35);
  },
  shotAt: (at: THREE.Vector3) => {
    if (!playSoundAt("rifle_shot", at, 0.9)) noiseBurst(0.1, 0.15, true, at);
    void playSoundAt("rifle_tail", at, 0.35);
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
  reload: () => {
    // Stretch the sample to the fixed reload time so audio and the dip line up.
    if (!playSoundFit("reload", RELOAD_TICKS / TICK_RATE, 0.8)) blip(700, 0.06, 0.08);
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

renderer.domElement.addEventListener("mousedown", (e) => {
  ensureAudio();
  if (!pointerLocked) {
    renderer.domElement.requestPointerLock();
    return;
  }
  if (e.button === 0) fireHeld = true;
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) fireHeld = false;
});
document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === renderer.domElement;
  if (!pointerLocked) fireHeld = false;
});
document.addEventListener("mousemove", (e) => {
  if (!pointerLocked) return;
  yaw -= e.movementX * 0.0023;
  pitch = Math.max(-1.45, Math.min(1.45, pitch - e.movementY * 0.0021));
  while (yaw > Math.PI) yaw -= Math.PI * 2;
  while (yaw < -Math.PI) yaw += Math.PI * 2;
});
window.addEventListener("keydown", (e) => {
  if (e.code === "Tab") e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  ensureAudio();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => {
  keys.clear();
  fireHeld = false;
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
    viewTick,
  };
}

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
  into.grenades = from.grenades;
  into.supply = from.supply;
}

async function buildWorlds(): Promise<void> {
  const buildId = ++worldBuildSeq;
  needHardAdopt = true;
  buildMapVisuals();
  const next = await createGameWorld(destroyedSet);
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
      destroyedSet = new Set(msg.destroyed);
      builtList = [...msg.built];
      collapsedList = [...msg.collapsed];
      welcomeHp = [...msg.panelHp];
      resetCraters();
      for (const c of msg.craters) addCrater(c);
      lastAckTick = msg.serverTick;
      void buildWorlds();
      break;
    }
    case "join": {
      roster.set(msg.player.idx, msg.player);
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
        rebuildGrassChunk(ci, cj);
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
      if (snap) handleSnapshot(snap, event.receivedAt);
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
    const myTeam = roster.get(selfIdx)?.team ?? 0;
    spawnCorpse(new THREE.Vector3(predState.x, predState.y, predState.z), yaw, myTeam);
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
      };
      remotes.set(r.idx, rp);
      attachExternalSoldier(rp); // swaps in the animated model when ready
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

  const ammoBefore = predState.ammo;
  const reloadBefore = predState.reloadTicks;
  stepPlayerController(gw, selfBody, predState, cmd, {
    locked: dead,
    onFire: (eye, dir) => {
      sounds.shot();
      recoil = Math.min(1, recoil + 0.4);
      // Predicted tracer from a local raycast — instant feedback; the
      // server's events remain authoritative for hits and damage.
      if (gw && selfBody) {
        const from = muzzleWorld().clone();
        const hit = castLocal(eye, dir, 90);
        const end = hit
          ? new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2])
          : new THREE.Vector3(eye[0] + dir[0] * 90, eye[1] + dir[1] * 90, eye[2] + dir[2] * 90);
        spawnTracer(from, end);
        const tag = (hit?.body.userData ?? {}) as { playerIdx?: number; grenadeId?: number };
        if (hit && tag.playerIdx === undefined && tag.grenadeId === undefined) {
          const pieceId = hitPieceId(hit.body, hit.point) ?? undefined;
          spawnBulletDecal(end, surfaceNormalAt(hit.body, end), pieceId);
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
  if (reloadBefore === 0 && predState.reloadTicks > 0 && ammoBefore < 30) sounds.reload();

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
}

// Team 0 renders as the Soldier, team 1 as the Enemy — distinct silhouettes so
// friend and foe read at a glance. Both share the kit's identical 17-clip rig.
const characterTemplates: Array<CharacterTemplate | null> = [null, null];
let externalWeaponTemplate: THREE.Group | null = null;
let externalAssetsRequested = false;
const EXTERNAL_CHARACTER_YAW = 0; // Quaternius characters face local +Z, like the blocky rig.
const EXTERNAL_VIEW_WEAPON_YAW = -Math.PI / 2; // ak.gltf barrel runs down -X; turn it to the camera's -Z (forward).
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
      const urls = manifest?.characters ?? [];
      const soldierUrl = urls.find((u) => /soldier/i.test(u)) ?? urls[0];
      // One soldier model for both teams, tinted red vs blue per instance.
      // Loading a single character keeps the models ready fast (the frame loop
      // swaps them in on arrival, before the box rig is ever revealed).
      if (soldierUrl) {
        void loadCharacterTemplate(soldierUrl)
          .then((t) => {
            characterTemplates[0] = t;
          })
          .catch(() => {});
      }
      const weaponUrl = manifest?.weapons?.[0];
      if (weaponUrl) {
        void loadModel(weaponUrl)
          .then(({ scene }) => {
            externalWeaponTemplate = scene;
            prepareExternalModel(externalWeaponTemplate, 0.42);
            attachExternalViewWeapon();
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

async function loadCharacterTemplate(url: string): Promise<CharacterTemplate> {
  const { scene, animations } = await loadModel(url);
  prepareExternalCharacterModel(scene);
  return { scene, clips: animations };
}

function prepareExternalCharacterModel(root: THREE.Group): void {
  root.traverse((o) => {
    if (CHARACTER_WEAPON_NODES.has(o.name) && o.name !== "AK") {
      o.visible = false;
    }
  });
  prepareExternalModel(root, 1.78, (o) => !hasNamedAncestor(o, CHARACTER_WEAPON_NODES));
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
// and an AnimationMixer bound to the cloned rig.
function instantiateCharacter(team: number): CharacterInstance | null {
  const tpl = characterTemplates[team] ?? characterTemplates[0];
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
  const running = speed > ANIM_RUN_SPEED;
  const sprinting = speed > ANIM_SPRINT_SPEED;
  const moving = speed > ANIM_MOVE_SPEED;
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
    timeScale = Math.max(0.8, Math.min(1.2, speed / 5.2));
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
  rp.anim = {
    mixer: inst.mixer,
    actions: inst.actions,
    base: "",
    shootUntil: 0,
    jumpUntil: 0,
    hitUntil: 0,
  };
  playClip(rp.anim, "Idle", 0);
}

function attachExternalViewWeapon(): void {
  if (!externalWeaponTemplate || viewModel.userData.externalAttached === true) return;
  const fallback = viewModel.userData.fallbackRoot as THREE.Object3D | undefined;
  if (fallback) fallback.visible = false;
  const model = cloneExternalModel(externalWeaponTemplate, 0, false);
  model.name = "externalWeapon";
  model.position.set(0, -0.02, -0.12);
  model.rotation.y = EXTERNAL_VIEW_WEAPON_YAW;
  viewModel.add(model);
  viewModel.userData.externalAttached = true;
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

  // Name tag.
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 56;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "bold 30px Trebuchet MS, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,.6)";
  ctx.strokeText(name, 128, 28);
  ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.fillText(name, 128, 28);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }),
  );
  sprite.scale.set(1.7, 0.37, 1);
  sprite.position.y = 1.95;
  g.add(sprite);

  scene.add(g);
  return g;
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
}

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
  corpses.push({ group, mixer, until: performance.now() + CORPSE_TTL_MS, materials });
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
  attachExternalViewWeapon();
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
            spawnTracer(from, at);
            sounds.shotAt(from);
            const shooterRp = remotes.get(e.a);
            if (shooterRp?.anim) shooterRp.anim.shootUntil = performance.now() + 280;
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
  (grassMat.uniforms.uTime as { value: number }).value = now / 1000;

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

  // First-person weapon feel: a rest pose plus recoil, melee, a walk/sprint
  // bob, a reload dip, and a distinct sprint sway (gun lowered and canted).
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
    predState && predState.reloadTicks > 0 ? predState.reloadTicks / RELOAD_TICKS : 0;
  const dip = reloadProg > 0 ? Math.sin((1 - reloadProg) * Math.PI) : 0; // 0→1→0 over reload
  const sway = sprintBlend;
  viewModel.position.set(
    0.2 + bobX + sway * 0.05,
    -0.3 - meleeSwing * 0.12 + bobY - dip * 0.14 - sway * 0.07,
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
      sway * 0.3; // sprint: lower the muzzle, not raise it
    viewModel.rotation.z = sway * 0.35;
  }
  viewModel.visible = (selfStatus & SS_DEAD) === 0;
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

// Friend-or-foe under the crosshair: orange/blue crosshair + name, so
// shooting a teammate never reads as broken hit detection.
let crossTargetIdx = -1;

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
    const friendly = info.team === (roster.get(selfIdx)?.team ?? -1);
    const color = friendly ? TEAM_COLORS_CSS[info.team] : "#ff5a4a";
    el.cross.style.color = color;
    el.crossname.style.color = TEAM_COLORS_CSS[info.team];
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
    el.ammotext.textContent = predState.reloadTicks > 0 ? "…" : `${predState.ammo}`;
    el.gear.textContent = `🧨 ${predState.grenades}  🧱 ${predState.supply}`;
  }

  const dead = (selfStatus & SS_DEAD) !== 0;
  if (phase === "results") {
    const winner =
      scores[0] === scores[1] ? "Draw" : `${TEAM_NAMES[scores[0] > scores[1] ? 0 : 1]} wins`;
    el.overlaypanel.innerHTML = `<h1>${winner}</h1><p>${scores[0]} — ${scores[1]}</p><p>next round starting…</p>`;
    el.overlay.style.display = "flex";
  } else if (dead) {
    el.overlaypanel.innerHTML = `<h1>You're down</h1><p>respawn in ${Math.ceil(respawnTicks / TICK_RATE)}s</p>`;
    el.overlay.style.display = "flex";
  } else if (!connected) {
    el.overlaypanel.innerHTML = `<h1>Breachpoint</h1><p>connecting…</p>`;
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
// Boot.

async function boot(): Promise<void> {
  buildMapVisuals();
  void readStreams();
  void readDatagrams();
  frame();
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
    enemyLoaded: characterTemplates[1] !== null,
    clipCount: characterTemplates[0]?.clips.length ?? 0,
    weaponLoaded: externalWeaponTemplate !== null,
    remoteAnimatedCount: [...remotes.values()].filter((rp) => rp.anim !== undefined).length,
    corpseCount: corpses.length,
    viewWeaponLoaded: viewModel.userData.externalAttached === true,
  }),
  forceAudio: () => ensureAudio(),
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
