// The battlefield, procedurally generated from a fixed seed so client and
// server build identical worlds. Terrain is a value-noise heightfield
// (flattened under buildings and spawns); every structure is masonry of
// material-shaped destructible PIECES — clay bricks laid in running bond,
// stacked cabin logs, roof planks, tree trunks and foliage clumps, sandbags,
// supply crates. Gunfire chips out single bricks, explosions blow holes, and
// enough structural loss collapses the whole building. The only things that
// can't be destroyed are the ground and the arena's perimeter walls.

export const MAP_SEED = 0xb17b17;

export interface StaticBox {
  x: number; // center
  y: number;
  z: number;
  w: number; // full extents
  h: number;
  d: number;
  kind: "wall";
}

export type PanelMaterial =
  | "brick" // clay brick in a running-bond wall
  | "log" // stacked cabin log
  | "plank" // roof plank
  | "post" // structural timber corner post (tough)
  | "trunk" // tree trunk segment
  | "canopy" // foliage clump
  | "crate" // supply crate
  | "sandbag" // freestanding bag cover
  | "rock" // boulder / stone
  | "concrete" // precast panel — fewer, bigger, tougher pieces
  | "glass" // windowpane — one hit shatters it
  | "rubble" // chunk left behind by a destroyed piece (spawned at runtime)
  | "metal" // deployed cover sheet (built at runtime)
  | "stone" // flagstone floor slab
  | "stair"; // staircase tread — effectively indestructible so floors stay reachable

export interface PanelDef {
  id: number;
  x: number; // center
  y: number;
  z: number;
  ex: number; // full extents
  ey: number;
  ez: number;
  material: PanelMaterial;
  // Pieces belonging to a structure share its id; enough structural damage
  // brings the whole thing down (BattleBit-style critical health).
  buildingId?: number;
  // Resting orientation for pieces that fell and settled (released by the
  // support cascade and re-frozen where physics left them). Absent = axis
  // aligned, as generated.
  rot?: [number, number, number, number];
  // Palette seed for runtime pieces: a fallen brick keeps the color it had
  // on the wall (its original id), whatever runtime id it ends up with.
  seed?: number;
  // A broken-off fragment of a destroyed piece — renders with fractured
  // geometry (jagged break face) instead of the pristine shape.
  broken?: boolean;
}

// Max HP per material. Rifle hits chip 10, sledge swings 50.
export const PANEL_HP: Record<PanelMaterial, number> = {
  brick: 45,
  log: 70,
  plank: 30,
  post: 150,
  trunk: 50, // one sledge swing per segment; two segments fell the tree
  canopy: 30,
  crate: 90,
  sandbag: 60,
  rock: 180,
  concrete: 90, // two sledge swings a panel
  glass: 10, // any hit shatters it
  rubble: 40,
  metal: 120,
  stone: 140, // tough flagstone flooring
  stair: 100000, // effectively indestructible (also blast-exempt in sim)
};

export interface BuildingDef {
  id: number;
  kind: "building" | "tree";
  cx: number;
  cz: number;
  w: number;
  d: number;
  wallPanelIds: number[]; // the structural pieces that count toward collapse
  roofPanelIds: number[]; // fall with the structure but don't count
  collapseFraction: number; // fraction of structural pieces lost -> collapse
}

// Masonry units (full extents: length along the wall, height, thickness).
export const WALL_HEIGHT = 2.5;
export const BRICK = { l: 0.5, h: WALL_HEIGHT / 12, t: 0.24 };
export const LOG = { l: 2.0, h: 0.25, t: 0.26 };
export const PLANK = { l: 2.0, h: 0.07, w: 0.5 };
export const SANDBAG = { l: 0.55, h: 0.32, t: 0.42 };
export const CONCRETE = { l: 1.0, h: 0.625, t: 0.18 };

// A SLAB is the physics unit: one structural face/sheet/stack of pieces
// that shares ONE static body (a wall per story, a roof level, a tree, a
// sandbag emplacement...). Pieces are generated with sequential ids, so a
// slab is just an id range. Collision boxes are greedy-merged from the
// slab's ALIVE pieces and rebuilt when its damage set changes; hits resolve
// to individual pieces analytically from the hit position.
export interface Slab {
  first: number; // piece id range, inclusive
  last: number;
}

// A climbable ladder: a vertical volume against a wall face. The shared
// controller climbs it (push toward the wall to go up); clients render
// cosmetic rails + rungs. (nx,nz) is the OUTWARD wall normal.
export interface LadderDef {
  x: number; // center of the ladder on the wall face
  z: number;
  nx: number;
  nz: number;
  y1: number; // top of the climb (a bit above the roof lip)
}

export interface MapDef {
  size: number; // arena is size x size, centered on origin
  statics: StaticBox[];
  panels: PanelDef[];
  buildings: BuildingDef[];
  slabs: Slab[];
  ladders: LadderDef[];
  spawns: [[number, number, number], [number, number, number]];
}

// ---------------------------------------------------------------------------
// Deterministic noise terrain.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263 + MAP_SEED * 69069) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 10000) / 10000;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, z: number, cell: number): number {
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  const fx = smooth(x / cell - gx);
  const fz = smooth(z / cell - gz);
  const a = hash2(gx, gz);
  const b = hash2(gx + 1, gz);
  const c = hash2(gx, gz + 1);
  const d = hash2(gx + 1, gz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

const SIZE = 224; // a small-battlefield-scale arena (16 terrain chunks)
const TERRAIN_AMPLITUDE = 1.6;

// Footprints that must stay flat: building pads, spawn zones, and road
// clearings. Filled by planLayout() before any geometry is seated, so the pads
// derive from the buildings actually placed (mutable, not hand-authored).
let FLAT_PADS: Array<[number, number, number, number]> = [];

// A straight piece of a road/path centerline, with its surface height baked at
// each end (sampled from the pre-road terrain) so the road lies flat instead of
// rippling over the noise.
export interface RoadSeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ay: number;
  by: number;
  half: number; // half width
}
let ROAD_SEGS: RoadSeg[] = [];

// The baked road network, for the client to lay ribbon meshes on.
export function roadSegments(): readonly RoadSeg[] {
  return ROAD_SEGS;
}

// 1 in the open field, fading to 0 inside any flat pad. The noise relief and
// crater digging are scaled by this, so buildings never get undermined.
function padFade(x: number, z: number): number {
  let f = 1;
  for (const [cx, cz, hw, hd] of FLAT_PADS) {
    const dx = Math.max(0, Math.abs(x - cx) - hw);
    const dz = Math.max(0, Math.abs(z - cz) - hd);
    const dist = Math.hypot(dx, dz);
    if (dist < 2.5) f *= smooth(dist / 2.5);
  }
  return f;
}

// The arena no longer has perimeter walls, so terrain relief continues right
// out to (and past) the edge into the backdrop — only the pads flatten it.
function shapeFade(x: number, z: number): number {
  return padFade(x, z);
}

// Roads flatten the terrain toward a smooth piecewise-linear profile within a
// falloff band — the same trick the pads use, so the road surface, its
// collision mesh, and bot nav stay consistent (everything reads heightAt).
function roadFieldAt(x: number, z: number): { w: number; targetY: number } {
  let bestD = Infinity;
  let bestT = 0;
  let bestSeg: RoadSeg | null = null;
  for (const s of ROAD_SEGS) {
    if (x < Math.min(s.ax, s.bx) - 9 || x > Math.max(s.ax, s.bx) + 9) continue;
    if (z < Math.min(s.az, s.bz) - 9 || z > Math.max(s.az, s.bz) + 9) continue;
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2));
    const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
    if (d < bestD) {
      bestD = d;
      bestT = t;
      bestSeg = s;
    }
  }
  if (!bestSeg) return { w: 0, targetY: 0 };
  const band = 2.5;
  if (bestD > bestSeg.half + band) return { w: 0, targetY: 0 };
  const targetY = bestSeg.ay + (bestSeg.by - bestSeg.ay) * bestT;
  const edge = bestD <= bestSeg.half ? 1 : smooth(1 - (bestD - bestSeg.half) / band);
  return { w: edge * padFade(x, z), targetY }; // pads win over roads
}

// Road surface at (x,z): 0 = off-road, else the nearest road's half-width
// (so callers can tell the wide cobbled main road from narrow dirt lanes, and
// `onRoad(x,z) > 0` still reads as "is road"). Road colour is baked straight
// into the terrain mesh from this — no overlay, so no z-fighting.
export function onRoad(x: number, z: number): number {
  for (const s of ROAD_SEGS) {
    if (x < Math.min(s.ax, s.bx) - 6 || x > Math.max(s.ax, s.bx) + 6) continue;
    if (z < Math.min(s.az, s.bz) - 6 || z > Math.max(s.az, s.bz) + 6) continue;
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2));
    const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
    if (d < s.half + 0.5) return s.half;
  }
  return 0;
}

// Road paint weight at (x,z): 1 on the road, feathering to 0 across a short
// verge, plus whether it's the wide cobbled main road. Mirrors roadFieldAt's
// footprint so the painted surface lines up with the flattened terrain — the
// client bakes this straight into the terrain faces (no overlay, no z-fight).
export function roadAt(x: number, z: number): { w: number; cobble: boolean } {
  let best = Infinity;
  let bestSeg: RoadSeg | null = null;
  for (const s of ROAD_SEGS) {
    if (x < Math.min(s.ax, s.bx) - 6 || x > Math.max(s.ax, s.bx) + 6) continue;
    if (z < Math.min(s.az, s.bz) - 6 || z > Math.max(s.az, s.bz) + 6) continue;
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2));
    const d = Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
    if (d < best) {
      best = d;
      bestSeg = s;
    }
  }
  if (!bestSeg) return { w: 0, cobble: false };
  const verge = 0.7;
  const w = best <= bestSeg.half ? 1 : Math.max(0, 1 - (best - bestSeg.half) / verge);
  return { w: w * padFade(x, z), cobble: bestSeg.half > 3 };
}

// --- Water: one meandering river plus a couple of lakes, carved into the
// base terrain (scaled by shapeFade, so building pads become natural fords
// and the water never undermines a structure). Wadeable: max ~1.1m deep.

export const WATER_SURFACE_Y = -0.22;
const WATER_DEPTH = 1.3;
const RIVER_HALF_WIDTH = 7.5;

// River centerline: a non-periodic meander from low-frequency value noise.
// (A sum of sines reads as a regular wave; layered noise wanders like a real
// river.) The width breathes along its length, widening into pools and
// pinching at riffles.
function riverCenterZ(x: number): number {
  // Kept to a ~z[25,43] band so it cleanly separates the south-bank village
  // from the north fields/hamlets, with a gentle two-octave wander.
  return 34 + 12 * (valueNoise(x + 600, 0, 118) - 0.5) + 5 * (valueNoise(x + 1700, 0, 44) - 0.5);
}
function riverHalfWidthAt(x: number): number {
  return RIVER_HALF_WIDTH * (0.62 + 0.7 * valueNoise(x + 1234, 0, 40));
}

// River polyline: [x, centerZ, halfWidth], sampled densely (and a little past
// each edge) so the nearest-point distance is smooth.
const RIVER_PTS: Array<[number, number, number]> = [];
for (let x = -SIZE / 2 - 8; x <= SIZE / 2 + 8; x += 3) {
  RIVER_PTS.push([x, riverCenterZ(x), riverHalfWidthAt(x)]);
}

const LAKES: Array<[number, number, number, number]> = [
  // [cx, cz, rx, rz]
  [-80, -64, 16, 12],
  [90, -42, 13, 10],
];

// Channel cross-section as a function of normalized distance from the
// centerline (t = dist/halfWidth): a flat thalweg, steep cut banks, then a
// slightly raised levee at the lip (the small negative lobe). The levee is what
// sells "carved" — real rivers throw up bank berms that catch the light, where
// a lone smoothstep just paints a round trough.
function channelProfile(t: number): number {
  if (t < 0.5) return 1; // flat bed
  if (t < 0.9) return smooth((0.9 - t) / 0.4); // steep banks
  if (t < 1.4) return -0.05 * smooth((t - 0.9) / 0.5) * smooth((1.4 - t) / 0.5); // levee berm
  return 0;
}

// How deep the water carve is at (x,z), before pad/road fading. >0 digs the
// channel or a lake; the small <0 lip raises a bank berm. 0 = untouched land.
export function waterCarveAt(x: number, z: number): number {
  let best = Infinity;
  let bestHalf = RIVER_HALF_WIDTH;
  for (const [px, pz, ph] of RIVER_PTS) {
    if (Math.abs(px - x) > 16) continue;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bestHalf = ph;
    }
  }
  let dug = 0;
  if (best < bestHalf * 1.4) {
    dug = channelProfile(best / bestHalf) * WATER_DEPTH;
    // Gravel-bar roughness so the bed isn't glassy flat (positive carve only).
    if (dug > 0) dug *= 1 + 0.12 * (valueNoise(x + 5000, z + 5000, 3.5) - 0.5);
  }
  for (const [cx, cz, rx, rz] of LAKES) {
    const e = Math.hypot((x - cx) / rx, (z - cz) / rz);
    if (e < 1) dug = Math.max(dug, smooth(1 - e) * WATER_DEPTH);
  }
  return dug;
}

// The pre-road terrain: noise relief minus the water carve, both flattened
// inside pads. Road baking samples THIS (so it never recurses into itself).
function terrainBase(x: number, z: number): number {
  const raw = valueNoise(x + 1000, z + 1000, 14) * 0.7 + valueNoise(x + 2000, z + 2000, 5.5) * 0.3;
  const fade = shapeFade(x, z);
  return raw * TERRAIN_AMPLITUDE * fade - waterCarveAt(x, z) * fade;
}

// The pristine pre-battle terrain, with roads/paths flattened in. Structure
// generation seats pieces on this, so later craters never move existing
// geometry.
export function baseHeightAt(x: number, z: number): number {
  const h = terrainBase(x, z);
  if (ROAD_SEGS.length === 0) return h;
  const r = roadFieldAt(x, z);
  return r.w > 0 ? h + (r.targetY - h) * r.w : h;
}

// ---------------------------------------------------------------------------
// Terrain destruction: explosions dig craters. The crater list is shared
// state that client and server keep in sync over reliable messages (the
// server is authoritative; clients apply craters as they arrive and receive
// the full list in the welcome). heightAt = base terrain minus crater bowls.

export interface Crater {
  x: number;
  z: number;
  r: number;
  d: number;
}

let craters: Crater[] = [];

export function resetCraters(): void {
  craters = [];
}

export function addCrater(c: Crater): void {
  craters.push(c);
}

export function craterList(): readonly Crater[] {
  return craters;
}

export function heightAt(x: number, z: number): number {
  let h = baseHeightAt(x, z);
  let dug = 0;
  for (const c of craters) {
    const dist = Math.hypot(x - c.x, z - c.z);
    if (dist < c.r) dug += c.d * smooth(1 - dist / c.r);
  }
  // Craters respect pads/perimeter and can't dig to bedrock no matter how
  // many grenades stack.
  return h - Math.min(2.0, dug * shapeFade(x, z));
}

// Triangle grids for the physics mesh, in chunks so a crater only rebuilds
// the tiles it touches. The client renders its own geometry from the same
// heightAt, so collision matches visuals exactly.
export const TERRAIN_CELL = 1;
export const TERRAIN_CHUNK = 14; // 6x6 chunks
export const TERRAIN_CHUNKS = SIZE / TERRAIN_CHUNK;

export function terrainChunkMesh(
  ci: number,
  cj: number,
): { vertices: number[]; indices: number[] } {
  const x0 = -SIZE / 2 + ci * TERRAIN_CHUNK;
  const z0 = -SIZE / 2 + cj * TERRAIN_CHUNK;
  const n = TERRAIN_CHUNK / TERRAIN_CELL;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const x = x0 + ix * TERRAIN_CELL;
      const z = z0 + iz * TERRAIN_CELL;
      vertices.push(x, heightAt(x, z), z);
    }
  }
  const stride = n + 1;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const a = iz * stride + ix;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return { vertices, indices };
}

// ---------------------------------------------------------------------------
// World extent. The core (±SIZE/2) is the detailed, collidable, cratereable
// arena. Beyond it the world continues as an apron (still collidable, so a
// player who strays out during the out-of-bounds countdown stands on real
// ground) and then a visual-only backdrop that melts into the fog. There are
// no perimeter walls; PLAY_HALF is the soft boundary the OOB timer enforces.
export const PLAY_HALF = 108; // |x| or |z| beyond this = out of bounds
export const APRON_OUTER = 184; // collidable apron extends to here
export const BACKDROP_OUTER = 320; // visual-only backdrop to here (fog hides the edge)

// A ring of coarse terrain tiles between `inner` and `outer` half-extents
// (square hole = the core), sampled from the pristine terrain. Used for both
// the collidable apron and the visual backdrop.
export function ringMesh(
  inner: number,
  outer: number,
  cell: number,
): { vertices: number[]; indices: number[] } {
  const vertices: number[] = [];
  const indices: number[] = [];
  const n = Math.ceil((outer * 2) / cell);
  let vi = 0;
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x0 = -outer + ix * cell;
      const z0 = -outer + iz * cell;
      const x1 = x0 + cell;
      const z1 = z0 + cell;
      // Skip cells fully inside the core hole.
      if (Math.abs(x0 + cell / 2) < inner && Math.abs(z0 + cell / 2) < inner) continue;
      vertices.push(
        x0,
        baseHeightAt(x0, z0),
        z0,
        x1,
        baseHeightAt(x1, z0),
        z0,
        x0,
        baseHeightAt(x0, z1),
        z1,
        x1,
        baseHeightAt(x1, z1),
        z1,
      );
      indices.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
      vi += 4;
    }
  }
  return { vertices, indices };
}

// Chunk indices whose tile intersects the crater's footprint.
export function chunksTouching(c: Crater): Array<[number, number]> {
  const half = SIZE / 2;
  const lo = (v: number) => Math.max(0, Math.floor((v + half) / TERRAIN_CHUNK));
  const hi = (v: number) => Math.min(TERRAIN_CHUNKS - 1, Math.floor((v + half) / TERRAIN_CHUNK));
  const out: Array<[number, number]> = [];
  for (let ci = lo(c.x - c.r); ci <= hi(c.x + c.r); ci++) {
    for (let cj = lo(c.z - c.r); cj <= hi(c.z + c.r); cj++) out.push([ci, cj]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structure generation.

let nextPanelId = 1;
let nextBuildingId = 0;

interface Gen {
  statics: StaticBox[];
  panels: PanelDef[];
  buildings: BuildingDef[];
  slabs: Slab[];
  ladders: LadderDef[];
}

// Close a slab over every piece generated since `first` (ids are sequential).
function endSlab(g: Gen, first: number): void {
  if (nextPanelId > first) g.slabs.push({ first, last: nextPanelId - 1 });
}

// A wall opening: along-axis interval + height range.
interface GapRect {
  lo: number;
  hi: number;
  y0: number;
  y1: number;
}

// Cut a masonry piece against wall openings. Fragments that survive outside
// the opening become the cut bricks you see around a real doorway.
function clipAgainstGaps(
  c: number,
  l: number,
  y: number,
  h: number,
  gaps: GapRect[],
): Array<[number, number]> {
  let frags: Array<[number, number]> = [[c - l / 2, c + l / 2]];
  for (const gap of gaps) {
    if (y + h / 2 <= gap.y0 || y - h / 2 >= gap.y1) continue;
    const next: Array<[number, number]> = [];
    for (const [lo, hi] of frags) {
      if (hi <= gap.lo || lo >= gap.hi) {
        next.push([lo, hi]);
        continue;
      }
      // Keep even thin cut fragments: every course then ends exactly at the
      // opening's edge, which keeps jambs straight (and lets the collision
      // merger stack courses into single boxes).
      if (gap.lo - lo >= 0.08) next.push([lo, gap.lo]);
      if (hi - gap.hi >= 0.08) next.push([gap.hi, hi]);
    }
    frags = next;
  }
  return frags.map(([lo, hi]) => [(lo + hi) / 2, hi - lo]);
}

// A run of stacked masonry: `rows` courses of `unit`-sized pieces between
// a0..a1 along the given axis, odd courses offset half a unit (running bond)
// with half pieces closing the ends.
function masonryRun(
  g: Gen,
  axis: "x" | "z",
  a0: number,
  a1: number,
  fixed: number,
  baseY: number,
  rows: number,
  unit: { l: number; h: number; t: number },
  material: PanelMaterial,
  buildingId: number | undefined,
  gaps: GapRect[] = [],
): void {
  const slabFirst = nextPanelId;
  const n = Math.round((a1 - a0) / unit.l);
  for (let row = 0; row < rows; row++) {
    const y = baseY + (row + 0.5) * unit.h;
    const segs: Array<[number, number]> = [];
    if (row % 2 === 0) {
      for (let i = 0; i < n; i++) segs.push([a0 + (i + 0.5) * unit.l, unit.l]);
    } else {
      segs.push([a0 + unit.l / 4, unit.l / 2]);
      for (let i = 0; i < n - 1; i++) segs.push([a0 + unit.l / 2 + (i + 0.5) * unit.l, unit.l]);
      segs.push([a1 - unit.l / 4, unit.l / 2]);
    }
    for (const [c, l] of segs) {
      for (const [fc, fl] of clipAgainstGaps(c, l, y, unit.h, gaps)) {
        g.panels.push({
          id: nextPanelId++,
          x: axis === "x" ? fc : fixed,
          y,
          z: axis === "x" ? fixed : fc,
          ex: axis === "x" ? fl : unit.t,
          ey: unit.h,
          ez: axis === "x" ? unit.t : fl,
          material,
          buildingId,
        });
      }
    }
  }
  endSlab(g, slabFirst);
}

// An interior partition wall: a cut running along `axis` at the fixed
// cross-coordinate, spanning [lo,hi].
interface InteriorWall {
  axis: "x" | "z";
  fixed: number;
  lo: number;
  hi: number;
}

// Slice-BSP of an interior rectangle into rooms; returns the internal walls
// (the cuts). The cut hierarchy is a TREE, so emitting one doorway per wall
// already makes every room reachable — no separate connectivity pass needed.
// `cx,cz` are the building center; cuts steer clear of the exterior walls'
// centered window/door openings so interior walls never butt into a window.
function partitionInterior(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  cx: number,
  cz: number,
  rng: () => number,
): InteriorWall[] {
  const MIN = 3.0; // smallest room dimension (clear)
  const out: InteriorWall[] = [];
  const snap = (v: number): number => Math.round(v / 0.5) * 0.5;
  const avoid = (pos: number, center: number, lo: number, hi: number): number => {
    if (Math.abs(pos - center) >= 1.3) return pos;
    const pushed = pos < center ? center - 1.3 : center + 1.3;
    return Math.max(lo, Math.min(hi, pushed));
  };
  const rec = (ax0: number, az0: number, ax1: number, az1: number, depth: number): void => {
    const w = ax1 - ax0;
    const d = az1 - az0;
    if (Math.max(w, d) < 2 * MIN) return;
    if (depth >= 1 && rng() < 0.18 * depth) return; // stochastic stop -> varied room counts
    let splitX = w >= d;
    if (Math.abs(w - d) < 1.2) splitX = rng() < 0.5;
    if (splitX && w < 2 * MIN) splitX = false;
    if (!splitX && d < 2 * MIN) splitX = true;
    if (splitX) {
      const lo = ax0 + MIN;
      const hi = ax1 - MIN;
      if (hi <= lo) return;
      let pos = snap(lo + (hi - lo) * (0.5 + (rng() - 0.5) * 0.5));
      pos = avoid(Math.max(lo, Math.min(hi, pos)), cx, lo, hi);
      out.push({ axis: "z", fixed: pos, lo: az0, hi: az1 });
      rec(ax0, az0, pos, az1, depth + 1);
      rec(pos, az0, ax1, az1, depth + 1);
    } else {
      const lo = az0 + MIN;
      const hi = az1 - MIN;
      if (hi <= lo) return;
      let pos = snap(lo + (hi - lo) * (0.5 + (rng() - 0.5) * 0.5));
      pos = avoid(Math.max(lo, Math.min(hi, pos)), cz, lo, hi);
      out.push({ axis: "x", fixed: pos, lo: ax0, hi: ax1 });
      rec(ax0, az0, ax1, pos, depth + 1);
      rec(ax0, pos, ax1, az1, depth + 1);
    }
  };
  rec(x0, z0, x1, z1, 0);
  return out;
}

export type BuildingStyle = "brick" | "log" | "concrete";

export interface BuildingOpts {
  stories: number;
  style: BuildingStyle;
  doorSides: ReadonlyArray<0 | 1 | 2 | 3>; // some houses have several doors
  roof: "flat" | "gable";
  ladder: boolean; // exterior step-ladder to the roof/eaves
  rng: () => number;
}

const GABLE_RISE = 0.25;
const ROOF_STEP_H = 0.32; // chunky stepped-roof strips (and they bond)

function building(g: Gen, cx: number, cz: number, w: number, d: number, o: BuildingOpts): void {
  const { stories, style } = o;
  // The stairwell hugs the west wall (side 3): a door there would open
  // straight under the flights with head-crush clearance. Multi-story
  // buildings relocate west doors to the first free wall.
  let doorSides = [...o.doorSides];
  if (stories > 1 && doorSides.includes(3)) {
    doorSides = doorSides.filter((s) => s !== 3);
    for (const alt of [1, 0, 2] as const) {
      if (!doorSides.includes(alt)) {
        doorSides.push(alt);
        break;
      }
    }
  }
  const id = nextBuildingId++;
  const firstPanel = nextPanelId;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const unit = style === "brick" ? BRICK : style === "log" ? LOG : CONCRETE;
  const rowsPerStory = Math.round(WALL_HEIGHT / unit.h);
  const height = stories * WALL_HEIGHT;

  // Gable geometry: a stepped roof rising toward a ridge along the long
  // axis; the two end walls grow stepped masonry triangles up to the ridge.
  const gable = o.roof === "gable";
  const ridgeAlongX = w >= d;
  const span = ridgeAlongX ? d : w;
  const gSteps = gable ? Math.round(span / 2 / PLANK.w) : 0; // per side
  const peak = gSteps * GABLE_RISE;

  // Door: 1.3m x 2.05m, centered, ground floor only. Windows: 2.1m wide at
  // sill height on the other ground walls and on EVERY upper-story wall.
  // Pieces are clipped, so brick walls get cut bricks around openings and
  // log walls get sawed log ends.
  const door = (mid: number): GapRect[] => [{ lo: mid - 0.65, hi: mid + 0.65, y0: 0, y1: 2.05 }];
  const win = (mid: number, baseY: number): GapRect[] => [
    { lo: mid - 1.05, hi: mid + 1.05, y0: baseY + 1.3, y1: baseY + 2.05 },
  ];
  const glassIds: number[] = [];
  const pane = (axis: "x" | "z", mid: number, fixed: number, baseY: number): void => {
    const slabFirst = nextPanelId;
    glassIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: axis === "x" ? mid : fixed,
      y: baseY + (1.3 + 2.05) / 2,
      z: axis === "x" ? fixed : mid,
      ex: axis === "x" ? 2.1 : 0.06,
      ey: 2.05 - 1.3,
      ez: axis === "x" ? 0.06 : 2.1,
      material: "glass",
      buildingId: id,
    });
    endSlab(g, slabFirst);
  };

  // Everything above the stepped roofline of a gable end is sky.
  const gableGaps = (mid: number): GapRect[] => {
    const gaps: GapRect[] = [];
    for (let j = 0; j <= gSteps; j++) {
      const keep = span / 2 - j * PLANK.w;
      const y0 = height + j * GABLE_RISE;
      const y1 = j === gSteps ? height + peak + 3 : y0 + GABLE_RISE;
      gaps.push({ lo: -1e9, hi: mid - keep, y0, y1 });
      gaps.push({ lo: mid + keep, hi: 1e9, y0, y1 });
    }
    return gaps;
  };

  // Balcony: some upper stories open onto a railed platform (never on the
  // stairwell wall — its floor column is open there).
  const balcony =
    stories > 1 && o.rng() < 0.55
      ? {
          story: 1 + Math.floor(o.rng() * (stories - 1)),
          side: [0, 1, 2][Math.floor(o.rng() * 3)],
        }
      : null;

  const walls: Array<[axis: "x" | "z", mid: number, fixed: number]> = [
    ["x", cx, z1],
    ["x", cx, z0],
    ["z", cz, x1],
    ["z", cz, x0],
  ];
  for (let story = 0; story < stories; story++) {
    const baseY = story * WALL_HEIGHT;
    for (let side = 0; side < 4; side++) {
      const [axis, mid, fixed] = walls[side];
      const a0 = axis === "x" ? x0 : z0;
      const a1 = axis === "x" ? x1 : z1;
      const hasDoor = story === 0 && doorSides.includes(side as 0 | 1 | 2 | 3);
      const hasBalconyDoor = balcony !== null && balcony.story === story && balcony.side === side;
      const gaps = hasDoor
        ? door(mid)
        : hasBalconyDoor
          ? [{ lo: mid - 0.65, hi: mid + 0.65, y0: baseY, y1: baseY + 2.05 }]
          : win(mid, baseY);
      masonryRun(g, axis, a0, a1, fixed, baseY, rowsPerStory, unit, style, id, gaps);
      if (!hasDoor && !hasBalconyDoor) pane(axis, mid, fixed, baseY);
    }
  }
  // Gable-end triangles continue the wall masonry above the top plate.
  if (gable) {
    const ends: number[] = ridgeAlongX ? [2, 3] : [0, 1];
    for (const side of ends) {
      const [axis, mid, fixed] = walls[side];
      const a0 = axis === "x" ? x0 : z0;
      const a1 = axis === "x" ? x1 : z1;
      masonryRun(
        g,
        axis,
        a0,
        a1,
        fixed,
        height,
        Math.ceil(peak / unit.h),
        unit,
        style,
        id,
        gableGaps(mid),
      );
    }
  }

  // Structural corner posts — destructible like everything else, just tough.
  const postsFirst = nextPanelId;
  for (const [px, pz] of [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ]) {
    g.panels.push({
      id: nextPanelId++,
      x: px,
      y: height / 2,
      z: pz,
      ex: 0.3,
      ey: height,
      ez: 0.3,
      material: "post",
      buildingId: id,
    });
  }
  endSlab(g, postsFirst);

  // The stairwell (multi-story only): a TWO-LANE column along the west wall
  // — flights alternate lanes side by side so there's always full story
  // headroom. Flat roofs get a final flight out a roof hole; gabled roofs
  // rely on exterior ladders instead.
  const roofIds: number[] = [];
  const roofExit = stories > 1 && !gable;
  const flights = stories > 1 ? stories - 1 + (roofExit ? 1 : 0) : 0;
  const stairHole: GapRect | null =
    stories > 1 ? { lo: x0 + 0.55, hi: x0 + 2.85, y0: z0 + 1.0, y1: z0 + 5.35 } : null;
  const STAIR_RISE = WALL_HEIGHT / 10;
  const STAIR_RUN = 0.42;
  for (let flight = 0; flight < flights; flight++) {
    const flightFirst = nextPanelId;
    const baseY = flight * WALL_HEIGHT;
    const up = flight % 2 === 0; // alternate direction AND lane per flight
    const laneX = x0 + (up ? 1.12 : 2.27);
    for (let k = 0; k < 10; k++) {
      const z = up ? z0 + 1.3 + k * STAIR_RUN : z0 + 5.05 - k * STAIR_RUN;
      roofIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: laneX,
        y: baseY + (k + 1) * STAIR_RISE - 0.06,
        z,
        ex: 1.05,
        ey: 0.12,
        ez: 0.5,
        material: "stair",
        buildingId: id,
      });
    }
    endSlab(g, flightFirst);
  }

  // Ground floor: a flat, walkable surface so interiors read as rooms, not open
  // dirt — stone flagstones for masonry houses, board planks for log cabins.
  // (The pad under every building is flattened, so this sits flush.)
  {
    const floorFirst = nextPanelId;
    const wood = style === "log";
    const tlen = wood ? 1.8 : 1.4;
    const twid = wood ? 1.2 : 1.4;
    const th = wood ? 0.1 : 0.14;
    const fy = th / 2 + 0.03;
    const nfx = Math.max(1, Math.round(w / tlen));
    const nfz = Math.max(1, Math.round(d / twid));
    const tx = w / nfx;
    const tz = d / nfz;
    for (let iz = 0; iz < nfz; iz++) {
      for (let ix = 0; ix < nfx; ix++) {
        roofIds.push(nextPanelId);
        g.panels.push({
          id: nextPanelId++,
          x: x0 + (ix + 0.5) * tx,
          y: fy,
          z: z0 + (iz + 0.5) * tz,
          ex: tx - 0.03,
          ey: th,
          ez: tz - 0.03,
          material: wood ? "plank" : "stone",
          buildingId: id,
        });
      }
    }
    endSlab(g, floorFirst);
  }

  // Floors between stories (and the roof sheet when flat): staggered planks
  // laid across the footprint; the stairwell column stays open on floors,
  // and on the roof only when the stairs exit there.
  const strips = Math.round(d / PLANK.w);
  const npl = Math.round(w / PLANK.l);
  for (let level = 1; level <= stories; level++) {
    const isRoof = level === stories;
    if (isRoof && gable) break; // the gable strips replace the flat sheet
    const levelFirst = nextPanelId;
    const y = level * WALL_HEIGHT + PLANK.h / 2;
    const holeHere = stairHole !== null && (!isRoof || roofExit);
    for (let s = 0; s < strips; s++) {
      const z = z0 + (s + 0.5) * PLANK.w;
      const inHoleZ = holeHere && stairHole !== null && z > stairHole.y0 && z < stairHole.y1;
      const segs: Array<[number, number]> = [];
      if (s % 2 === 0) {
        for (let i = 0; i < npl; i++) segs.push([x0 + (i + 0.5) * PLANK.l, PLANK.l]);
      } else {
        segs.push([x0 + PLANK.l / 4, PLANK.l / 2]);
        for (let i = 0; i < npl - 1; i++) {
          segs.push([x0 + PLANK.l / 2 + (i + 0.5) * PLANK.l, PLANK.l]);
        }
        segs.push([x1 - PLANK.l / 4, PLANK.l / 2]);
      }
      for (const [c, l] of segs) {
        const frags =
          inHoleZ && stairHole !== null
            ? clipAgainstGaps(c, l, 0.5, 1, [{ lo: stairHole.lo, hi: stairHole.hi, y0: 0, y1: 1 }])
            : ([[c, l]] as Array<[number, number]>);
        for (const [fc, fl] of frags) {
          roofIds.push(nextPanelId);
          g.panels.push({
            id: nextPanelId++,
            x: fc,
            y,
            z,
            ex: fl,
            ey: PLANK.h,
            ez: PLANK.w,
            material: "plank",
            buildingId: id,
          });
        }
      }
    }
    endSlab(g, levelFirst);
  }

  // Interior partition: each story is carved into rooms with doorways. On
  // multi-story buildings the stairwell column (west) is left open as a hall —
  // the partition only divides the area east of it, so no cut crosses the
  // flights. The same plan repeats per story, so interior walls stack and stay
  // structurally bonded. One doorway per cut already connects every room (the
  // cut hierarchy is a tree), and a few wide walls get a second for flanking.
  {
    const inset = unit.t / 2 + 0.03;
    const iz0 = z0 + inset;
    const iz1 = z1 - inset;
    const ix1 = x1 - inset;
    const rx0 = (stories > 1 ? x0 + 3.4 : x0) + inset;
    const roomWalls = partitionInterior(rx0, iz0, ix1, iz1, cx, cz, o.rng);
    const doorGap = (mid: number, baseY: number): GapRect => ({
      lo: mid - 0.55,
      hi: mid + 0.55,
      y0: baseY,
      y1: baseY + 2.05,
    });
    for (let story = 0; story < stories; story++) {
      const baseY = story * WALL_HEIGHT;
      for (const wseg of roomWalls) {
        const span = wseg.hi - wseg.lo;
        if (span < 1.8) continue;
        const gaps: GapRect[] = [doorGap(wseg.lo + 0.8 + o.rng() * (span - 1.6), baseY)];
        if (span > 6.5 && o.rng() < 0.35) {
          gaps.push(doorGap(wseg.lo + 0.8 + o.rng() * (span - 1.6), baseY));
        }
        masonryRun(
          g,
          wseg.axis,
          wseg.lo,
          wseg.hi,
          wseg.fixed,
          baseY,
          rowsPerStory,
          unit,
          style,
          id,
          gaps,
        );
      }
    }
  }

  // Balcony platform + solid parapet (good cover up there).
  if (balcony !== null) {
    const balconyFirst = nextPanelId;
    const [axis, mid, fixed] = walls[balcony.side];
    const outSign = balcony.side === 0 || balcony.side === 2 ? 1 : -1;
    const baseY = balcony.story * WALL_HEIGHT;
    const platformY = baseY + 0.05;
    const emit = (px: number, py: number, pz: number, ex: number, ey: number, ez: number): void => {
      roofIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: px,
        y: py,
        z: pz,
        ex,
        ey,
        ez,
        material: "plank",
        buildingId: id,
      });
    };
    for (const out of [0.45, 1.05]) {
      const off = fixed + outSign * (unit.t / 2 + out);
      if (axis === "x") emit(mid, platformY, off, 2.6, 0.1, 0.7);
      else emit(off, platformY, mid, 0.7, 0.1, 2.6);
    }
    // Parapet: front + two sides, hip height.
    const railY = baseY + 0.45;
    const frontOff = fixed + outSign * (unit.t / 2 + 1.42);
    if (axis === "x") {
      emit(mid, railY, frontOff, 2.84, 0.7, 0.12);
      for (const s of [-1, 1]) {
        emit(mid + s * 1.36, railY, fixed + outSign * (unit.t / 2 + 0.7), 0.12, 0.7, 1.4);
      }
    } else {
      emit(frontOff, railY, mid, 0.12, 0.7, 2.84);
      for (const s of [-1, 1]) {
        emit(fixed + outSign * (unit.t / 2 + 0.7), railY, mid + s * 1.36, 1.4, 0.7, 0.12);
      }
    }
    endSlab(g, balconyFirst);
  }

  // Gabled roof: chunky stepped strips climbing to the ridge from both
  // eaves, walkable like stairs once you're up there.
  if (gable) {
    const roofFirst = nextPanelId;
    const along0 = ridgeAlongX ? x0 : z0;
    const along1 = ridgeAlongX ? x1 : z1;
    const crossBase = ridgeAlongX ? z0 : x0;
    const nAlong = Math.round((along1 - along0) / PLANK.l);
    const strip = (cross: number, y: number): void => {
      const segs: Array<[number, number]> = [];
      for (let i = 0; i < nAlong; i++) segs.push([along0 + (i + 0.5) * PLANK.l, PLANK.l]);
      for (const [c, l] of segs) {
        roofIds.push(nextPanelId);
        g.panels.push({
          id: nextPanelId++,
          x: ridgeAlongX ? c : cross,
          y,
          z: ridgeAlongX ? cross : c,
          ex: ridgeAlongX ? l : PLANK.w,
          ey: ROOF_STEP_H,
          ez: ridgeAlongX ? PLANK.w : l,
          material: "plank",
          buildingId: id,
        });
      }
    };
    for (let i = 0; i < gSteps; i++) {
      const y = height + i * GABLE_RISE + ROOF_STEP_H / 2;
      strip(crossBase + (i + 0.5) * PLANK.w, y);
      strip(crossBase + span - (i + 0.5) * PLANK.w, y);
    }
    endSlab(g, roofFirst);
  }

  // Exterior ladder up a doorless wall: a REAL climbable ladder (vertical
  // volume the shared controller climbs), placed near a corner, never on
  // the balcony's wall. Reaches the roof on flat buildings, the eaves on
  // gabled ones — from where the stepped roof is walkable.
  if (o.ladder) {
    const eaveSides = gable ? (ridgeAlongX ? [0, 1] : [2, 3]) : [0, 1, 2, 3];
    const candidates = eaveSides.filter(
      (s) => !doorSides.includes(s as 0 | 1 | 2 | 3) && (balcony === null || balcony.side !== s),
    );
    if (candidates.length > 0) {
      const side = candidates[Math.floor(o.rng() * candidates.length)];
      const [axis, , fixed] = walls[side];
      const a0 = axis === "x" ? x0 : z0;
      const a1 = axis === "x" ? x1 : z1;
      const outSign = side === 0 || side === 2 ? 1 : -1;
      const along = o.rng() < 0.5 ? a0 + 1.2 : a1 - 1.2;
      const face = fixed + outSign * (unit.t / 2);
      g.ladders.push({
        x: axis === "x" ? along : face,
        z: axis === "x" ? face : along,
        nx: axis === "x" ? 0 : outSign,
        nz: axis === "x" ? outSign : 0,
        y1: height + 0.5,
      });
    }
  }

  const mine = g.panels.filter((p) => p.id >= firstPanel);
  g.buildings.push({
    id,
    kind: "building",
    cx,
    cz,
    w,
    d,
    wallPanelIds: mine
      .filter(
        (p) =>
          p.material !== "plank" &&
          p.material !== "glass" &&
          p.material !== "stone" &&
          p.material !== "stair",
      )
      .map((p) => p.id),
    roofPanelIds: [...roofIds, ...glassIds],
    // Higher than before the release cascade existed: walls now genuinely
    // shed their unsupported pieces, so integrity loss accrues much faster.
    collapseFraction: 0.5,
  });
}

// Procedural trees, two species. Oaks: a stout trunk with a clustered cube
// crown. Pines: a tall thin trunk with stacked, shrinking foliage tiers.
// Either way the trunk is the structure — break two segments and it falls.
function tree(g: Gen, x: number, z: number, rng: () => number): void {
  const slabFirst = nextPanelId;
  const id = nextBuildingId++;
  const base = baseHeightAt(x, z);
  const pine = rng() < 0.4;
  const SEG = 0.8;
  const segs = pine ? 4 + Math.floor(rng() * 3) : 3 + Math.floor(rng() * 3); // 4-6 / 3-5
  const girth = pine ? 0.3 + rng() * 0.1 : 0.42 + rng() * 0.14;
  const trunkIds: number[] = [];
  for (let seg = 0; seg < segs; seg++) {
    trunkIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x,
      y: base + (seg + 0.5) * SEG,
      z,
      ex: girth,
      ey: SEG,
      ez: girth,
      material: "trunk",
      buildingId: id,
    });
  }
  const top = base + segs * SEG;
  const canopyIds: number[] = [];
  const clump = (cx: number, cy: number, cz: number, ex: number, ey: number, ez: number) => {
    canopyIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: cx,
      y: cy,
      z: cz,
      ex,
      ey,
      ez,
      material: "canopy",
      buildingId: id,
    });
  };
  if (pine) {
    // Stacked shrinking tiers starting partway up the trunk.
    const tiers = 3 + Math.floor(rng() * 2);
    for (let t = 0; t < tiers; t++) {
      const f = 1 - t / tiers;
      const s = 0.9 + 1.5 * f;
      clump(x, top - (tiers - 1 - t) * 0.85 - 0.2, z, s, 0.7, s);
    }
    clump(x, top + 0.55, z, 0.7, 0.8, 0.7); // tip
  } else {
    // A crown cube plus 4-6 satellite cubes packed around it.
    clump(x, top + 0.55, z, 1.6 + rng() * 0.5, 1.4, 1.6 + rng() * 0.5);
    const n = 4 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const ang = rng() * Math.PI * 2;
      const r = 0.7 + rng() * 0.5;
      const s = 0.9 + rng() * 0.7;
      clump(x + Math.sin(ang) * r, top - 0.3 + rng() * 0.8, z + Math.cos(ang) * r, s, s * 0.85, s);
    }
  }
  g.buildings.push({
    id,
    kind: "tree",
    cx: x,
    cz: z,
    w: 0.9,
    d: 0.9,
    wallPanelIds: trunkIds,
    roofPanelIds: canopyIds,
    // ceil(segs * 1.5/segs) = 2 exactly: two trunk segments fell it.
    collapseFraction: 1.5 / segs,
  });
  endSlab(g, slabFirst);
}

// Boulder clusters: 1-3 destructible rocks, partially sunk into the ground.
function rocks(g: Gen, x: number, z: number, rng: () => number): void {
  const slabFirst = nextPanelId;
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const ox = i === 0 ? 0 : (rng() - 0.5) * 2.4;
    const oz = i === 0 ? 0 : (rng() - 0.5) * 2.4;
    const s = i === 0 ? 0.9 + rng() * 0.8 : 0.4 + rng() * 0.5;
    const ey = s * (0.7 + rng() * 0.3);
    g.panels.push({
      id: nextPanelId++,
      x: x + ox,
      y: baseHeightAt(x + ox, z + oz) + ey * 0.32,
      z: z + oz,
      ex: s,
      ey,
      ez: s * (0.8 + rng() * 0.4),
      material: "rock",
    });
  }
  endSlab(g, slabFirst);
}

// ---------------------------------------------------------------------------
// Layout: a settlement of varied clusters — one true village (a market plaza
// and the biggest buildings) plus plain hamlets and lone farmsteads, so not
// every cluster is a village and not every one has a plaza — wired together by
// a road network. Buildings front the streets; a road fords the river where it
// crosses. Fully deterministic from the map seed.

interface LotPlan {
  cx: number;
  cz: number;
  w: number;
  d: number;
  front: 0 | 1 | 2 | 3;
  stories: number;
  style: BuildingStyle;
  roof: "flat" | "gable";
  ladder: boolean;
}

interface Layout {
  lots: LotPlan[];
  zones: Array<{ letter: string; x: number; z: number; r: number }>;
  stalls: Array<[number, number]>;
}

let LAYOUT: Layout = { lots: [], zones: [], stalls: [] };

function planLayout(rng: () => number): Layout {
  const half = SIZE / 2;
  const pads: Array<[number, number, number, number]> = [];
  const lots: LotPlan[] = [];
  const stalls: Array<[number, number]> = [];
  const nodes: Array<[number, number]> = [];
  const localStreets: Array<[number, number, number, number]> = [];

  // Balanced-but-shuffled material mix.
  const styleBag: BuildingStyle[] = [];
  for (let i = 0; i < 48; i++) styleBag.push((["brick", "log", "concrete"] as const)[i % 3]);
  for (let i = styleBag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [styleBag[i], styleBag[j]] = [styleBag[j], styleBag[i]];
  }
  let si = 0;

  const lotClear = (cx: number, cz: number, w: number, d: number): boolean => {
    const hw = w / 2 + 1.3;
    const hd = d / 2 + 1.3;
    if (Math.abs(cx) > half - 7 || Math.abs(cz) > half - 7) return false;
    if (cx > 20 && cx < 28 && Math.abs(cz) < 45) return false; // east duel lane stays open
    for (const [ox, oz] of [
      [0, 0],
      [hw, hd],
      [hw, -hd],
      [-hw, hd],
      [-hw, -hd],
    ] as const) {
      if (waterCarveAt(cx + ox, cz + oz) > 0.12) return false;
    }
    for (const [px, pz, phw, phd] of pads) {
      if (Math.abs(cx - px) < hw + phw && Math.abs(cz - pz) < hd + phd) return false;
    }
    return true;
  };
  // Which wall (0=+z,1=-z,2=+x,3=-x) faces direction (dx,dz).
  const sideFacing = (dx: number, dz: number): 0 | 1 | 2 | 3 =>
    Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 2 : 3) : dz > 0 ? 0 : 1;

  // Spawns: flat pads + the two road endpoints.
  pads.push([0, -100, 11, 7]);
  pads.push([0, 100, 11, 7]);
  nodes.push([0, -100]);
  nodes.push([0, 100]);

  // The fixed center house — the tests anchor to its +z door and west
  // stairwell, so it never moves.
  lots.push({
    cx: 0,
    cz: 0,
    w: 10,
    d: 8,
    front: 0,
    stories: 2,
    style: "brick",
    roof: "flat",
    ladder: false,
  });
  pads.push([0, 0, 6.8, 5.8]);

  interface Anchor {
    type: "village" | "hamlet" | "farm";
    x: number;
    z: number;
    axis: number;
    count: number;
  }
  // The river runs ~z[25,43], so clusters sit clear of that band: most of the
  // settlement on the south bank around the center house, two hamlets + farms
  // on the north fields. One village (plaza), the rest plain hamlets/farms.
  const anchors: Anchor[] = [
    { type: "village", x: 0, z: -4, axis: 0, count: 7 },
    { type: "hamlet", x: -54, z: -2, axis: Math.PI / 2, count: 5 },
    { type: "hamlet", x: 56, z: 2, axis: Math.PI / 2, count: 5 },
    { type: "hamlet", x: -60, z: -60, axis: 0, count: 4 },
    { type: "hamlet", x: 58, z: -62, axis: 0, count: 4 },
    { type: "hamlet", x: -52, z: 64, axis: 0, count: 4 },
    { type: "hamlet", x: 54, z: 66, axis: 0, count: 4 },
    { type: "farm", x: 0, z: 74, axis: Math.PI / 2, count: 2 },
    { type: "farm", x: -40, z: -86, axis: 0, count: 2 },
    { type: "farm", x: 42, z: -88, axis: 0, count: 2 },
    { type: "farm", x: 92, z: -30, axis: Math.PI / 2, count: 1 },
    { type: "farm", x: -92, z: -32, axis: Math.PI / 2, count: 1 },
    { type: "farm", x: 90, z: 64, axis: 0, count: 1 },
    { type: "farm", x: -90, z: 60, axis: 0, count: 1 },
  ];

  for (const a of anchors) {
    const dir: [number, number] = [Math.cos(a.axis), Math.sin(a.axis)];
    const perp: [number, number] = [-dir[1], dir[0]];
    nodes.push([a.x, a.z]);
    // A clearing pad keeps the cluster centre open and flat (plaza / green / yard).
    const clearR = a.type === "village" ? 7 : a.type === "hamlet" ? 5 : 3.5;
    pads.push([a.x, a.z, clearR, clearR]);
    const spacing = 8.5;
    const spanLen = Math.max(a.count - 1, 0.6) * spacing;
    let placed = 0;
    for (let i = 0; i < a.count * 3 && placed < a.count; i++) {
      const slot = a.count === 1 ? 0 : placed / (a.count - 1) - 0.5;
      const along = slot * spanLen + (rng() - 0.5) * 3;
      const sideSign = placed % 2 === 0 ? 1 : -1;
      const big = a.type === "village" && placed < 3;
      const w = Math.min(13, (big ? 9.5 : 6.5) + rng() * 4);
      const d = Math.min(11, 6 + rng() * (big ? 4.5 : 3));
      const setback = a.type === "farm" ? 3 + rng() * 6 : 1.0 + rng() * 1.5;
      const off = 2 + setback + d / 2;
      const cx = a.x + dir[0] * along + perp[0] * off * sideSign;
      const cz = a.z + dir[1] * along + perp[1] * off * sideSign;
      if (!lotClear(cx, cz, w, d)) continue;
      const front = sideFacing(-perp[0] * sideSign, -perp[1] * sideSign);
      const stories = big ? 2 + (rng() < 0.5 ? 1 : 0) : rng() < 0.5 ? 1 : rng() < 0.82 ? 2 : 3;
      lots.push({
        cx,
        cz,
        w,
        d,
        front,
        stories,
        style: styleBag[si++ % styleBag.length],
        roof: rng() < 0.5 ? "gable" : "flat",
        ladder: rng() < 0.5,
      });
      pads.push([cx, cz, w / 2 + 0.9, d / 2 + 0.9]);
      placed++;
    }
    if (a.count >= 2) {
      localStreets.push([
        a.x - dir[0] * spanLen * 0.55,
        a.z - dir[1] * spanLen * 0.55,
        a.x + dir[0] * spanLen * 0.55,
        a.z + dir[1] * spanLen * 0.55,
      ]);
    }
    if (a.type === "village") {
      for (let s = 0; s < 6; s++) {
        stalls.push([a.x + (rng() - 0.5) * 11, a.z + (rng() - 0.5) * 9]);
      }
    }
  }

  // Pads are final — publish so terrainBase + road baking flatten correctly.
  FLAT_PADS = pads;

  // Road network: a minimum spanning tree over the spawn + cluster nodes
  // (river crossings penalised), the spawn-to-spawn path widened into the main
  // road, the rest left as lanes, plus each multi-building cluster's local
  // street. Heights are baked per segment from the pre-road terrain.
  const N = nodes.length;
  const inTree = Array.from({ length: N }, () => false);
  const parent = Array.from({ length: N }, () => -1);
  const bestW = Array.from({ length: N }, () => Infinity);
  bestW[0] = 0;
  const edgeW = (i: number, j: number): number => {
    let w = Math.hypot(nodes[i][0] - nodes[j][0], nodes[i][1] - nodes[j][1]);
    for (let k = 1; k < 5; k++) {
      const t = k / 5;
      if (
        waterCarveAt(
          nodes[i][0] + (nodes[j][0] - nodes[i][0]) * t,
          nodes[i][1] + (nodes[j][1] - nodes[i][1]) * t,
        ) > 0.1
      ) {
        w += 35;
      }
    }
    return w;
  };
  for (let it = 0; it < N; it++) {
    let u = -1;
    for (let i = 0; i < N; i++) if (!inTree[i] && (u < 0 || bestW[i] < bestW[u])) u = i;
    if (u < 0) break;
    inTree[u] = true;
    for (let v = 0; v < N; v++) {
      if (inTree[v]) continue;
      const w = edgeW(u, v);
      if (w < bestW[v]) {
        bestW[v] = w;
        parent[v] = u;
      }
    }
  }
  const adj: number[][] = Array.from({ length: N }, () => []);
  for (let v = 0; v < N; v++) {
    if (parent[v] >= 0) {
      adj[v].push(parent[v]);
      adj[parent[v]].push(v);
    }
  }
  // Main road = the tree path from spawn 0 (node 0) to spawn 1 (node 1).
  const prev = Array.from({ length: N }, () => -2);
  prev[0] = -1;
  const queue = [0];
  for (let h = 0; h < queue.length; h++) {
    for (const nb of adj[queue[h]]) {
      if (prev[nb] === -2) {
        prev[nb] = queue[h];
        queue.push(nb);
      }
    }
  }
  const mainNodes = new Set<number>();
  for (let c = 1; c !== -1 && c !== -2; c = prev[c]) mainNodes.add(c);

  const roads: RoadSeg[] = [];
  const pushSeg = (ax: number, az: number, bx: number, bz: number, halfW: number): void => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 7));
    for (let k = 0; k < n; k++) {
      const x0 = ax + (bx - ax) * (k / n);
      const z0 = az + (bz - az) * (k / n);
      const x1 = ax + (bx - ax) * ((k + 1) / n);
      const z1 = az + (bz - az) * ((k + 1) / n);
      roads.push({
        ax: x0,
        az: z0,
        bx: x1,
        bz: z1,
        ay: terrainBase(x0, z0),
        by: terrainBase(x1, z1),
        half: halfW,
      });
    }
  };
  for (let v = 0; v < N; v++) {
    if (parent[v] < 0) continue;
    const p = parent[v];
    const main = mainNodes.has(v) && mainNodes.has(p) && (prev[v] === p || prev[p] === v);
    pushSeg(nodes[v][0], nodes[v][1], nodes[p][0], nodes[p][1], main ? 3.2 : 2.2);
  }
  for (const [ax, az, bx, bz] of localStreets) pushSeg(ax, az, bx, bz, 2.0);
  ROAD_SEGS = roads;

  // Conquest zones: the village heart plus four hamlet greens — a cross over
  // the battlefield, all on clearing pads (flat) and clear of water.
  const zones = [
    { letter: "A", x: -54, z: -2, r: 12 },
    { letter: "B", x: 0, z: 0, r: 12 },
    { letter: "C", x: 56, z: 2, r: 12 },
    { letter: "D", x: -52, z: 64, r: 12 },
    { letter: "E", x: 54, z: 66, r: 12 },
  ];
  return { lots, zones, stalls };
}

// ---------------------------------------------------------------------------

function buildMap(): MapDef {
  nextPanelId = 1;
  nextBuildingId = 0;
  FLAT_PADS = [];
  ROAD_SEGS = [];
  const rng = mulberry32(MAP_SEED);
  const g: Gen = { statics: [], panels: [], buildings: [], slabs: [], ladders: [] };
  const half = SIZE / 2;

  // No perimeter walls: the world extends into a backdrop and an out-of-bounds
  // timer keeps players in (see sim/client). The layout fills FLAT_PADS +
  // ROAD_SEGS before any geometry is seated on the terrain.
  LAYOUT = planLayout(rng);

  // Buildings: each lot fronts its street; the first lot is the fixed center
  // house. Most buildings get multiple entrances (a back door for through-flow,
  // often a side door too) so fights have several ways in/out — building()
  // relocates any west door off the stairwell on multi-story houses.
  LAYOUT.lots.forEach((lot, li) => {
    const f = lot.front;
    // The fixed center house keeps exactly its north door (tests breach its
    // solid south wall); every other building gets multiple entrances.
    const fixedCenter = li === 0 && lot.cx === 0 && lot.cz === 0;
    const doorSides: Array<0 | 1 | 2 | 3> = [f];
    if (!fixedCenter) {
      if (rng() < 0.78) doorSides.push(((f + 2) % 4) as 0 | 1 | 2 | 3); // opposite
      if (rng() < 0.45) doorSides.push(((f + 1) % 4) as 0 | 1 | 2 | 3); // a side
      if (rng() < 0.22) doorSides.push(((f + 3) % 4) as 0 | 1 | 2 | 3); // the other side
    }
    building(g, lot.cx, lot.cz, lot.w, lot.d, {
      stories: lot.stories,
      style: lot.style,
      doorSides,
      roof: lot.roof,
      ladder: lot.ladder,
      rng,
    });
  });

  // Procedural scatter for everything else, rejected against keep-outs.
  const placed: Array<[number, number, number]> = []; // x, z, radius
  const clearOf = (x: number, z: number, r: number): boolean => {
    if (Math.abs(x) > half - 4 || Math.abs(z) > half - 4) return false;
    if (x > 20 && x < 28 && Math.abs(z) < 45) return false; // east duel lane
    if (waterCarveAt(x, z) > 0.1) return false; // stay out of the water
    if (onRoad(x, z) > 0) return false; // keep roads/paths clear
    for (const [cx, cz, hw, hd] of FLAT_PADS) {
      if (Math.abs(x - cx) < hw + r && Math.abs(z - cz) < hd + r) return false;
    }
    for (const [px, pz, pr] of placed) {
      if (Math.hypot(x - px, z - pz) < r + pr) return false;
    }
    return true;
  };

  // Market stalls in the village plaza: a crate of cover apiece.
  for (const [sx, sz] of LAYOUT.stalls) {
    if (!clearOf(sx, sz, 1.4)) continue;
    const crateFirst = nextPanelId;
    const base = baseHeightAt(sx, sz);
    const s = 0.9 + rng() * 0.5;
    g.panels.push({
      id: nextPanelId++,
      x: sx,
      y: base + s / 2,
      z: sz,
      ex: s,
      ey: s,
      ez: s,
      material: "crate",
    });
    endSlab(g, crateFirst);
    placed.push([sx, sz, 1.4]);
  }

  // Sandbag emplacements (three staggered courses of bags).
  for (let i = 0; i < 32; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 6);
      const z = (rng() * 2 - 1) * (half - 6);
      if (!clearOf(x, z, 2.2)) continue;
      const axis: "x" | "z" = rng() < 0.5 ? "x" : "z";
      const base = baseHeightAt(x, z);
      const len = 4 * SANDBAG.l;
      const a0 = (axis === "x" ? x : z) - len / 2;
      masonryRun(
        g,
        axis,
        a0,
        a0 + len,
        axis === "x" ? z : x,
        base,
        3,
        SANDBAG,
        "sandbag",
        undefined,
      );
      placed.push([x, z, 2.2]);
      break;
    }
  }

  // Trees: clumped into groves rather than sprinkled uniformly. Grove centers
  // avoid the built-up core and lean toward the edges/water; each spawns a
  // tight clump (concentrated toward its middle). A handful of lone trees and
  // the rejection radius keep it from reading as a regular grid.
  const groves: Array<[number, number, number]> = [];
  for (let i = 0; i < 22; i++) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = (rng() * 2 - 1) * (half - 12);
      const z = (rng() * 2 - 1) * (half - 12);
      if (Math.hypot(x, z) < 34 && rng() < 0.8) continue; // mostly keep the core open
      groves.push([x, z, 6 + rng() * 10]);
      break;
    }
  }
  for (const [gx, gz, gr] of groves) {
    const n = 4 + Math.floor(rng() * 7);
    for (let i = 0; i < n; i++) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const ang = rng() * Math.PI * 2;
        const rr = Math.sqrt(rng()) * gr; // denser toward the grove center
        const x = gx + Math.cos(ang) * rr;
        const z = gz + Math.sin(ang) * rr;
        if (!clearOf(x, z, 2.0)) continue;
        tree(g, x, z, rng);
        placed.push([x, z, 2.0]);
        break;
      }
    }
  }
  // Lone trees and copses dotted across the open fields.
  for (let i = 0; i < 26; i++) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = (rng() * 2 - 1) * (half - 6);
      const z = (rng() * 2 - 1) * (half - 6);
      if (!clearOf(x, z, 2.4)) continue;
      tree(g, x, z, rng);
      placed.push([x, z, 2.4]);
      break;
    }
  }

  // Boulder clusters.
  for (let i = 0; i < 34; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 5);
      const z = (rng() * 2 - 1) * (half - 5);
      if (!clearOf(x, z, 2.0)) continue;
      rocks(g, x, z, rng);
      placed.push([x, z, 2.0]);
      break;
    }
  }

  // Crates, some with a smaller crate stacked on top.
  for (let i = 0; i < 44; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 5);
      const z = (rng() * 2 - 1) * (half - 5);
      if (!clearOf(x, z, 1.6)) continue;
      const crateFirst = nextPanelId;
      const s = 0.9 + rng() * 0.5;
      const base = baseHeightAt(x, z);
      g.panels.push({
        id: nextPanelId++,
        x,
        y: base + s / 2,
        z,
        ex: s,
        ey: s,
        ez: s,
        material: "crate",
      });
      if (rng() < 0.4) {
        const s2 = s * 0.65;
        g.panels.push({
          id: nextPanelId++,
          x: x + (rng() - 0.5) * 0.25,
          y: base + s + s2 / 2,
          z: z + (rng() - 0.5) * 0.25,
          ex: s2,
          ey: s2,
          ez: s2,
          material: "crate",
        });
      }
      endSlab(g, crateFirst);
      placed.push([x, z, 1.6]);
      break;
    }
  }

  return {
    size: SIZE,
    statics: g.statics,
    panels: g.panels,
    buildings: g.buildings,
    slabs: g.slabs,
    ladders: g.ladders,
    spawns: [
      [0, 0.1, -100],
      [0, 0.1, 100],
    ],
  };
}

export const MAP = buildMap();

// ---------------------------------------------------------------------------
// Conquest zones: capturable flags at the village heart and four hamlet
// greens, spread in a cross over the battlefield. Hold the majority to bleed
// enemy tickets. Computed by the layout so they always sit on real clearings.

export interface ZoneDef {
  letter: string;
  x: number;
  z: number;
  r: number;
}

export const ZONES: ZoneDef[] = LAYOUT.zones;

// Slab index for a map piece id (binary search over the sorted id ranges).
export function slabOfPiece(pieceId: number): number {
  let lo = 0;
  let hi = MAP.slabs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = MAP.slabs[mid];
    if (pieceId < s.first) hi = mid - 1;
    else if (pieceId > s.last) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Structural contact graph: masonry is BONDED — support flows through the
// wall fabric in every direction, not just straight down. A piece stands as
// long as its connected region (through touching alive pieces) still reaches
// the ground; carve a region loose and the whole island falls as one chunk.
// Pure map data, computed once over the static piece list.

export interface ContactIndex {
  adj: Map<number, number[]>; // id -> ids in face contact (undirected)
  grounded: Set<number>; // pieces standing on the terrain itself
}

export function buildContactIndex(): ContactIndex {
  const adj = new Map<number, number[]>();
  const grounded = new Set<number>();

  // Spatial hash over xz so each piece only tests its neighborhood.
  const CELL = 2;
  const grid = new Map<number, PanelDef[]>();
  const key = (cx: number, cz: number) => (cx + 128) * 4096 + (cz + 128);
  const cellRange = (p: PanelDef): [number, number, number, number] => [
    Math.floor((p.x - p.ex / 2) / CELL),
    Math.floor((p.x + p.ex / 2) / CELL),
    Math.floor((p.z - p.ez / 2) / CELL),
    Math.floor((p.z + p.ez / 2) / CELL),
  ];

  for (const p of MAP.panels) {
    if (p.y - p.ey / 2 <= baseHeightAt(p.x, p.z) + 0.15) grounded.add(p.id);
    const [x0, x1, z0, z1] = cellRange(p);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        const list = grid.get(k);
        if (list) list.push(p);
        else grid.set(k, [p]);
      }
    }
  }

  // Two pieces are in contact when their boxes touch (or overlap) along some
  // axis with real overlap in the other two — mortar, in effect.
  const GAP = 0.02;
  const MIN_OVERLAP = 0.02;
  for (const p of MAP.panels) {
    const seen = new Set<number>();
    const [x0, x1, z0, z1] = cellRange(p);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (const q of grid.get(key(cx, cz)) ?? []) {
          if (q.id <= p.id || seen.has(q.id)) continue;
          seen.add(q.id);
          const gx = Math.abs(p.x - q.x) - (p.ex + q.ex) / 2;
          const gy = Math.abs(p.y - q.y) - (p.ey + q.ey) / 2;
          const gz = Math.abs(p.z - q.z) - (p.ez + q.ez) / 2;
          if (gx > GAP || gy > GAP || gz > GAP) continue;
          // Touching along one axis needs overlap in the others.
          const overlaps =
            (gx <= GAP && gy < -MIN_OVERLAP && gz < -MIN_OVERLAP) ||
            (gy <= GAP && gx < -MIN_OVERLAP && gz < -MIN_OVERLAP) ||
            (gz <= GAP && gx < -MIN_OVERLAP && gy < -MIN_OVERLAP);
          if (!overlaps) continue;
          let a = adj.get(p.id);
          if (!a) adj.set(p.id, (a = []));
          a.push(q.id);
          let b = adj.get(q.id);
          if (!b) adj.set(q.id, (b = []));
          b.push(p.id);
        }
      }
    }
  }

  return { adj, grounded };
}

// ---------------------------------------------------------------------------
// Structural support: which pieces rest on which. The server consults this
// when a piece dies — anything that just lost its LAST support falls too
// (and sheds rubble), so shooting out the bottom of a wall drops the column
// above it. Pure map data, computed once over the static piece list.
//
// A piece is "supported" by terrain (grounded) or by any alive piece whose
// top face its bottom face rests on with real xz overlap. Pieces that never
// had support (floating stair treads, canopy clumps) are left alone — they
// only fall with their structure's collapse.

export interface SupportIndex {
  above: Map<number, number[]>; // id -> pieces resting on it
  below: Map<number, number[]>; // id -> pieces it rests on
  grounded: Set<number>; // pieces standing on the terrain itself
  // Coplanar side-touching plank neighbors (roofs/floors): a plank with no
  // direct support hangs off the roof sheet as long as the sheet still
  // reaches an anchored plank somewhere — and the whole sheet drops when the
  // last anchor goes.
  plankAdj: Map<number, number[]>;
}

export function buildSupportIndex(): SupportIndex {
  const above = new Map<number, number[]>();
  const below = new Map<number, number[]>();
  const grounded = new Set<number>();
  const plankAdj = new Map<number, number[]>();

  // Spatial hash over xz so each piece only tests its neighborhood.
  const CELL = 2;
  const grid = new Map<number, PanelDef[]>();
  const key = (cx: number, cz: number) => (cx + 128) * 4096 + (cz + 128);
  const cellRange = (p: PanelDef): [number, number, number, number] => [
    Math.floor((p.x - p.ex / 2) / CELL),
    Math.floor((p.x + p.ex / 2) / CELL),
    Math.floor((p.z - p.ez / 2) / CELL),
    Math.floor((p.z + p.ez / 2) / CELL),
  ];

  for (const p of MAP.panels) {
    if (p.y - p.ey / 2 <= baseHeightAt(p.x, p.z) + 0.15) grounded.add(p.id);
    const [x0, x1, z0, z1] = cellRange(p);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = key(cx, cz);
        const list = grid.get(k);
        if (list) list.push(p);
        else grid.set(k, [p]);
      }
    }
  }

  for (const p of MAP.panels) {
    const pTop = p.y + p.ey / 2;
    const seen = new Set<number>();
    const [x0, x1, z0, z1] = cellRange(p);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (const q of grid.get(key(cx, cz)) ?? []) {
          if (q.id === p.id || seen.has(q.id)) continue;
          seen.add(q.id);
          // q rests on p: q's bottom at p's top, with real overlap.
          if (Math.abs(q.y - q.ey / 2 - pTop) > 0.09) continue;
          const ox = (p.ex + q.ex) / 2 - Math.abs(p.x - q.x);
          const oz = (p.ez + q.ez) / 2 - Math.abs(p.z - q.z);
          if (ox < 0.03 || oz < 0.03) continue;
          let a = above.get(p.id);
          if (!a) above.set(p.id, (a = []));
          a.push(q.id);
          let b = below.get(q.id);
          if (!b) below.set(q.id, (b = []));
          b.push(p.id);
        }
      }
    }
  }

  // Plank sheets: link coplanar, side-touching planks (same level of one
  // roof/floor) so support can flow across the sheet from its anchored edge.
  for (const p of MAP.panels) {
    if (p.material !== "plank") continue;
    const seen = new Set<number>();
    const [x0, x1, z0, z1] = cellRange(p);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        for (const q of grid.get(key(cx, cz)) ?? []) {
          if (q.id === p.id || q.material !== "plank" || seen.has(q.id)) continue;
          seen.add(q.id);
          if (Math.abs(q.y - p.y) > 0.02) continue;
          const gapX = Math.abs(p.x - q.x) - (p.ex + q.ex) / 2;
          const gapZ = Math.abs(p.z - q.z) - (p.ez + q.ez) / 2;
          const touching =
            (Math.abs(gapX) < 0.05 && gapZ < -0.1) || (Math.abs(gapZ) < 0.05 && gapX < -0.1);
          if (!touching) continue;
          let a = plankAdj.get(p.id);
          if (!a) plankAdj.set(p.id, (a = []));
          a.push(q.id);
        }
      }
    }
  }

  return { above, below, grounded, plankAdj };
}

// Deployed cover panels get ids above this; map panel ids stay below it.
export const BUILT_PANEL_ID_BASE = 10000;

export function spawnPoint(team: number, idx: number): [number, number, number] {
  const c = MAP.spawns[team === 0 ? 0 : 1];
  const angle = (idx / 8) * Math.PI * 2;
  const x = c[0] + Math.sin(angle) * 3.5;
  const z = c[2] + Math.cos(angle) * 2.5;
  return [x, heightAt(x, z) + 0.1, z];
}
