// The battlefield, procedurally generated from a seed so client and server
// build identical worlds. Every GAME gets a fresh seed (the server announces
// it in the welcome/phase messages and everyone calls initMap), so every
// round is a new level: a warped-Voronoi biome field (meadow, forest, rocky
// highland, marsh) colors the terrain and steers what grows where; terrain is
// a domain-warped simplex-fbm heightfield with biome character (ridges and
// terraces on the high ground, boggy pools in the marsh) plus hill stamps
// placed in 180°-symmetric pairs (flattened under buildings, roads and
// spawns); a settlement layout of one village and mirrored hamlets/farms is
// wired together by an MST-plus-loops road network of jittered polylines.
// Every structure is masonry of material-shaped destructible PIECES — clay
// bricks laid in running bond, stacked cabin logs, roof planks, tree trunks
// and foliage clumps, sandbags, supply crates. Gunfire chips out single
// bricks, explosions blow holes, and enough structural loss collapses the
// whole building. A generation-time raycast pass guarantees neither spawn can
// be seen from across the map: where a sightline leaks, ordinary-looking
// hills grow (in mirrored pairs) until the dirt blocks it — buildings help
// too, but they're destructible, so terrain carries the guarantee. The world
// has no perimeter walls — it extends into a backdrop and an out-of-bounds
// timer keeps players in.

import { createNoise2D } from "simplex-noise";

// The fixture seed: the map built at module load (tests and tools rely on its
// fixed center house and flat spawns — invariants initMap keeps for EVERY
// seed: center house at (0,0), spawns at (0,±100), zones flat and dry).
export const DEFAULT_MAP_SEED = 0xb17b17;

// The active seed. Reassigned by initMap(seed) before the world is rebuilt.
let SEED = DEFAULT_MAP_SEED;

export function mapSeed(): number {
  return SEED;
}

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
  let h = (ix * 374761393 + iz * 668265263 + SEED * 69069) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) % 10000) / 10000;
}

// Independent named sub-seed per subsystem, so one consumer drawing more
// random numbers never reshuffles another's output on a different seed.
function subSeed(label: number): number {
  let h = (SEED ^ Math.imul(label, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
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
const TERRAIN_AMPLITUDE = 2.1;

// Deterministic simplex noise for the terrain relief (its own PRNG sub-stream
// so it never disturbs the layout rng). createNoise2D builds a permutation from
// the seed, so client and server (both running this module) get identical
// terrain. Recreated by initMap for each new seed.
let terrainNoise2D = createNoise2D(mulberry32(SEED ^ 0x5eed));

// Fractal Brownian motion in [-1,1].
function fbm2(x: number, z: number, octaves: number, freq: number): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * terrainNoise2D(x * f, z * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// Hill stamps [cx, cz, radius, amplitude], planned per seed. Each spawn is
// CRADLED by an independently-rolled arc of overlapping hills on its field
// side — the natural high ground that blocks sightlines into the base — with
// gaps only at the road gate and the sally; more hills wander midfield
// wherever they land (the map is random; only the flags are near-mirrored),
// and the sightline validator appends extras wherever a view still leaks.
let HILLS: Array<[number, number, number, number]> = [];

// Road gates: where each base's road crosses its cradle (chosen BEFORE the
// hills so the arc can leave the gap; planLayout wires the road through it).
let GATES: [[number, number], [number, number]] = [
  [24, -92],
  [-24, 92],
];
// Second exit per base, out the opposite flank — a fresh spawn sees a clear
// road out of the bowl whichever way they turn.
let GATES2: [[number, number], [number, number]] = [
  [-24, -92],
  [24, 92],
];

// Every base road leaves through a dog-leg BEHIND the pad: spawn → a
// waypoint out past the pad's flank (level with the back line) → out through
// its cradle gap. No flattened road channel ever points from the field into
// the pad, so each gap can be covered by an interior mound the road never
// touches.
let SPAWN_WAYPTS: [[number, number], [number, number]] = [
  [15, -103.5],
  [-15, 103.5],
];
let SPAWN_WAYPTS2: [[number, number], [number, number]] = [
  [-15, -103.5],
  [15, 103.5],
];

function planHills(rng: () => number): void {
  HILLS = [];
  // The sniper lane commits first so the wandering hills can respect it.
  DUEL_LANE_X = (15 + rng() * 22) * (rng() < 0.5 ? 1 : -1);
  // Each base rolls its own cradle independently — the MAP is random, only
  // the flags are near-mirrored. Geometry is computed in a south-spawn frame
  // and point-reflected into place for the north team.
  for (const team of [0, 1] as const) {
    const flip = team === 0 ? 1 : -1;
    const put = (x: number, z: number, r: number, amp: number): void => {
      HILLS.push([x * flip, z * flip, r, amp]);
    };
    // Where a waypoint→gate leg crosses the arc ring — the cradle leaves its
    // gap there.
    const ringD = 21;
    const legGapAz = (wpx: number, gpx: number, gpz: number): number => {
      const legDx = gpx - wpx;
      const legDz = -gpz + 103.5;
      for (let t = 0; t <= 1; t += 0.05) {
        const px = wpx + legDx * t;
        const pz = -103.5 + legDz * t;
        if (Math.hypot(px, pz + 100) >= ringD) return Math.atan2(px, pz + 100);
      }
      return Math.atan2(gpx, 100 - gpz);
    };
    const side = rng() < 0.5 ? 1 : -1;
    const gx = side * (27 + rng() * 6);
    const gz = 86 + rng() * 4;
    GATES[team] = [gx * flip, -gz * flip];
    const wx = side * 15;
    SPAWN_WAYPTS[team] = [wx * flip, -103.5 * flip];
    const gapAz = legGapAz(wx, gx, gz);
    // The second exit road leaves out the OPPOSITE flank through its own
    // gate — the bowl is never a one-door trap, and both routes read as
    // roads from the spawn pad.
    const gx2 = -side * (27 + rng() * 6);
    const gz2 = 86 + rng() * 4;
    GATES2[team] = [gx2 * flip, -gz2 * flip];
    const wx2 = -side * 15;
    SPAWN_WAYPTS2[team] = [wx2 * flip, -103.5 * flip];
    const gap2Az = legGapAz(wx2, gx2, gz2);
    // Cradle arc: hills every ~19° across the field-facing side. Gaps only
    // at the road gate and the sally. Stamps ADD where they overlap, so
    // amplitude is tuned for a ~4-5m ridge — enough to hide the pad, low
    // enough to stay a hill, gentle enough to walk over anywhere (the
    // countdown, not the dirt, keeps campers out).
    for (let az = -1.75; az <= 1.75; az += 0.34) {
      if (Math.abs(az - gapAz) < 0.42 || Math.abs(az - gap2Az) < 0.42) continue;
      const dist = 20 + rng() * 4;
      put(Math.sin(az) * dist, -100 + Math.cos(az) * dist, 15 + rng() * 4, 2.5 + rng() * 0.6);
    }
    // Gap-covering mounds INSIDE the ring, on the pad→gap axes. The road
    // dog-legs mean neither mound is crossed by a road; both stand past the
    // pad fade.
    for (const [az, d, mr, ma] of [
      [gapAz, 15, 11.5, 3.2 + rng() * 0.5],
      [gap2Az, 15, 11.5, 3.2 + rng() * 0.5],
    ] as const) {
      put(Math.sin(az) * d, -100 + Math.cos(az) * d, mr, ma);
    }
    // And baffles outside each gap, offset off the exit lines, so neither
    // opening can be scoped from across the map.
    for (const [az, off] of [
      [gapAz, side > 0 ? 0.5 : -0.5],
      [gap2Az, side > 0 ? -0.5 : 0.5],
    ] as const) {
      const baffleD = 36 + rng() * 4;
      const perp = az + off;
      put(Math.sin(perp) * baffleD, -100 + Math.cos(perp) * baffleD, 13, 2.8);
    }
  }
  // Wandering hills across the midfield band, wherever they land.
  const nHills = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < nHills; i++) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const hx = (rng() * 2 - 1) * 92;
      const hz = (rng() * 2 - 1) * 56;
      if (Math.hypot(hx, hz) < 26) continue; // keep the center house approachable
      const r = 24 + rng() * 14;
      // The duel lane promises a clear north–south run — no hills across it.
      if (Math.abs(hx - DUEL_LANE_X) < r + 4 && Math.abs(hz) < 45 + r) continue;
      HILLS.push([hx, hz, r, 1.2 + rng() * 1.0]);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Biomes: a jittered-grid Voronoi field with domain-warped borders. Each
// ~66m cell gets a seed point and a biome; a point's biome is its nearest
// seed after warping the lookup, so borders meander organically instead of
// reading as straight Voronoi edges. Biomes steer terrain character, ground
// palette (client), tree density/species, rocks, hedges and reeds — cosmetics
// and cover density, never traversability, so no side is walled in.

export const BIOME_MEADOW = 0;
export const BIOME_FOREST = 1;
export const BIOME_ROCKY = 2;
export const BIOME_MARSH = 3;

const BIOME_CELL = 66;
const BIOME_WARP = 15;

// Cell (cx,cz) -> jittered seed point + biome id, statelessly from the seed.
// Marsh gravitates to the river lowlands; away from water it's rare.
function biomeCell(cx: number, cz: number): [number, number, number] {
  const jx = hash2(cx * 3 + 1013, cz * 3 + 557);
  const jz = hash2(cx * 3 + 2029, cz * 3 + 773);
  const x = (cx + 0.5 + (jx - 0.5) * 0.85) * BIOME_CELL;
  const z = (cz + 0.5 + (jz - 0.5) * 0.85) * BIOME_CELL;
  const r = hash2(cx * 3 + 3037, cz * 3 + 991);
  const nearWater = HAS_RIVER && Math.abs(z - RIVER_Z0) < 34;
  let id: number;
  if (nearWater) {
    id = r < 0.3 ? BIOME_MARSH : r < 0.58 ? BIOME_MEADOW : r < 0.84 ? BIOME_FOREST : BIOME_ROCKY;
  } else {
    id = r < 0.4 ? BIOME_MEADOW : r < 0.7 ? BIOME_FOREST : r < 0.93 ? BIOME_ROCKY : BIOME_MARSH;
  }
  return [x, z, id];
}

function biomeWarped(x: number, z: number): [number, number] {
  return [
    x + BIOME_WARP * fbm2(x + 900, z + 900, 2, 1 / 70),
    z + BIOME_WARP * fbm2(x + 1300, z + 1300, 2, 1 / 70),
  ];
}

// The discrete biome at (x,z) — what placement decisions and the client's
// ground palette read.
export function biomeAt(x: number, z: number): number {
  const [wx, wz] = biomeWarped(x, z);
  const cx0 = Math.floor(wx / BIOME_CELL);
  const cz0 = Math.floor(wz / BIOME_CELL);
  let best = Infinity;
  let id = BIOME_MEADOW;
  for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
    for (let cz = cz0 - 1; cz <= cz0 + 1; cz++) {
      const [sx, sz, sid] = biomeCell(cx, cz);
      const d = (sx - wx) * (sx - wx) + (sz - wz) * (sz - wz);
      if (d < best) {
        best = d;
        id = sid;
      }
    }
  }
  return id;
}

// Smooth per-biome weights (sum 1) for blending terrain character across
// borders — discrete switches would leave cliffs along every biome edge.
function biomeWeightsAt(x: number, z: number): [number, number, number, number] {
  const [wx, wz] = biomeWarped(x, z);
  const cx0 = Math.floor(wx / BIOME_CELL);
  const cz0 = Math.floor(wz / BIOME_CELL);
  const w: [number, number, number, number] = [0, 0, 0, 0];
  let total = 0;
  const R = BIOME_CELL * 1.1;
  for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
    for (let cz = cz0 - 1; cz <= cz0 + 1; cz++) {
      const [sx, sz, sid] = biomeCell(cx, cz);
      const d = Math.hypot(sx - wx, sz - wz);
      if (d >= R) continue;
      const k = smooth(1 - d / R) ** 2;
      w[sid] += k;
      total += k;
    }
  }
  if (total <= 0) return [1, 0, 0, 0];
  w[0] /= total;
  w[1] /= total;
  w[2] /= total;
  w[3] /= total;
  return w;
}

// Ridged noise for the rocky highlands: folded fbm peaks into sharp crests.
function ridgedAt(x: number, z: number): number {
  const n = fbm2(x + 3100, z + 3100, 3, 1 / 30);
  return (1 - Math.abs(n)) ** 2.2;
}

// Raw pre-fade terrain height: domain-warped simplex fbm (organic ridges and
// valleys), redistributed so lowlands are flatter, shaped by the local biome
// blend (rocky crests + terraced benches, boggy marsh dips that pool below
// the water line), plus max-combined hill stamps. Clamped so pools stay
// wadeable-shallow.
function reliefAt(x: number, z: number): number {
  const wx = x + 11 * fbm2(x + 100, z + 100, 2, 1 / 55);
  const wz = z + 11 * fbm2(x + 200, z + 200, 2, 1 / 55);
  let e = fbm2(wx, wz, 4, 1 / 46) * 0.5 + 0.5; // [0,1]
  e = Math.pow(e, 1.6); // flatten the lowlands, keep the highs
  const [, wForest, wRocky, wMarsh] = biomeWeightsAt(x, z);
  let h = e * TERRAIN_AMPLITUDE * (0.9 + 0.2 * wForest + 0.45 * wRocky - 0.5 * wMarsh);
  if (wRocky > 0.03) {
    h += ridgedAt(x, z) * 2.0 * wRocky;
    // Terraced benches on the high ground (blended, so steps stay walkable).
    const stepped = Math.round(h / 0.85) * 0.85;
    h += (stepped - h) * 0.55 * wRocky;
  }
  if (wMarsh > 0.03) {
    const pool = fbm2(x + 4400, z + 4400, 2, 1 / 26);
    h -= Math.max(0, pool) * 0.85 * wMarsh; // bog pools dip below the waterline
  }
  h = Math.max(h, -0.55); // ankle-to-knee deep at worst
  for (const [hx, hz, r, amp] of HILLS) {
    const d = Math.hypot(x - hx, z - hz);
    if (d < r) h += amp * smooth(1 - d / r);
  }
  return h;
}

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

// Spatial hash over the road segments: the jittered-polyline network runs to
// a few hundred segs, and the road field is sampled per terrain vertex — a
// flat scan per sample would dominate world builds.
const ROAD_GRID_CELL = 16;
let ROAD_GRID = new Map<number, number[]>();
const NO_SEGS: number[] = [];

function roadGridKey(cx: number, cz: number): number {
  return (cx + 512) * 2048 + (cz + 512);
}

function rebuildRoadGrid(): void {
  ROAD_GRID = new Map();
  for (let i = 0; i < ROAD_SEGS.length; i++) {
    const s = ROAD_SEGS[i];
    const pad = s.half + 10; // covers every query's falloff band
    const x0 = Math.floor((Math.min(s.ax, s.bx) - pad) / ROAD_GRID_CELL);
    const x1 = Math.floor((Math.max(s.ax, s.bx) + pad) / ROAD_GRID_CELL);
    const z0 = Math.floor((Math.min(s.az, s.bz) - pad) / ROAD_GRID_CELL);
    const z1 = Math.floor((Math.max(s.az, s.bz) + pad) / ROAD_GRID_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = roadGridKey(cx, cz);
        const list = ROAD_GRID.get(k);
        if (list) list.push(i);
        else ROAD_GRID.set(k, [i]);
      }
    }
  }
}

function roadSegsNear(x: number, z: number): number[] {
  return (
    ROAD_GRID.get(roadGridKey(Math.floor(x / ROAD_GRID_CELL), Math.floor(z / ROAD_GRID_CELL))) ??
    NO_SEGS
  );
}

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
  for (const si of roadSegsNear(x, z)) {
    const s = ROAD_SEGS[si];
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
  for (const si of roadSegsNear(x, z)) {
    const s = ROAD_SEGS[si];
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
  for (const si of roadSegsNear(x, z)) {
    const s = ROAD_SEGS[si];
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

// --- Water: usually one meandering river plus lakes, carved into the base
// terrain (scaled by shapeFade, so building pads become natural fords and the
// water never undermines a structure). Wadeable: max ~1.1m deep. The river's
// band, width and the lakes are planned per seed; some maps skip the river
// entirely and make do with lakes and marsh pools.

export const WATER_SURFACE_Y = -0.22;
const WATER_DEPTH = 1.3;
const RIVER_HALF_WIDTH = 7.5;

let HAS_RIVER = true;
let RIVER_Z0 = 34;
let RIVER_WIDTH_MULT = 1;

// River centerline: a non-periodic meander from low-frequency value noise.
// (A sum of sines reads as a regular wave; layered noise wanders like a real
// river.) The width breathes along its length, widening into pools and
// pinching at riffles.
function riverCenterZ(x: number): number {
  return (
    RIVER_Z0 + 12 * (valueNoise(x + 600, 0, 118) - 0.5) + 5 * (valueNoise(x + 1700, 0, 44) - 0.5)
  );
}
function riverHalfWidthAt(x: number): number {
  return RIVER_HALF_WIDTH * RIVER_WIDTH_MULT * (0.62 + 0.7 * valueNoise(x + 1234, 0, 40));
}

// River polyline: [x, centerZ, halfWidth], sampled densely (and a little past
// each edge) so the nearest-point distance is smooth.
let RIVER_PTS: Array<[number, number, number]> = [];

// [cx, cz, rx, rz] — planned per seed, in mirrored pairs for fairness.
let LAKES: Array<[number, number, number, number]> = [];

function planWater(rng: () => number): void {
  HAS_RIVER = rng() < 0.85;
  // Band center at least 14m off the middle: the fixed center house (and its
  // conquest flag) shouldn't sit mid-channel on a rectangular ford.
  RIVER_Z0 = (14 + rng() * 24) * (rng() < 0.5 ? -1 : 1);
  RIVER_WIDTH_MULT = 0.8 + rng() * 0.5;
  RIVER_PTS = [];
  if (HAS_RIVER) {
    for (let x = -SIZE / 2 - 8; x <= SIZE / 2 + 8; x += 3) {
      RIVER_PTS.push([x, riverCenterZ(x), riverHalfWidthAt(x)]);
    }
  }
  LAKES = [];
  const nLakes = (HAS_RIVER ? 0 : 1) + (rng() < 0.55 ? 1 : 0) + (rng() < 0.35 ? 1 : 0);
  for (let i = 0; i < nLakes; i++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const cx = (rng() * 2 - 1) * 90;
      const cz = (rng() * 2 - 1) * 60;
      if (Math.hypot(cx, cz) < 28) continue; // keep the center house dry
      if (HAS_RIVER && Math.abs(cz - RIVER_Z0) < 26) continue; // river valley stays a river
      if (LAKES.some(([lx, lz]) => Math.hypot(lx - cx, lz - cz) < 40)) continue;
      LAKES.push([cx, cz, 10 + rng() * 7, 8 + rng() * 5]);
      break;
    }
  }
}

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

// The pre-road terrain: simplex relief minus the water carve, both flattened
// inside pads. Road baking samples THIS (so it never recurses into itself).
function terrainBase(x: number, z: number): number {
  const fade = shapeFade(x, z);
  return reliefAt(x, z) * fade - waterCarveAt(x, z) * fade;
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
// with half pieces closing the ends. The unit length is stretched so whole
// courses close the run EXACTLY — with a fixed unit, any span that isn't a
// multiple of it stops short on one side (a whole missing meter for 2m
// logs), leaving that corner of the building visibly disconnected.
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
  const n = Math.max(
    1,
    Math.round((a1 - a0) / unit.l),
    Math.ceil((a1 - a0) / (unit.l * 1.3)), // never stretch a unit past +30%
  );
  const ul = (a1 - a0) / n;
  for (let row = 0; row < rows; row++) {
    const y = baseY + (row + 0.5) * unit.h;
    const segs: Array<[number, number]> = [];
    if (row % 2 === 0) {
      for (let i = 0; i < n; i++) segs.push([a0 + (i + 0.5) * ul, ul]);
    } else {
      segs.push([a0 + ul / 4, ul / 2]);
      for (let i = 0; i < n - 1; i++) segs.push([a0 + ul / 2 + (i + 0.5) * ul, ul]);
      segs.push([a1 - ul / 4, ul / 2]);
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
    const clamped = Math.max(lo, Math.min(hi, pushed));
    // If clamping lands the cut back over the centered exterior door, no
    // nudge can save it — a wall through the doorway seals the building.
    // NaN tells the caller to skip this split entirely.
    return Math.abs(clamped - center) < 1.05 ? Number.NaN : clamped;
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
      if (Number.isNaN(pos)) return; // one bigger room beats a blocked door
      out.push({ axis: "z", fixed: pos, lo: az0, hi: az1 });
      rec(ax0, az0, pos, az1, depth + 1);
      rec(pos, az0, ax1, az1, depth + 1);
    } else {
      const lo = az0 + MIN;
      const hi = az1 - MIN;
      if (hi <= lo) return;
      let pos = snap(lo + (hi - lo) * (0.5 + (rng() - 0.5) * 0.5));
      pos = avoid(Math.max(lo, Math.min(hi, pos)), cz, lo, hi);
      if (Number.isNaN(pos)) return;
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
  // Variety knobs (all optional):
  barn?: boolean; // one big open hall + loft instead of rooms; wide wagon door
  parapet?: boolean; // flat roofs only: masonry crouch-cover around the edge
  porch?: boolean; // plank platform + posts + canopy over the front door
  chimney?: boolean; // brick stack climbing a windowless wall past the roof
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
  const gSteps = gable ? Math.max(1, Math.round(span / 2 / PLANK.w)) : 0; // per side
  const gStepW = gable ? span / 2 / gSteps : PLANK.w; // stretched to meet the ridge exactly
  const peak = gSteps * GABLE_RISE;

  // Door: 1.3m x 2.05m, centered, ground floor only (barns get a 2.5m wagon
  // door). Windows: 2.1m wide at sill height on the other ground walls and on
  // EVERY upper-story wall. Pieces are clipped, so brick walls get cut bricks
  // around openings and log walls get sawed log ends.
  const doorHalf = o.barn ? 1.25 : 0.65;
  const doorTop = o.barn ? 2.45 : 2.05;
  const door = (mid: number): GapRect[] => [
    { lo: mid - doorHalf, hi: mid + doorHalf, y0: 0, y1: doorTop },
  ];
  const win = (mid: number, baseY: number): GapRect[] => [
    { lo: mid - 1.05, hi: mid + 1.05, y0: baseY + 1.3, y1: baseY + 2.05 },
  ];
  const glassIds: number[] = [];
  const pane = (axis: "x" | "z", mid: number, fixed: number, baseY: number): void => {
    const slabFirst = nextPanelId;
    glassIds.push(nextPanelId);
    // The masonry hole snaps to whole courses, so it's a bit taller (and a hair
    // wider) than the nominal opening — biggest for concrete's tall courses.
    // Oversize the pane to cover it; the excess sits behind the surrounding
    // wall pieces (which occlude it), so the glass always fills the window.
    const yMargin = unit.h + 0.02;
    const y0 = baseY + 1.3 - yMargin;
    const y1 = baseY + 2.05 + yMargin;
    const w = 2.1 + 0.24;
    g.panels.push({
      id: nextPanelId++,
      x: axis === "x" ? mid : fixed,
      y: (y0 + y1) / 2,
      z: axis === "x" ? fixed : mid,
      ex: axis === "x" ? w : 0.06,
      ey: y1 - y0,
      ez: axis === "x" ? 0.06 : w,
      material: "glass",
      buildingId: id,
    });
    endSlab(g, slabFirst);
  };

  // Everything above the stepped roofline of a gable end is sky.
  const gableGaps = (mid: number): GapRect[] => {
    const gaps: GapRect[] = [];
    for (let j = 0; j <= gSteps; j++) {
      const keep = span / 2 - j * gStepW;
      const y0 = height + j * GABLE_RISE;
      const y1 = j === gSteps ? height + peak + 3 : y0 + GABLE_RISE;
      gaps.push({ lo: -1e9, hi: mid - keep, y0, y1 });
      gaps.push({ lo: mid + keep, hi: 1e9, y0, y1 });
    }
    return gaps;
  };

  // Balcony: some upper stories open onto a railed platform (never on the
  // stairwell wall — its floor column is open there). Barns don't bother.
  const balcony =
    stories > 1 && !o.barn && o.rng() < 0.55
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
  // Plank fields stretch to fit like the masonry does — otherwise any
  // footprint that isn't a multiple of the plank leaves an open strip of
  // missing floor along one wall.
  const strips = Math.max(1, Math.round(d / PLANK.w));
  const stripW = d / strips;
  const npl = Math.max(1, Math.round(w / PLANK.l));
  const plankL = w / npl;
  for (let level = 1; level <= stories; level++) {
    const isRoof = level === stories;
    if (isRoof && gable) break; // the gable strips replace the flat sheet
    const levelFirst = nextPanelId;
    const y = level * WALL_HEIGHT + PLANK.h / 2;
    const holeHere = stairHole !== null && (!isRoof || roofExit);
    for (let s = 0; s < strips; s++) {
      // A barn's middle floor is only a LOFT over the stair end — the rest
      // stays a full-height hall under the gable.
      if (o.barn && !isRoof && s >= strips * 0.45) continue;
      const z = z0 + (s + 0.5) * stripW;
      const inHoleZ = holeHere && stairHole !== null && z > stairHole.y0 && z < stairHole.y1;
      const segs: Array<[number, number]> = [];
      if (s % 2 === 0) {
        for (let i = 0; i < npl; i++) segs.push([x0 + (i + 0.5) * plankL, plankL]);
      } else {
        segs.push([x0 + plankL / 4, plankL / 2]);
        for (let i = 0; i < npl - 1; i++) {
          segs.push([x0 + plankL / 2 + (i + 0.5) * plankL, plankL]);
        }
        segs.push([x1 - plankL / 4, plankL / 2]);
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
            ez: stripW,
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
  if (!o.barn) {
    const inset = unit.t / 2 + 0.03;
    const iz0 = z0 + inset;
    const iz1 = z1 - inset;
    const ix1 = x1 - inset;
    const rx0 = (stories > 1 ? x0 + 3.4 : x0) + inset;
    const roomWalls = partitionInterior(rx0, iz0, ix1, iz1, cx, cz, o.rng);
    // 1.4m clear — a 0.7m-wide character needs real shoulder room to pass
    // without catching a jamb (1.1m was too tight, especially upstairs).
    const doorGap = (mid: number, baseY: number): GapRect => ({
      lo: mid - 0.7,
      hi: mid + 0.7,
      y0: baseY,
      y1: baseY + 2.05,
    });
    for (let story = 0; story < stories; story++) {
      const baseY = story * WALL_HEIGHT;
      for (const wseg of roomWalls) {
        const span = wseg.hi - wseg.lo;
        if (span < 2.0) continue; // too short to seat a 1.4m door with jambs
        // Where perpendicular partitions abut this wall, a doorway placed
        // there opens straight into the end of another wall — collect those
        // spots so the door pick can steer clear.
        const abuts: number[] = [];
        for (const other of roomWalls) {
          if (other === wseg || other.axis === wseg.axis) continue;
          if (Math.abs(other.lo - wseg.fixed) > 0.2 && Math.abs(other.hi - wseg.fixed) > 0.2) {
            continue;
          }
          if (other.fixed > wseg.lo + 0.2 && other.fixed < wseg.hi - 0.2) abuts.push(other.fixed);
        }
        // Keep the 0.7m half-door at least 0.2m off each end (mid in [lo+0.9,
        // hi-0.9]) so jambs survive instead of collapsing to slivers, and at
        // least ~a jamb clear of every abutting wall.
        const pickDoor = (): number => {
          let best = wseg.lo + 0.9 + o.rng() * (span - 1.8);
          let bestClear = -1;
          for (let t = 0; t < 14; t++) {
            const mid = wseg.lo + 0.9 + o.rng() * (span - 1.8);
            const clear =
              abuts.length > 0 ? Math.min(...abuts.map((a) => Math.abs(mid - a))) : Infinity;
            if (clear >= 1.05) return mid;
            if (clear > bestClear) {
              bestClear = clear;
              best = mid;
            }
          }
          return best;
        };
        const gaps: GapRect[] = [doorGap(pickDoor(), baseY)];
        if (span > 6.5 && o.rng() < 0.35) {
          gaps.push(doorGap(pickDoor(), baseY));
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
    const nAlong = Math.max(1, Math.round((along1 - along0) / PLANK.l));
    const alongL = (along1 - along0) / nAlong; // stretched to close the eaves
    const strip = (cross: number, y: number): void => {
      const segs: Array<[number, number]> = [];
      for (let i = 0; i < nAlong; i++) segs.push([along0 + (i + 0.5) * alongL, alongL]);
      for (const [c, l] of segs) {
        roofIds.push(nextPanelId);
        g.panels.push({
          id: nextPanelId++,
          x: ridgeAlongX ? c : cross,
          y,
          z: ridgeAlongX ? cross : c,
          ex: ridgeAlongX ? l : gStepW,
          ey: ROOF_STEP_H,
          ez: ridgeAlongX ? gStepW : l,
          material: "plank",
          buildingId: id,
        });
      }
    };
    for (let i = 0; i < gSteps; i++) {
      const y = height + i * GABLE_RISE + ROOF_STEP_H / 2;
      strip(crossBase + (i + 0.5) * gStepW, y);
      strip(crossBase + span - (i + 0.5) * gStepW, y);
    }
    endSlab(g, roofFirst);
  }

  // Flat-roof parapet: a hip-high masonry course around the roof edge —
  // crouch cover that makes the climb worth it. Rests on the roof sheet.
  const parapet = !gable && o.parapet === true;
  if (parapet) {
    const baseY = height + PLANK.h;
    const rows = Math.max(1, Math.round(0.55 / unit.h));
    masonryRun(g, "x", x0, x1, z1, baseY, rows, unit, style, id);
    masonryRun(g, "x", x0, x1, z0, baseY, rows, unit, style, id);
    masonryRun(g, "z", z0, z1, x1, baseY, rows, unit, style, id);
    masonryRun(g, "z", z0, z1, x0, baseY, rows, unit, style, id);
  }

  // A porch over the front door: plank platform, timber posts, a little
  // canopy — cover at the threshold and a face for the street. Skipped when
  // a balcony already owns that wall.
  const porchSide = doorSides[0];
  if (o.porch && (balcony === null || balcony.side !== porchSide)) {
    const porchFirst = nextPanelId;
    const [axis, mid, fixed] = walls[porchSide];
    const outSign = porchSide === 0 || porchSide === 2 ? 1 : -1;
    const emitP = (
      px: number,
      py: number,
      pz: number,
      ex: number,
      ey: number,
      ez: number,
      material: PanelMaterial,
    ): void => {
      roofIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: px,
        y: py,
        z: pz,
        ex,
        ey,
        ez,
        material,
        buildingId: id,
      });
    };
    for (const out of [0.45, 1.15]) {
      const off = fixed + outSign * (unit.t / 2 + out);
      if (axis === "x") emitP(mid, 0.1, off, 3.0, 0.08, 0.75, "plank");
      else emitP(off, 0.1, mid, 0.75, 0.08, 3.0, "plank");
    }
    const postOff = fixed + outSign * (unit.t / 2 + 1.45);
    for (const s of [-1, 1]) {
      const along = mid + s * 1.35;
      const px = axis === "x" ? along : postOff;
      const pz = axis === "x" ? postOff : along;
      emitP(px, 1.25, pz, 0.16, 2.5, 0.16, "post");
    }
    const roofOff = fixed + outSign * (unit.t / 2 + 0.95);
    if (axis === "x") emitP(mid, 2.56, roofOff, 3.4, 0.1, 2.1, "plank");
    else emitP(roofOff, 2.56, mid, 2.1, 0.1, 3.4, "plank");
    endSlab(g, porchFirst);
  }

  // A brick chimney climbing a windowless stretch of wall past the roofline.
  if (o.chimney) {
    const eaveOnly = gable ? (ridgeAlongX ? [0, 1] : [2, 3]) : [0, 1, 2, 3];
    const chimSides = eaveOnly.filter(
      (s) => !doorSides.includes(s as 0 | 1 | 2 | 3) && (balcony === null || balcony.side !== s),
    );
    if (chimSides.length > 0) {
      const side = chimSides[Math.floor(o.rng() * chimSides.length)];
      const [axis, , fixed] = walls[side];
      const a0 = axis === "x" ? x0 : z0;
      const a1 = axis === "x" ? x1 : z1;
      const along = a0 + (a1 - a0) * (o.rng() < 0.5 ? 0.27 : 0.73);
      const outSign = side === 0 || side === 2 ? 1 : -1;
      const face = fixed + outSign * (unit.t / 2 + 0.3);
      const chimFirst = nextPanelId;
      const top = height + (gable ? 1.3 : 0.9);
      const n = Math.ceil(top / 0.62);
      for (let k = 0; k < n; k++) {
        g.panels.push({
          id: nextPanelId++,
          x: axis === "x" ? along : face,
          y: (k + 0.5) * 0.62,
          z: axis === "x" ? face : along,
          ex: 0.66,
          ey: 0.62,
          ez: 0.66,
          material: "brick",
          buildingId: id,
        });
      }
      endSlab(g, chimFirst);
    }
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
        // With a parapet the roof lip is a course higher — climb past it.
        y1: height + (parapet ? 1.1 : 0.5),
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

// Procedural trees: conifers (ragged stacked tiers) and broadleaf (layered,
// asymmetric, drooping crowns), in size classes with a tapered, sometimes
// leaning trunk. The trunk is the structure — break two segments and it falls.
// Each tree tags its canopy/trunk pieces with a seed band so pieceColor gives
// it one coherent species/season (incl. autumn & dry) while clumps still vary.
function tree(g: Gen, x: number, z: number, rng: () => number, biome = BIOME_MEADOW): void {
  const slabFirst = nextPanelId;
  const id = nextBuildingId++;
  const base = baseHeightAt(x, z);
  // Species follow the biome: conifers own the rocky tops, mixed woods in the
  // forest, broadleaf across the meadows, scrubby broadleaf in the marsh.
  const coniferP =
    biome === BIOME_ROCKY
      ? 0.72
      : biome === BIOME_FOREST
        ? 0.5
        : biome === BIOME_MARSH
          ? 0.12
          : 0.28;
  const conifer = rng() < coniferP;
  const SEG = 0.8;
  const big = rng() < 0.22;
  const small = !big && rng() < 0.32;
  const segs = conifer
    ? small
      ? 4
      : big
        ? 7
        : 5 + Math.floor(rng() * 2)
    : small
      ? 3
      : big
        ? 6
        : 4 + Math.floor(rng() * 2);
  const girth0 = (conifer ? 0.3 : 0.46) * (big ? 1.4 : small ? 0.78 : 1) + rng() * 0.06;
  // Canopy band: conifers dark green; broadleaf mostly green, sometimes autumn/dry.
  const r = rng();
  const canopyBand = conifer
    ? 5
    : r < 0.52
      ? 0
      : r < 0.68
        ? 1
        : r < 0.8
          ? 2
          : r < 0.9
            ? 3
            : r < 0.97
              ? 4
              : 6;
  // Birch stands: forest cells hash into whole birch groves (pale trunks in
  // clumps read as a stand, not salt-and-pepper).
  const birchGrove =
    !conifer &&
    biome === BIOME_FOREST &&
    hash2(Math.floor(x / 22) + 9001, Math.floor(z / 22) + 7001) < 0.35;
  const bark = conifer ? 1 : birchGrove ? 2 : rng() < 0.12 ? 2 : 0;
  const leanA = rng() * Math.PI * 2;
  const leanAmt = conifer ? 0 : (big ? 0.1 : 0.05) * (rng() < 0.5 ? 1 : 0);
  const span = segs * SEG;
  let serial = 0;
  const trunkIds: number[] = [];
  const canopyIds: number[] = [];
  for (let s = 0; s < segs; s++) {
    const f = s / segs;
    const gx = girth0 * (1 - 0.28 * f);
    trunkIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: x + Math.sin(leanA) * leanAmt * span * f,
      y: base + (s + 0.5) * SEG,
      z: z + Math.cos(leanA) * leanAmt * span * f,
      ex: gx,
      ey: SEG,
      ez: gx,
      material: "trunk",
      seed: bark | (serial++ << 2),
      buildingId: id,
    });
  }
  const topX = x + Math.sin(leanA) * leanAmt * span;
  const topZ = z + Math.cos(leanA) * leanAmt * span;
  const top = base + span;
  const clump = (cx: number, cy: number, cz: number, ex: number, ey: number, ez: number): void => {
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
      seed: canopyBand | (serial++ << 3),
      buildingId: id,
    });
  };
  if (conifer) {
    const tiers = 3 + (big ? 1 : 0);
    const baseR = big ? 2.0 : 1.5;
    for (let t = 0; t < tiers; t++) {
      const f = 1 - t / tiers;
      const rad = 0.5 + baseR * f;
      const cy = top - (tiers - 1 - t) * 0.95 - 0.2;
      const ring = 3 + Math.floor(f * 2);
      for (let k = 0; k < ring; k++) {
        const a = (k / ring) * Math.PI * 2 + t * 0.7;
        clump(
          topX + Math.cos(a) * rad * 0.7,
          cy - 0.12,
          topZ + Math.sin(a) * rad * 0.7,
          rad * 0.7 + 0.4,
          0.55,
          rad * 0.7 + 0.4,
        );
      }
    }
    clump(topX, top + 0.7, topZ, 0.7, 1.0, 0.7); // spire
  } else {
    const crownR = (big ? 2.4 : small ? 1.2 : 1.8) + rng() * 0.4;
    const layers = 3 + (big ? 1 : 0);
    const ax = Math.cos(leanA + 1) * 0.3 * crownR; // light-seeking asymmetry
    const az = Math.sin(leanA + 1) * 0.3 * crownR;
    for (let L = 0; L < layers; L++) {
      const lf = (L + 0.6) / (layers + 0.6);
      const layerR = crownR * Math.sin(Math.PI * lf);
      const cy = top - 0.3 + L * 0.85;
      const ring = 3 + Math.round(layerR * 1.1);
      for (let k = 0; k < ring; k++) {
        const a = (k / ring) * Math.PI * 2 + L;
        const rr = layerR * (0.55 + 0.45 * rng());
        const s = 0.7 + layerR * 0.32 * (0.7 + 0.6 * rng());
        clump(
          topX + ax + Math.cos(a) * rr,
          cy - rr * 0.15,
          topZ + az + Math.sin(a) * rr,
          s,
          s * 0.8,
          s,
        );
      }
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
    // ceil(segs * 1.5/segs) = ceil(1.5) = 2: two trunk segments fell it.
    collapseFraction: 1.5 / segs,
  });
  endSlab(g, slabFirst);
}

// Rock formations, one of four archetypes (rounded boulder cluster, angular
// shards/outcrop, flat layered slabs, low scree field), partially buried and
// tinted by a per-cluster rock-type band (granite/sandstone/basalt/mossy).
function rocks(g: Gen, x: number, z: number, rng: () => number): void {
  const slabFirst = nextPanelId;
  const ra = rng();
  const arch = ra < 0.42 ? 0 : ra < 0.62 ? 1 : ra < 0.8 ? 2 : 3;
  const rb = rng();
  const band = rb < 0.5 ? 0 : rb < 0.7 ? 1 : rb < 0.88 ? 3 : 2; // granite/sandstone/mossy/basalt
  let serial = 0;
  const put = (px: number, pz: number, ex: number, ey: number, ez: number, bury = 0.35): void => {
    g.panels.push({
      id: nextPanelId++,
      x: px,
      y: baseHeightAt(px, pz) + ey * (0.5 - bury),
      z: pz,
      ex,
      ey,
      ez,
      material: "rock",
      seed: band | (serial++ << 2),
    });
  };
  if (arch === 0) {
    // Rounded boulder: a big lump plus overlapping satellites.
    const s = 1.0 + rng() * 0.9;
    put(x, z, s, s * (0.75 + rng() * 0.25), s * (0.85 + rng() * 0.3), 0.3);
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = s * (0.4 + rng() * 0.4);
      const ss = s * (0.4 + rng() * 0.35);
      put(x + Math.cos(a) * r, z + Math.sin(a) * r, ss, ss * (0.7 + rng() * 0.4), ss, 0.4);
    }
  } else if (arch === 1) {
    // Angular shards / outcrop: a few tall thin blocks clustered.
    const n = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const r = i === 0 ? 0 : 0.5 + rng() * 1.0;
      const w = 0.4 + rng() * 0.5;
      const h = 1.2 + rng() * 1.6;
      put(x + Math.cos(a) * r, z + Math.sin(a) * r, w, h, w * (0.7 + rng() * 0.5), 0.2);
    }
  } else if (arch === 2) {
    // Flat layered slabs.
    const s = 1.4 + rng() * 1.0;
    put(x, z, s, 0.3 + rng() * 0.25, s * (0.7 + rng() * 0.3), 0.15);
    if (rng() < 0.7) {
      const s2 = s * (0.6 + rng() * 0.3);
      put(x + (rng() - 0.5) * 0.6, z + (rng() - 0.5) * 0.6, s2, 0.25 + rng() * 0.2, s2, -0.1);
    }
  } else {
    // Scree / pebble field: many small low stones.
    const n = 7 + Math.floor(rng() * 8);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2;
      const rr = Math.sqrt(rng()) * (1.4 + rng() * 1.2);
      const s = 0.18 + rng() * 0.34;
      put(x + Math.cos(a) * rr, z + Math.sin(a) * rr, s, s * (0.6 + rng() * 0.4), s, 0.5);
    }
  }
  endSlab(g, slabFirst);
}

// --- Small props: cheap box clusters that make the place feel lived-in. All
// reuse existing materials and become destructible cover.

// A fallen log (horizontal) and usually a stump beside it.
function fallenLog(g: Gen, x: number, z: number, rng: () => number): void {
  const slabFirst = nextPanelId;
  const base = baseHeightAt(x, z);
  const alongX = rng() < 0.5;
  const len = 2.4 + rng() * 2;
  const d = 0.42;
  g.panels.push({
    id: nextPanelId++,
    x,
    y: base + d * 0.4,
    z,
    ex: alongX ? len : d,
    ey: d,
    ez: alongX ? d : len,
    material: "log",
    seed: 1,
  });
  if (rng() < 0.6) {
    g.panels.push({
      id: nextPanelId++,
      x: x + (rng() - 0.5) * 2.2,
      y: base + 0.3,
      z: z + (rng() - 0.5) * 2.2,
      ex: 0.5,
      ey: 0.6,
      ez: 0.5,
      material: "trunk",
      seed: 0,
    });
  }
  endSlab(g, slabFirst);
}

// A village well: a chest-high stone ring under a little plank roof on posts.
function well(g: Gen, x: number, z: number): void {
  const slabFirst = nextPanelId;
  const base = baseHeightAt(x, z);
  const ring = 8;
  const R = 0.85;
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2;
    g.panels.push({
      id: nextPanelId++,
      x: x + Math.cos(a) * R,
      y: base + 0.45,
      z: z + Math.sin(a) * R,
      ex: 0.46,
      ey: 0.9,
      ez: 0.46,
      material: "stone",
      seed: 1,
    });
  }
  for (const s of [-1, 1]) {
    g.panels.push({
      id: nextPanelId++,
      x: x + s * R,
      y: base + 1.7,
      z,
      ex: 0.16,
      ey: 2.4,
      ez: 0.16,
      material: "post",
    });
  }
  g.panels.push({
    id: nextPanelId++,
    x,
    y: base + 3.0,
    z,
    ex: 2.5,
    ey: 0.18,
    ez: 1.4,
    material: "plank",
  });
  endSlab(g, slabFirst);
}

// A cluster of barrels (waist-high cover).
function barrels(g: Gen, x: number, z: number, rng: () => number): void {
  const slabFirst = nextPanelId;
  const base = baseHeightAt(x, z);
  const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const r = i === 0 ? 0 : 0.45 + rng() * 0.4;
    g.panels.push({
      id: nextPanelId++,
      x: x + Math.cos(a) * r,
      y: base + 0.46,
      z: z + Math.sin(a) * r,
      ex: 0.56,
      ey: 0.92,
      ez: 0.56,
      material: "crate",
    });
  }
  endSlab(g, slabFirst);
}

// A roadside lamp post.
function lampPost(g: Gen, x: number, z: number): void {
  const slabFirst = nextPanelId;
  const base = baseHeightAt(x, z);
  g.panels.push({
    id: nextPanelId++,
    x,
    y: base + 1.55,
    z,
    ex: 0.14,
    ey: 3.1,
    ez: 0.14,
    material: "post",
  });
  g.panels.push({
    id: nextPanelId++,
    x,
    y: base + 3.2,
    z,
    ex: 0.32,
    ey: 0.34,
    ez: 0.32,
    material: "glass",
  });
  endSlab(g, slabFirst);
}

// Reeds at the water's edge: thin tall blades (dry-olive band).
function reeds(g: Gen, x: number, z: number, rng: () => number): void {
  const slabFirst = nextPanelId;
  const base = baseHeightAt(x, z);
  const n = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < n; i++) {
    const h = 0.8 + rng() * 0.7;
    g.panels.push({
      id: nextPanelId++,
      x: x + (rng() - 0.5) * 0.9,
      y: base + h * 0.5,
      z: z + (rng() - 0.5) * 0.9,
      ex: 0.1,
      ey: h,
      ez: 0.1,
      material: "canopy",
      seed: 6 | (i << 3),
    });
  }
  endSlab(g, slabFirst);
}

// A low hedge run between two points (good chest-high cover, encloses yards).
function hedge(g: Gen, x0: number, z0: number, x1: number, z1: number): void {
  const slabFirst = nextPanelId;
  const len = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.round(len));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const x = x0 + (x1 - x0) * t;
    const z = z0 + (z1 - z0) * t;
    if (onRoad(x, z) > 0 || waterCarveAt(x, z) > 0.1) continue;
    const h = 1.0 + (i % 2) * 0.12;
    g.panels.push({
      id: nextPanelId++,
      x,
      y: baseHeightAt(x, z) + h * 0.5,
      z,
      ex: 0.95,
      ey: h,
      ez: 0.95,
      material: "canopy",
      seed: 1 | (i << 3),
    });
  }
  endSlab(g, slabFirst);
}

// A roofless ruin: one story of weathered walls with a jagged, noise-eaten
// top line, a doorway breach, surviving corner posts, half-buried flagstones
// and a spill of rubble — pre-destroyed cover wired into the same collapse
// bookkeeping as intact houses. (Pieces are only ever SKIPPED, never deleted,
// so panel ids stay contiguous.)
function ruin(g: Gen, cx: number, cz: number, w: number, d: number, rng: () => number): void {
  const id = nextBuildingId++;
  const style: BuildingStyle = rng() < 0.62 ? "brick" : "concrete";
  const unit = style === "brick" ? BRICK : CONCRETE;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const rows = Math.round(WALL_HEIGHT / unit.h);
  const wallIds: number[] = [];
  const floorIds: number[] = [];
  const doorWall = Math.floor(rng() * 4);
  const walls: Array<[axis: "x" | "z", mid: number, fixed: number]> = [
    ["x", cx, z1],
    ["x", cx, z0],
    ["z", cz, x1],
    ["z", cz, x0],
  ];
  for (let side = 0; side < 4; side++) {
    const [axis, mid, fixed] = walls[side];
    const a0 = axis === "x" ? x0 : z0;
    const a1 = axis === "x" ? x1 : z1;
    const gaps: GapRect[] =
      side === doorWall ? [{ lo: mid - 0.8, hi: mid + 0.8, y0: 0, y1: 2.05 }] : [];
    const slabFirst = nextPanelId;
    const n = Math.max(1, Math.round((a1 - a0) / unit.l));
    const ul = (a1 - a0) / n; // stretch-to-fit, like masonryRun
    for (let row = 0; row < rows; row++) {
      const y = (row + 0.5) * unit.h;
      const segs: Array<[number, number]> = [];
      if (row % 2 === 0) {
        for (let i = 0; i < n; i++) segs.push([a0 + (i + 0.5) * ul, ul]);
      } else {
        segs.push([a0 + ul / 4, ul / 2]);
        for (let i = 0; i < n - 1; i++) segs.push([a0 + ul / 2 + (i + 0.5) * ul, ul]);
        segs.push([a1 - ul / 4, ul / 2]);
      }
      for (const [c, l] of segs) {
        // The jagged top: each spot keeps its masonry up to a noise-picked
        // height, so the wall reads as weather-eaten, not sliced.
        const keepTo =
          0.25 + 0.75 * valueNoise(c + side * 91, (axis === "x" ? fixed : mid) + 47, 3.2);
        if (row / rows > keepTo) continue;
        if (row / rows < keepTo - 0.3 && rng() < 0.05) continue; // pinhole battle damage
        for (const [fc, fl] of clipAgainstGaps(c, l, y, unit.h, gaps)) {
          wallIds.push(nextPanelId);
          g.panels.push({
            id: nextPanelId++,
            x: axis === "x" ? fc : fixed,
            y,
            z: axis === "x" ? fixed : fc,
            ex: axis === "x" ? fl : unit.t,
            ey: unit.h,
            ez: axis === "x" ? unit.t : fl,
            material: style,
            buildingId: id,
          });
        }
      }
    }
    endSlab(g, slabFirst);
  }
  // Surviving corner posts, snapped off at odd heights.
  const postFirst = nextPanelId;
  for (const [px, pz] of [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ] as const) {
    if (rng() < 0.3) continue;
    const ph = 1.0 + rng() * 1.4;
    wallIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: px,
      y: ph / 2,
      z: pz,
      ex: 0.3,
      ey: ph,
      ez: 0.3,
      material: "post",
      buildingId: id,
    });
  }
  endSlab(g, postFirst);
  // Weed-split flagstones and a spill of rubble. Weeds take some tiles, but
  // never so many that the collapse bookkeeping (or the sanity tests) sees a
  // floorless shell.
  const floorFirst = nextPanelId;
  const nfx = Math.max(1, Math.round(w / 1.4));
  const nfz = Math.max(1, Math.round(d / 1.4));
  for (let iz = 0; iz < nfz; iz++) {
    for (let ix = 0; ix < nfx; ix++) {
      const tilesLeft = nfx * nfz - (iz * nfx + ix);
      if (floorIds.length + tilesLeft > 14 && rng() < 0.35) continue;
      floorIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: x0 + (ix + 0.5) * (w / nfx),
        y: 0.09,
        z: z0 + (iz + 0.5) * (d / nfz),
        ex: w / nfx - 0.03,
        ey: 0.14,
        ez: d / nfz - 0.03,
        material: "stone",
        buildingId: id,
      });
    }
  }
  endSlab(g, floorFirst);
  const rubbleFirst = nextPanelId;
  const nr = 5 + Math.floor(rng() * 5);
  for (let i = 0; i < nr; i++) {
    const a = rng() * Math.PI * 2;
    const rr = rng() * Math.min(w, d) * 0.42;
    const px = cx + Math.cos(a) * rr;
    const pz = cz + Math.sin(a) * rr;
    const s = 0.35 + rng() * 0.5;
    const yaw = rng() * Math.PI;
    g.panels.push({
      id: nextPanelId++,
      x: px,
      y: 0.14 + s * 0.3,
      z: pz,
      ex: s,
      ey: s * 0.7,
      ez: s * (0.7 + rng() * 0.5),
      material: "rubble",
      rot: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
      seed: i,
      broken: true,
    });
  }
  endSlab(g, rubbleFirst);
  g.buildings.push({
    id,
    kind: "building",
    cx,
    cz,
    w,
    d,
    wallPanelIds: wallIds,
    roofPanelIds: floorIds,
    collapseFraction: 0.55,
  });
}

// Crop rows on the farm yards: parallel lanes of low bushy planting — light
// waist-high cover that reads as agriculture from across the field.
function cropRows(g: Gen, x: number, z: number, axis: number, rng: () => number): void {
  const slabFirst = nextPanelId;
  const nRows = 2 + Math.floor(rng() * 3);
  const len = 9 + rng() * 6;
  const dirX = Math.cos(axis);
  const dirZ = Math.sin(axis);
  const perpX = -dirZ;
  const perpZ = dirX;
  for (let r = 0; r < nRows; r++) {
    const offset = (r - (nRows - 1) / 2) * 2.4;
    const n = Math.floor(len / 1.1);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n - 0.5;
      const px = x + dirX * t * len + perpX * offset;
      const pz = z + dirZ * t * len + perpZ * offset;
      if (onRoad(px, pz) > 0 || waterCarveAt(px, pz) > 0.1) continue;
      const h = 0.55 + rng() * 0.2;
      g.panels.push({
        id: nextPanelId++,
        x: px,
        y: baseHeightAt(px, pz) + h / 2,
        z: pz,
        ex: 0.85,
        ey: h,
        ez: 0.85,
        material: "canopy",
        seed: 2 | (i << 3),
      });
    }
  }
  endSlab(g, slabFirst);
}

// ---------------------------------------------------------------------------
// Layout: a settlement of varied clusters — one true village (a market plaza
// and the biggest buildings) plus hamlets and farmsteads placed fresh every
// seed in 180°-mirrored pairs (so the conquest flags stay fair) — wired
// together by an MST-plus-loops road network of jittered polylines that shies
// away from hills and fords the river where it must. Buildings front the
// streets. Fully deterministic from the map seed.

type LotKind = "house" | "tower" | "barn" | "ruin";

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
  kind: LotKind;
}

interface Layout {
  lots: LotPlan[];
  zones: Array<{ letter: string; x: number; z: number; r: number }>;
  stalls: Array<[number, number]>;
  farms: Array<[number, number, number]>; // x, z, street axis — crop rows go here
}

let LAYOUT: Layout = { lots: [], zones: [], stalls: [], farms: [] };

// A north–south sniper lane kept clear of structures and hills, at a fresh x
// each map (chosen in planHills so the hills can respect it).
let DUEL_LANE_X = 24;

export function duelLaneX(): number {
  return DUEL_LANE_X;
}

function planLayout(rng: () => number): Layout {
  const half = SIZE / 2;
  const pads: Array<[number, number, number, number]> = [];
  const lots: LotPlan[] = [];
  const stalls: Array<[number, number]> = [];
  const farms: Array<[number, number, number]> = [];
  const nodes: Array<[number, number]> = [];

  // Balanced-but-shuffled material mix.
  const styleBag: BuildingStyle[] = [];
  for (let i = 0; i < 48; i++) styleBag.push((["brick", "log", "concrete"] as const)[i % 3]);
  for (let i = styleBag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [styleBag[i], styleBag[j]] = [styleBag[j], styleBag[i]];
  }
  let si = 0;

  // Which wall (0=+z,1=-z,2=+x,3=-x) faces direction (dx,dz).
  const sideFacing = (dx: number, dz: number): 0 | 1 | 2 | 3 =>
    Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 2 : 3) : dz > 0 ? 0 : 1;

  // Spawns: flat pads + road endpoints (nodes 0 and 1). Each base's road
  // dog-legs BEHIND the pad: spawn → flank waypoint (nodes 4 and 5) → out
  // through the cradle's gate (nodes 2 and 3) — the flattened channel never
  // points from the field into the pad.
  pads.push([0, -100, 11, 7]);
  pads.push([0, 100, 11, 7]);
  nodes.push([0, -100]);
  nodes.push([0, 100]);
  nodes.push(GATES[0]);
  nodes.push(GATES[1]);
  nodes.push(SPAWN_WAYPTS[0]);
  nodes.push(SPAWN_WAYPTS[1]);
  nodes.push(GATES2[0]);
  nodes.push(GATES2[1]);
  nodes.push(SPAWN_WAYPTS2[0]);
  nodes.push(SPAWN_WAYPTS2[1]);

  // The fixed center house — the tests anchor to its +z door and west
  // stairwell, so it never moves, whatever the seed.
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
    kind: "house",
  });
  pads.push([0, 0, 6.8, 5.8]);

  interface Anchor {
    type: "village" | "hamlet" | "farm";
    x: number;
    z: number;
    axis: number;
    count: number;
  }

  // One village near the center; hamlets and farms in mirrored pairs so the
  // flags (and the cover around them) are fair by construction.
  const anchors: Anchor[] = [
    {
      type: "village",
      x: (rng() * 2 - 1) * 5,
      z: -4 + (rng() * 2 - 1) * 6,
      axis: rng() < 0.5 ? 0 : Math.PI / 2,
      count: 8 + Math.floor(rng() * 3),
    },
  ];
  // Hamlet greens carry the conquest flags, so they must sit on genuinely dry
  // ground (not just pad-flattened fords); farms only need to not drown.
  const anchorClear = (x: number, z: number, minD: number, zLim: number, wet: number): boolean => {
    if (Math.abs(x) > half - 16 || Math.abs(z) > zLim) return false;
    if (waterCarveAt(x, z) > wet) return false;
    // Greens grow wells and stalls — keep the whole cluster off the lane.
    if (Math.abs(x - DUEL_LANE_X) < 13 && Math.abs(z) < 52) return false;
    return anchors.every((a) => Math.hypot(a.x - x, a.z - z) >= minD);
  };
  // The first two pairs carry the four outer conquest flags (A/C, D/E).
  // Twins sit NEAR the 180° mirror of each other with a few metres of drift —
  // organic rather than copy-pasted, but each team's flag distances stay
  // within a hand-off of fair. Flags also keep real breathing room: at least
  // 46m from every other flag (including B at the center house).
  const FLAG_MIN_DIST = 46;
  const hamletPairs: Array<[Anchor, Anchor]> = [];
  for (let pair = 0; pair < 2; pair++) {
    // Flags already placed (for spacing): B, then both zones of prior pairs.
    const flagPts: Array<[number, number]> = [[0, 0]];
    for (const [pa, pb] of hamletPairs) flagPts.push([pa.x, pa.z], [pb.x, pb.z]);
    const flagRoom = (px: number, pz: number): boolean =>
      flagPts.every(([fx, fz]) => Math.hypot(fx - px, fz - pz) >= FLAG_MIN_DIST);
    for (let attempt = 0; attempt < 40; attempt++) {
      const ang = rng() * Math.PI * 2;
      const rad = 48 + rng() * 40;
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      // The twin drifts off the exact mirror point.
      const bx = -x + (rng() * 2 - 1) * 7;
      const bz = -z + (rng() * 2 - 1) * 7;
      if (!anchorClear(x, z, 36, 68, 0.04) || !anchorClear(bx, bz, 36, 68, 0.04)) continue;
      if (!flagRoom(x, z) || !flagRoom(bx, bz)) continue;
      const axis = rng() * Math.PI;
      const count = 5 + Math.floor(rng() * 2);
      const a: Anchor = { type: "hamlet", x, z, axis, count };
      const b: Anchor = {
        type: "hamlet",
        x: bx,
        z: bz,
        axis: axis + (rng() * 2 - 1) * 0.4,
        count,
      };
      anchors.push(a, b);
      hamletPairs.push([a, b]);
      break;
    }
  }
  // Free hamlets and farms land wherever they land — no mirroring. The map
  // is random; only the flag greens above are (nearly) fair-by-position.
  const nFreeHamlets = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < nFreeHamlets; i++) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ang = rng() * Math.PI * 2;
      const rad = 40 + rng() * 48;
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      if (!anchorClear(x, z, 36, 68, 0.3)) continue;
      anchors.push({
        type: "hamlet",
        x,
        z,
        axis: rng() * Math.PI,
        count: 5 + Math.floor(rng() * 2),
      });
      break;
    }
  }
  const nFarms = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < nFarms; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const ang = rng() * Math.PI * 2;
      const rad = 74 + rng() * 24;
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      // zLim 70 keeps farm pads off the spawn cradle arcs.
      if (!anchorClear(x, z, 32, 70, 0.5)) continue;
      anchors.push({
        type: "farm",
        x,
        z,
        axis: rng() * Math.PI,
        count: 1 + (rng() < 0.55 ? 1 : 0),
      });
      break;
    }
  }

  for (const a of anchors) {
    nodes.push([a.x, a.z]);
    // A clearing pad keeps the cluster centre open and flat (plaza / green /
    // yard) — pads also zero the water carve, so every green is dry.
    const clearR = a.type === "village" ? 7 : a.type === "hamlet" ? 5 : 3.5;
    pads.push([a.x, a.z, clearR, clearR]);
    if (a.type === "farm") farms.push([a.x, a.z, a.axis]);
  }

  // --- Road graph over the nodes, BEFORE lots: lots must reject the road
  // corridors, and the corridors only depend on the node graph.
  const N = nodes.length;
  // Forced base plumbing: spawn↔its two waypoints, each waypoint↔its gate
  // (nodes: 0,1 spawns · 2,3 gates · 4,5 waypoints · 6,7 second gates ·
  // 8,9 second waypoints); nothing else may touch a spawn or waypoint node.
  const FORCED: ReadonlyArray<[number, number]> = [
    [0, 4],
    [4, 2],
    [1, 5],
    [5, 3],
    [0, 8],
    [8, 6],
    [1, 9],
    [9, 7],
  ];
  const forced = (i: number, j: number): boolean =>
    FORCED.some(([a, b]) => (a === i && b === j) || (a === j && b === i));
  const isPlumbing = (n: number): boolean => n < 2 || n === 4 || n === 5 || n === 8 || n === 9;
  const edgeW = (i: number, j: number): number => {
    if (isPlumbing(i) || isPlumbing(j)) {
      if (!forced(i, j)) return Infinity;
      return 1; // always taken
    }
    const [ax, az] = nodes[i];
    const [bx, bz] = nodes[j];
    const dist = Math.hypot(bx - ax, bz - az);
    let w = dist;
    const n = 6;
    let excess = 0;
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      if (waterCarveAt(x, z) > 0.1) w += 30; // fords are dear
      excess += Math.max(0, terrainBase(x, z) - 1.3); // roads shy off the hills
    }
    return w + (excess / (n - 1)) * dist * 0.4;
  };
  const inTree = Array.from({ length: N }, () => false);
  const parent = Array.from({ length: N }, () => -1);
  const bestW = Array.from({ length: N }, () => Infinity);
  bestW[0] = 0;
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
  const edges: Array<[number, number]> = [];
  for (let v = 0; v < N; v++) {
    if (parent[v] >= 0) {
      adj[v].push(parent[v]);
      adj[parent[v]].push(v);
      edges.push([v, parent[v]]);
    }
  }

  // Pure trees fight like corridors: re-add a few short non-tree edges (skip
  // near-parallel ones) so the network has tactical loops.
  const angleOk = (i: number, j: number): boolean => {
    const ang = Math.atan2(nodes[j][1] - nodes[i][1], nodes[j][0] - nodes[i][0]);
    for (const nb of adj[i]) {
      const a2 = Math.atan2(nodes[nb][1] - nodes[i][1], nodes[nb][0] - nodes[i][0]);
      let d = Math.abs(ang - a2) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      if (d < 0.44) return false;
    }
    return true;
  };
  const loopCand: Array<[number, number, number]> = [];
  for (let i = 10; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      if (adj[i].includes(j)) continue;
      const w = edgeW(i, j);
      if (w < 78) loopCand.push([w, i, j]);
    }
  }
  loopCand.sort((a, b) => a[0] - b[0]);
  let loops = 0;
  for (const [, i, j] of loopCand) {
    if (loops >= 3) break;
    if (adj[i].includes(j) || !angleOk(i, j) || !angleOk(j, i)) continue;
    adj[i].push(j);
    adj[j].push(i);
    edges.push([i, j]);
    loops++;
  }

  // Main road = the tree path from spawn 0 to spawn 1 (through both gates).
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
  mainNodes.add(0);

  // Rasterize each edge as a jittered polyline: subdivide, push interior
  // points sideways with smooth noise (pinned at the ends), then one Chaikin
  // pass so junctions stay put but the runs between them curve like lanes
  // that grew rather than were surveyed.
  interface Polyline {
    pts: Array<[number, number]>;
    half: number;
  }
  const roadPolyline = (
    ax: number,
    az: number,
    bx: number,
    bz: number,
  ): Array<[number, number]> => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 9));
    const px = -(bz - az) / (len || 1);
    const pz = (bx - ax) / (len || 1);
    const pts: Array<[number, number]> = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      let x = ax + (bx - ax) * t;
      let z = az + (bz - az) * t;
      const off =
        fbm2(x + 7100, z + 7100, 2, 1 / 42) * Math.min(3.4, len * 0.11) * Math.sin(Math.PI * t);
      x += px * off;
      z += pz * off;
      pts.push([x, z]);
    }
    if (pts.length < 3) return pts;
    const out: Array<[number, number]> = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[i + 1];
      out.push([x0 * 0.75 + x1 * 0.25, z0 * 0.75 + z1 * 0.25]);
      out.push([x0 * 0.25 + x1 * 0.75, z0 * 0.25 + z1 * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  };
  const polylines: Polyline[] = [];
  for (const [v, p] of edges) {
    const main = mainNodes.has(v) && mainNodes.has(p) && (prev[v] === p || prev[p] === v);
    polylines.push({
      pts: roadPolyline(nodes[v][0], nodes[v][1], nodes[p][0], nodes[p][1]),
      half: main ? 3.2 : 2.2,
    });
  }

  const distToPolyline = (x: number, z: number, pts: Array<[number, number]>): number => {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      if (d < best) best = d;
    }
    return best;
  };

  const lotClear = (cx: number, cz: number, w: number, d: number): boolean => {
    const hw = w / 2 + 1.3;
    const hd = d / 2 + 1.3;
    if (Math.abs(cx) > half - 7 || Math.abs(cz) > half - 7) return false;
    // The duel lane check is footprint-aware: a wide lot centered outside the
    // band can still poke a wall into the corridor.
    if (cx + hw > DUEL_LANE_X - 4 && cx - hw < DUEL_LANE_X + 4 && Math.abs(cz) - hd < 45) {
      return false;
    }
    const probes: Array<[number, number]> = [
      [0, 0],
      [hw, hd],
      [hw, -hd],
      [-hw, hd],
      [-hw, -hd],
    ];
    for (const [ox, oz] of probes) {
      if (waterCarveAt(cx + ox, cz + oz) > 0.12) return false;
      // Nothing builds near the spawn cradles: a lot pad would flatten the
      // ring's crest (the sightline guarantee), and the bowls stay bare of
      // camping cover on purpose.
      if (Math.hypot(cx + ox, 100 - Math.abs(cz + oz)) < 30) return false;
      // No road may PIERCE a lot (fronting one closely is the whole idea, so
      // the margin is just the road surface plus a doorstep).
      for (const pl of polylines) {
        if (distToPolyline(cx + ox, cz + oz, pl.pts) < pl.half + 0.2) return false;
      }
    }
    for (const [px, pz, phw, phd] of pads) {
      if (Math.abs(cx - px) < hw + phw && Math.abs(cz - pz) < hd + phd) return false;
    }
    return true;
  };

  // --- Lots along each cluster's street, alternating sides. Villages get the
  // big landmarks (and sometimes a watchtower); hamlets carry the odd ruin;
  // farms lean on barns.
  const localStreets: Array<[number, number, number, number]> = [];
  let towerPlaced = false;
  for (const a of anchors) {
    const dir: [number, number] = [Math.cos(a.axis), Math.sin(a.axis)];
    const perp: [number, number] = [-dir[1], dir[0]];
    const spacing = 8.5;
    const spanLen = Math.max(a.count - 1, 0.6) * spacing;
    let placed = 0;
    for (let i = 0; i < a.count * 8 && placed < a.count; i++) {
      const slot = a.count === 1 ? 0 : placed / (a.count - 1) - 0.5;
      // Retries wander further and flip sides, so a road or a neighbor's pad
      // in the way costs one slot position, not the whole lot.
      const along = slot * spanLen + (rng() - 0.5) * (3 + i * 0.7);
      const sideSign = (placed + i) % 2 === 0 ? 1 : -1;
      const big = a.type === "village" && placed < 3;
      let kind: LotKind = "house";
      if (a.type === "village" && !towerPlaced && placed === 3 && rng() < 0.65) kind = "tower";
      else if (a.type === "farm" && placed === 0 && rng() < 0.6) kind = "barn";
      else if (a.type === "hamlet" && rng() < 0.12) kind = "ruin";
      const w =
        kind === "tower"
          ? 7
          : kind === "barn"
            ? 10 + rng() * 3
            : Math.min(13, (big ? 9.5 : 6.5) + rng() * 4);
      const d =
        kind === "tower"
          ? 7
          : kind === "barn"
            ? 7.5 + rng() * 2
            : Math.min(11, 6 + rng() * (big ? 4.5 : 3));
      const setback = a.type === "farm" ? 3 + rng() * 6 : 1.0 + rng() * 1.5;
      const off = 2 + setback + d / 2;
      const cx = a.x + dir[0] * along + perp[0] * off * sideSign;
      const cz = a.z + dir[1] * along + perp[1] * off * sideSign;
      if (!lotClear(cx, cz, w, d)) continue;
      if (kind === "tower") towerPlaced = true;
      const front = sideFacing(-perp[0] * sideSign, -perp[1] * sideSign);
      const stories =
        kind === "tower"
          ? 3
          : kind === "barn"
            ? 2
            : kind === "ruin"
              ? 1
              : big
                ? 2 + (rng() < 0.5 ? 1 : 0)
                : rng() < 0.5
                  ? 1
                  : rng() < 0.82
                    ? 2
                    : 3;
      lots.push({
        cx,
        cz,
        w,
        d,
        front,
        stories,
        style:
          kind === "barn"
            ? "log"
            : kind === "tower"
              ? rng() < 0.5
                ? "brick"
                : "concrete"
              : styleBag[si++ % styleBag.length],
        roof:
          kind === "tower" ? "flat" : kind === "barn" ? "gable" : rng() < 0.5 ? "gable" : "flat",
        ladder: kind === "tower" ? true : rng() < 0.5,
        kind,
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

  // Top-up: crowded seeds (rivers, hills, roads in all the wrong places) can
  // starve the clusters — back-fill outlying lots around the hamlets until
  // the settlement is worth fighting over.
  for (let i = 0; i < 160 && lots.length < 26; i++) {
    const a = anchors[i % anchors.length];
    if (a.type === "farm") continue;
    const ang = rng() * Math.PI * 2;
    const dist = 10 + rng() * 14;
    const w = 6.5 + rng() * 4;
    const d = 6 + rng() * 3;
    const cx = a.x + Math.cos(ang) * dist;
    const cz = a.z + Math.sin(ang) * dist;
    if (!lotClear(cx, cz, w, d)) continue;
    lots.push({
      cx,
      cz,
      w,
      d,
      front: sideFacing(a.x - cx, a.z - cz),
      stories: rng() < 0.5 ? 1 : 2,
      style: styleBag[si++ % styleBag.length],
      roof: rng() < 0.5 ? "gable" : "flat",
      ladder: rng() < 0.5,
      kind: "house",
    });
    pads.push([cx, cz, w / 2 + 0.9, d / 2 + 0.9]);
  }

  // Pads are final — publish so terrainBase + road baking flatten correctly.
  FLAT_PADS = pads;

  // Bake the polylines into road segments, sampling heights from the padded
  // pre-road terrain so every lane lies flat on its own profile.
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
  for (const pl of polylines) {
    for (let i = 0; i < pl.pts.length - 1; i++) {
      pushSeg(pl.pts[i][0], pl.pts[i][1], pl.pts[i + 1][0], pl.pts[i + 1][1], pl.half);
    }
  }
  for (const [ax, az, bx, bz] of localStreets) pushSeg(ax, az, bx, bz, 2.0);
  ROAD_SEGS = roads;
  rebuildRoadGrid();

  // Conquest zones: the center house plus the four mirrored hamlet greens —
  // fair by construction, always on flat dry clearing pads. (With fewer than
  // two hamlet pairs — vanishingly rare — mirrored fallback flags fill in.)
  const zonePos: Array<[number, number]> = [];
  for (const [a, b] of hamletPairs.slice(0, 2)) {
    zonePos.push([a.x, a.z], [b.x, b.z]);
  }
  while (zonePos.length < 4) {
    // Mirrored fallback pairs, far apart from each other and from B.
    const x = 54 + zonePos.length * 6;
    const z = zonePos.length >= 2 ? -32 : 30;
    zonePos.push([-x, -z], [x, z]);
    pads.push([-x, -z, 5, 5], [x, z, 5, 5]);
  }
  // Stable lettering: A/C the pair nearer the west–east axis ends, D/E the
  // other — keeps the HUD's letters meaning "roughly where" across seeds.
  const zones = [
    { letter: "A", x: zonePos[0][0], z: zonePos[0][1], r: 12 },
    { letter: "B", x: 0, z: 0, r: 12 },
    { letter: "C", x: zonePos[1][0], z: zonePos[1][1], r: 12 },
    { letter: "D", x: zonePos[2][0], z: zonePos[2][1], r: 12 },
    { letter: "E", x: zonePos[3][0], z: zonePos[3][1], r: 12 },
  ];
  return { lots, zones, stalls, farms };
}

// ---------------------------------------------------------------------------
// Spawn sightline guarantee: nobody may see into a spawn pad from across the
// map. The shield hills usually block everything already; this pass PROVES it
// by ray-marching eye-height sightlines from a grid of field positions to a
// grid of points on each spawn pad, over a coarse sampling of the pristine
// terrain. Where a view still leaks, an ordinary-looking hill grows where the
// leaking rays bundle (mirrored, off-road so the baked road profile can't cut
// a channel back through it) and the check reruns. Terrain-only on purpose:
// buildings block plenty of views, but they're destructible — the dirt
// carries the guarantee. Runs BEFORE structures are seated, so everything
// still lands on the final ground.

function validateSpawnCover(): void {
  const cell = 1;
  const R = PLAY_HALF;
  const N = Math.floor((R * 2) / cell) + 1;
  const grid = new Float64Array(N * N);
  const sample = (ix: number, iz: number): number => baseHeightAt(-R + ix * cell, -R + iz * cell);
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) grid[iz * N + ix] = sample(ix, iz);
  }
  const hAt = (x: number, z: number): number => {
    const fx = Math.min(N - 1.001, Math.max(0, (x + R) / cell));
    const fz = Math.min(N - 1.001, Math.max(0, (z + R) / cell));
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const a = grid[iz * N + ix];
    const b = grid[iz * N + ix + 1];
    const c = grid[(iz + 1) * N + ix];
    const d = grid[(iz + 1) * N + ix + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  };
  const EYE = 1.65;
  const CLEARANCE = 0.5; // dirt must top the ray by this much to count

  const spawnPts: Array<Array<[number, number]>> = [[], []];
  for (const ox of [-8, -4, 0, 4, 8]) {
    for (const oz of [-4, 0, 4]) {
      spawnPts[0].push([ox, -100 + oz]);
      spawnPts[1].push([ox, 100 + oz]);
    }
  }
  const threatPts: Array<[number, number]> = [];
  for (let x = -R + 2; x <= R - 2; x += 6) {
    for (let z = -R + 2; z <= R - 2; z += 6) threatPts.push([x, z]);
  }

  const refreshPatch = (hx: number, hz: number, r: number): void => {
    const i0 = Math.max(0, Math.floor((hx - r + R) / cell));
    const i1 = Math.min(N - 1, Math.ceil((hx + r + R) / cell));
    const j0 = Math.max(0, Math.floor((hz - r + R) / cell));
    const j1 = Math.min(N - 1, Math.ceil((hz + r + R) / cell));
    for (let jz = j0; jz <= j1; jz++) {
      for (let jx = i0; jx <= i1; jx++) grid[jz * N + jx] = sample(jx, jz);
    }
  };

  // Every fix stamp ever placed. A location that didn't seal its leak must
  // NEVER be re-used — stacking stamps builds an absurd tower beside the ray
  // instead of a hill under it; the candidate march moves on instead.
  const fixStamps: Array<[number, number]> = [];

  for (let iter = 0; iter < 22; iter++) {
    // tx,tz,sx,sz per leaking pair (first leaking pad point per threat).
    const leaks: Array<[number, number, number, number]> = [];
    for (let team = 0; team < 2; team++) {
      const sZ = team === 0 ? -100 : 100;
      for (const [tx, tz] of threatPts) {
        // "Across the map" means beyond ~60m: closer flanks (including
        // climbing the cradle hills themselves) are close-range gameplay the
        // defenders can answer.
        if (Math.hypot(tx, tz - sZ) < 62) continue;
        const eyeT = hAt(tx, tz) + EYE;
        for (const [sx, sz] of spawnPts[team]) {
          const eyeS = hAt(sx, sz) + EYE;
          const dist = Math.hypot(sx - tx, sz - tz);
          let blocked = false;
          for (let t = 3; t < dist - 3; t += 1) {
            const f = t / dist;
            if (
              hAt(tx + (sx - tx) * f, tz + (sz - tz) * f) >
              eyeT + (eyeS - eyeT) * f + CLEARANCE
            ) {
              blocked = true;
              break;
            }
          }
          if (!blocked) {
            leaks.push([tx, tz, sx, sz]);
            break;
          }
        }
      }
    }
    if (leaks.length === 0) return;

    // Bundle the leaks where their rays cross the spawn approach and grow a
    // hill at each of the densest crossings (several per pass — leak fans
    // come in bundles from different directions). Each bucket remembers the
    // steepest ray slope so a fix placed anywhere along the ray can be sized.
    interface Bucket {
      x: number;
      z: number;
      n: number;
      slope: number; // max dY/ddist of its leaking rays (from the pad out)
    }
    const buckets = new Map<number, Bucket>();
    for (const [tx, tz, sx, sz] of leaks) {
      const dx = tx - sx;
      const dz = tz - sz;
      const dist = Math.hypot(dx, dz) || 1;
      const cross = Math.min(34, Math.max(17, dist * 0.28));
      const px = sx + (dx / dist) * cross;
      const pz = sz + (dz / dist) * cross;
      const key = Math.round(px / 11) * 1000 + Math.round(pz / 11);
      const b = buckets.get(key) ?? { x: 0, z: 0, n: 0, slope: 0 };
      b.x += px;
      b.z += pz;
      b.n++;
      b.slope = Math.max(b.slope, (hAt(tx, tz) - hAt(sx, sz)) / dist);
      buckets.set(key, b);
    }
    const ranked = [...buckets.values()].sort((a, b) => b.n - a.n);
    const placedNow: Array<[number, number]> = [];
    for (const b of ranked) {
      if (placedNow.length >= 4) break;
      const cx = b.x / b.n;
      const cz = b.z / b.n;
      // Keep fixes off the roads (the baked road profile would flatten a
      // channel straight back through) and off the pads (which flatten
      // everything). Blocking works ANYWHERE along the ray, so march outward
      // until open dirt appears — the answer when the offending corridor is
      // a road running parallel under the rays. Perpendicular side-steps
      // (bigger mound, crest beside the ray) are the fallback.
      const spawnZ = cz < 0 ? -100 : 100;
      const d0 = Math.hypot(cx, cz - spawnZ) || 1;
      const dirX = cx / d0;
      const dirZ = (cz - spawnZ) / d0;
      const taken = (qx: number, qz: number): boolean =>
        onRoad(qx, qz) > 0 ||
        padFade(qx, qz) < 0.75 ||
        fixStamps.some(([fx, fz]) => Math.hypot(fx - qx, fz - qz) < 8);
      let px = -1;
      let pz = -1;
      let amp = 0;
      for (const d of [d0, 17, 21, 25, 29, 33, 37, 41, 45, 50, 55]) {
        const qx = dirX * d;
        const qz = spawnZ + dirZ * d;
        if (taken(qx, qz)) continue;
        const rayY = EYE + b.slope * d;
        px = qx;
        pz = qz;
        amp = rayY + 1.3 - hAt(qx, qz);
        break;
      }
      if (px === -1) {
        for (const off of [8, -8, 12, -12]) {
          const qx = cx - dirZ * off;
          const qz = cz + dirX * off;
          if (taken(qx, qz)) continue;
          px = qx;
          pz = qz;
          amp = (EYE + b.slope * d0 + 1.3 - hAt(qx, qz)) * 1.6;
          break;
        }
      }
      if (px === -1) continue;
      if (placedNow.some(([qx, qz]) => Math.hypot(qx - px, qz - pz) < 12)) continue;
      amp = Math.min(4.6, Math.max(1.6, amp));
      const r = Math.max(11, Math.min(17, amp * 4.2));
      // Single stamp, only where the leak is — the map is asymmetric, so a
      // mirrored twin would be a hill with no job.
      HILLS.push([px, pz, r, amp]);
      refreshPatch(px, pz, r);
      placedNow.push([px, pz]);
      fixStamps.push([px, pz]);
    }
    if (placedNow.length === 0) return; // nowhere left to raise ground: stop
  }
}

// ---------------------------------------------------------------------------

function buildMap(): MapDef {
  nextPanelId = 1;
  nextBuildingId = 0;
  FLAT_PADS = [];
  ROAD_SEGS = [];
  ROAD_GRID = new Map();
  // Seed-derived planning, in fixed order: noise permutation, water, hills,
  // then the settlement layout (which bakes the roads), then the terrain-only
  // sightline guarantee — all BEFORE any structure is seated, so everything
  // lands on the final ground.
  terrainNoise2D = createNoise2D(mulberry32(SEED ^ 0x5eed));
  planWater(mulberry32(subSeed(0x11)));
  planHills(mulberry32(subSeed(0x22)));
  const rng = mulberry32(SEED);
  const g: Gen = { statics: [], panels: [], buildings: [], slabs: [], ladders: [] };
  const half = SIZE / 2;

  // No perimeter walls: the world extends into a backdrop and an out-of-bounds
  // timer keeps players in (see sim/client). The layout fills FLAT_PADS +
  // ROAD_SEGS before any geometry is seated on the terrain.
  LAYOUT = planLayout(rng);
  validateSpawnCover();

  // Buildings: each lot fronts its street; the first lot is the fixed center
  // house. Most buildings get multiple entrances (a back door for through-flow,
  // often a side door too) so fights have several ways in/out — building()
  // relocates any west door off the stairwell on multi-story houses.
  LAYOUT.lots.forEach((lot, li) => {
    const f = lot.front;
    // The fixed center house keeps exactly its north door (tests breach its
    // solid south wall); every other building gets multiple entrances.
    const fixedCenter = li === 0 && lot.cx === 0 && lot.cz === 0;
    if (lot.kind === "ruin") {
      ruin(g, lot.cx, lot.cz, lot.w, lot.d, rng);
      return;
    }
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
      barn: lot.kind === "barn",
      parapet: lot.kind === "tower" || (lot.roof === "flat" && !fixedCenter && rng() < 0.4),
      porch: lot.kind === "house" && !fixedCenter && lot.stories <= 2 && rng() < 0.4,
      chimney: lot.kind === "house" && lot.style === "brick" && rng() < 0.55,
    });
  });

  // Procedural scatter for everything else, rejected against keep-outs.
  const placed: Array<[number, number, number]> = []; // x, z, radius
  const clearOf = (x: number, z: number, r: number): boolean => {
    if (Math.abs(x) > half - 4 || Math.abs(z) > half - 4) return false;
    if (x + r > DUEL_LANE_X - 4 && x - r < DUEL_LANE_X + 4 && Math.abs(z) - r < 45) return false; // duel lane
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

  // A well on each hamlet green (the village has its market square instead;
  // zone B sits on the center house, so skip it).
  for (const zn of LAYOUT.zones) {
    if (zn.letter === "B") continue;
    well(g, zn.x, zn.z);
    placed.push([zn.x, zn.z, 2.4]);
  }

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

  // Trees: a dart pass filtered by a forest-density noise mask biased per
  // biome — forest cells grow real woods with soft edges and natural
  // clearings, meadows keep scattered field trees, the rocky tops sparse
  // conifers, marshes a few scrubby broadleaf. Species follow the biome
  // inside tree(). Capped hard: trees are the panel budget's biggest
  // customer.
  const treeRng = mulberry32(subSeed(0x7e));
  const TREE_CAP = 170; // trimmed a touch: the denser settlement takes the panels
  const treeBias = [-0.14, 0.2, -0.08, -0.02]; // meadow, forest, rocky, marsh
  let treeCount = 0;
  for (let i = 0; i < 2600 && treeCount < TREE_CAP; i++) {
    const x = (treeRng() * 2 - 1) * (half - 6);
    const z = (treeRng() * 2 - 1) * (half - 6);
    const keepCoreOpen = treeRng();
    const loneRoll = treeRng();
    if (Math.hypot(x, z) < 26 && keepCoreOpen < 0.7) continue; // the plaza approach stays readable
    const b = biomeAt(x, z);
    const density = fbm2(x + 5200, z + 5200, 3, 1 / 52) * 0.5 + 0.5 + treeBias[b];
    if (density < 0.46) continue;
    if (density < 0.56 && loneRoll > 0.12) continue; // lone field trees only
    const spacing = density > 0.72 ? 2.1 : 3.1;
    if (!clearOf(x, z, spacing)) continue;
    tree(g, x, z, treeRng, b);
    placed.push([x, z, spacing]);
    treeCount++;
  }

  // Boulder clusters — most live on the rocky high ground.
  const rockRng = mulberry32(subSeed(0x5c));
  for (let i = 0; i < 56; i++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const x = (rockRng() * 2 - 1) * (half - 5);
      const z = (rockRng() * 2 - 1) * (half - 5);
      const offBiomeRoll = rockRng();
      if (biomeAt(x, z) !== BIOME_ROCKY && offBiomeRoll < 0.72) continue;
      if (!clearOf(x, z, 2.0)) continue;
      rocks(g, x, z, rockRng);
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

  // Hedgerows: field boundaries lacing the open meadows (woods and rocky
  // ground grow their own cover).
  for (let i = 0; i < 22; i++) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = (rng() * 2 - 1) * (half - 10);
      const z = (rng() * 2 - 1) * (half - 10);
      if (biomeAt(x, z) !== BIOME_MEADOW) continue;
      if (!clearOf(x, z, 3)) continue;
      const ang = rng() * Math.PI;
      const L = 4 + rng() * 6;
      hedge(
        g,
        x - Math.cos(ang) * L * 0.5,
        z - Math.sin(ang) * L * 0.5,
        x + Math.cos(ang) * L * 0.5,
        z + Math.sin(ang) * L * 0.5,
      );
      placed.push([x, z, 3]);
      break;
    }
  }

  // Woodpiles and barrel stacks (functional clutter, more around the core).
  for (let i = 0; i < 14; i++) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const x = (rng() * 2 - 1) * (half - 6);
      const z = (rng() * 2 - 1) * (half - 6);
      if (!clearOf(x, z, 1.8)) continue;
      const axis: "x" | "z" = rng() < 0.5 ? "x" : "z";
      const a0 = (axis === "x" ? x : z) - 1;
      masonryRun(
        g,
        axis,
        a0,
        a0 + 2,
        axis === "x" ? z : x,
        baseHeightAt(x, z),
        3,
        LOG,
        "log",
        undefined,
      );
      placed.push([x, z, 1.8]);
      break;
    }
  }
  for (let i = 0; i < 16; i++) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = (rng() * 2 - 1) * (half - 6);
      const z = (rng() * 2 - 1) * (half - 6);
      if (!clearOf(x, z, 1.3)) continue;
      barrels(g, x, z, rng);
      placed.push([x, z, 1.3]);
      break;
    }
  }

  // Fallen logs + stumps, mostly near the tree groves.
  for (let i = 0; i < 14; i++) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const x = (rng() * 2 - 1) * (half - 6);
      const z = (rng() * 2 - 1) * (half - 6);
      if (!clearOf(x, z, 2)) continue;
      fallenLog(g, x, z, rng);
      placed.push([x, z, 2]);
      break;
    }
  }

  // Lamp posts along the main road (sampled off the centerline, core only).
  for (let i = 0; i < ROAD_SEGS.length; i += 3) {
    const s = ROAD_SEGS[i];
    if (s.half < 3) continue; // main road only
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const len = Math.hypot(dx, dz) || 1;
    const side = i % 6 === 0 ? 1 : -1;
    const lx = (s.ax + s.bx) / 2 + (-dz / len) * (s.half + 1.1) * side;
    const lz = (s.az + s.bz) / 2 + (dx / len) * (s.half + 1.1) * side;
    if (!clearOf(lx, lz, 1)) continue;
    lampPost(g, lx, lz);
    placed.push([lx, lz, 1]);
  }

  // Reeds where the river meets the bank.
  for (let i = 0; i < RIVER_PTS.length; i += 4) {
    const [px, pz, phalf] = RIVER_PTS[i];
    if (Math.abs(px) > half - 6) continue;
    for (const sgn of [-1, 1]) {
      if (rng() < 0.45) continue;
      const rz = pz + sgn * (phalf + 0.8);
      if (Math.abs(rz) > half - 6) continue;
      if (onRoad(px, rz) > 0) continue;
      reeds(g, px + (rng() - 0.5) * 3, rz, rng);
    }
  }

  // ... and fringing the marsh pools.
  for (let i = 0; i < 44; i++) {
    const x = (rng() * 2 - 1) * (half - 8);
    const z = (rng() * 2 - 1) * (half - 8);
    if (biomeAt(x, z) !== BIOME_MARSH) continue;
    const h = baseHeightAt(x, z);
    if (h > 0.05 || h < WATER_SURFACE_Y - 0.2) continue; // pool rims only
    if (onRoad(x, z) > 0) continue;
    reeds(g, x, z, rng);
  }

  // Crop rows on the farm yards.
  for (const [fx, fz, axis] of LAYOUT.farms) {
    for (let k = 0; k < 2; k++) {
      const ang = rng() * Math.PI * 2;
      const x = fx + Math.cos(ang) * (9 + rng() * 6);
      const z = fz + Math.sin(ang) * (9 + rng() * 6);
      if (!clearOf(x, z, 5)) continue;
      cropRows(g, x, z, axis, rng);
      placed.push([x, z, 5]);
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

// The live map. A stable object identity — initMap REPLACES its contents so
// every importer (client renderer, sim, physics, bot nav, tools) sees the new
// world without re-importing anything. Built at module load from the default
// seed, so tests and offline tools get the fixture map with no ceremony.
export const MAP: MapDef = {
  size: SIZE,
  statics: [],
  panels: [],
  buildings: [],
  slabs: [],
  ladders: [],
  spawns: [
    [0, 0.1, -100],
    [0, 0.1, 100],
  ],
};

// Rebuild the world from `seed`. Idempotent per seed: reconnecting clients
// call it on every welcome and only pay when the seed actually changed.
// Craters reset with the rebuild — destruction state arrives separately.
export function initMap(seed: number): void {
  const s = seed >>> 0;
  if (s === SEED && MAP.panels.length > 0) return;
  SEED = s;
  rebuildMap();
}

function rebuildMap(): void {
  resetCraters();
  const def = buildMap();
  MAP.statics = def.statics;
  MAP.panels = def.panels;
  MAP.buildings = def.buildings;
  MAP.slabs = def.slabs;
  MAP.ladders = def.ladders;
  MAP.spawns = def.spawns;
  ZONES.length = 0;
  for (const zn of LAYOUT.zones) ZONES.push(zn);
}

// ---------------------------------------------------------------------------
// Conquest zones: capturable flags at the center house and four mirrored
// hamlet greens. Hold the majority to bleed enemy tickets. Computed by the
// layout so they always sit on real clearings. Stable array identity: exactly
// five entries (A–E) every seed; initMap swaps the positions in place.

export interface ZoneDef {
  letter: string;
  x: number;
  z: number;
  r: number;
}

export const ZONES: ZoneDef[] = [];

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

// No spawn camping: the enemy's home bowl is off limits. Standing inside it
// starts the same return-or-die countdown as leaving the battlefield (the
// cradle hills are deliberately walkable — the bowl has many ways out, so
// dirt alone can't keep intruders away). Radius covers the pad and the
// inside of the cradle ring.
export const ENEMY_BASE_RADIUS = 26;

export function inEnemyBase(team: number, x: number, z: number): boolean {
  const base = MAP.spawns[team === 0 ? 1 : 0];
  return Math.hypot(x - base[0], z - base[2]) < ENEMY_BASE_RADIUS;
}

// Module-load build from the default seed (after every declaration above).
rebuildMap();
