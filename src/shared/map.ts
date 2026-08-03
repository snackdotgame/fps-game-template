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
  | "adobe" // sun-dried mud block: big, thick, soft — arid vernacular
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
  | "frond" // one big palm leaf: a folded, tapered blade on its own bearing
  | "bough" // one conifer tier: a skirt of needles, cone-shaped
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
  // Render-scale override for pieces whose MESH is not the shape of their box.
  // A palm frond is a long blade pointing off on some diagonal bearing: its
  // mesh is scaled by `vis` and turned by `rot`, while ex/ey/ez stay the
  // world-space bounds the collider needs — merged slab bodies and pieceAt()
  // are AABB-only, so the box has to remain the honest one.
  vis?: [number, number, number];
  // A broken-off fragment of a destroyed piece — renders with fractured
  // geometry (jagged break face) instead of the pristine shape.
  broken?: boolean;
}

// Max HP per material. Rifle hits chip 10, sledge swings 50.
export const PANEL_HP: Record<PanelMaterial, number> = {
  brick: 45,
  adobe: 60, // soft material, but the blocks are three times a brick
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
  frond: 25, // a leaf: shoot it off in one burst
  bough: 30, // as tough as any other foliage
  stair: 100000, // effectively indestructible (also blast-exempt in sim)
};

export interface BuildingDef {
  id: number;
  kind: "building" | "tree";
  // Which generator produced this, for `npm run review:entities`. Purely
  // descriptive — nothing in the sim or the client branches on it — but
  // without it an audit can only say "some structure is broken".
  sub?: string;
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
// Adobe blocks are cast, not fired: far bigger than a brick and much thicker,
// so an arid wall reads as a handful of heavy slabs where a temperate one
// reads as a thousand little ones. That also makes arid settlements cost a
// fraction of the panels a brick one does, which is what lets them be dense.
export const ADOBE = { l: 0.9, h: WALL_HEIGHT / 6, t: 0.42 };
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
function subSeedOf(seed: number, label: number): number {
  let h = (seed ^ Math.imul(label, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function subSeed(label: number): number {
  return subSeedOf(SEED, label);
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
// gaps only at the two road gates; more hills wander midfield
// wherever they land (the map is random; only the flags are near-mirrored),
// and the sightline validator appends extras wherever a view still leaks.
let HILLS: Array<[number, number, number, number]> = [];

// Runtime maps rotate through seeds whose spawn-cover repair hills were
// exhaustively ray-marched offline. Applying these few stamps is effectively
// free; running the repair search on every client and server took 1-8 seconds.
export const CURATED_MAP_SEEDS = [
  1839804969, // Temperate
  2086861921, // Temperate (island)
  2657719470, // Snowfield
  3034562417, // Snowfield (island)
  1932791302, // Desert
  1896408263, // Desert (island)
  3191924140, // Tropical
  3673718844, // Tropical (island)
  2410523286, // Savanna
  3435063619, // Savanna (island)
  1511932964, // Badlands
] as const;
const CURATED_SPAWN_REPAIRS: Readonly<
  Record<number, ReadonlyArray<readonly [number, number, number, number]>>
> = {
  // Temperate
  1839804969: [
    [-20.931767, -94.784205, 17, 1.6],
    [-39.20069, -80.078269, 17, 1.6],
    [-20.73778, 83.013913, 17, 1.6],
    [36.289664, 84.132136, 11, 1.6],
    [-25.485246, 92.082611, 17, 1.6],
    [-41.473956, 83.648762, 11, 1.6],
    [23.567412, 94.944538, 17, 1.6],
    [-42.537374, -89.358561, 11, 1.6],
    [-33.603444, 81.628626, 12.488413, 2.973432],
    [-59.807505, 65.673254, 17, 4.594723],
    [16.182366, 98.608047, 17, 1.6],
    [-43.412876, -73.2878, 17, 1.6],
    [-32.405204, 89.490834, 17, 4.729806],
    [19.259676, 86.693929, 17, 1.6],
    [44.510322, 79.266336, 11, 1.6],
    [-50.635256, 54.088328, 17, 2.627687],
    [31.082379, 95.586081, 17, 1.6],
    [-28.97615, 73.038468, 17, 5.4],
    [44.420398, 86.669864, 17, 1.6],
    [-24.383573, -85.116713, 11, 1.6],
    [-32.532304, -76.302237, 11, 1.6],
    [-31.334524, 65.351768, 17, 5.4],
    [-15.399335, -87.898763, 17, 1.6],
    [38.828078, 75.504299, 11, 1.6],
    [-31.334524, 65.351768, 17, 1.6],
    [-28.854688, -92.724028, 11, 1.6],
    [-23.658778, 84.007049, 11, 1.6],
    [-13.303825, 82.689479, 17, 1.6],
    [-41.851, 78.559249, 17, 1.6],
    [-16.379373, 83.959756, 17, 1.6],
    [-21.260591, 79.576622, 17, 1.6],
    [-33.894234, 81.672106, 17, 1.6],
    [-28.184799, 69.326971, 17, 1.6],
    [-25.065003, 93.63239, 17, 1.6],
    [-41.851, 78.559249, 17, 1.6],
    [-20.020815, 76.665476, 17, 1.6],
  ],
  // Temperate (island)
  2086861921: [
    [17.028347, -82.666986, 17, 1.6],
    [-27.174082, -95.338376, 17, 1.6],
    [20.750175, 95.324963, 17, 1.6],
    [-21.185413, 83.845487, 17, 1.6],
    [-22.628105, -86.323779, 17, 1.6],
    [12.304286, -87.645398, 17, 1.6],
    [20.292274, 83.048375, 17, 1.6],
    [32.833193, -80.777648, 17, 1.6],
    [-34.262773, -86.804669, 11, 1.6],
    [14.794094, 87.715383, 17, 1.6],
    [-36.114378, 79.376799, 11, 1.6],
    [-11.77627, -88.845572, 17, 1.6],
    [28.64635, 93.525971, 17, 1.6],
    [49.639186, -39.805769, 17, 1.6],
    [20.61401, -93.646071, 17, 1.6],
    [-24.258412, -79.601201, 17, 1.6],
    [40.06516, 80.770013, 17, 2.151012],
    [27.72097, -72.342568, 17, 3.890309],
    [45.291816, -45.09882, 17, 1.6],
    [-15.143356, -74.026476, 17, 1.6],
    [35.657577, 75.690494, 11, 1.952494],
    [-1.913887, -84.312766, 17, 1.6],
    [-36.334587, -94.658629, 17, 1.6],
    [-21.388306, -98.640108, 17, 1.6],
    [-26.709292, 92.19857, 11, 1.6],
    [36.583633, 89.892653, 11, 1.6],
    [-13.536267, -97.479591, 17, 1.6],
    [-50.041364, -85.775958, 11, 2.246346],
    [-40.594659, 89.973695, 11, 1.6],
    [-14.31253, 88.253204, 17, 1.6],
  ],
  // Snowfield
  2657719470: [
    [23.529151, 93.502195, 17, 1.6],
    [19.61838, -84.595801, 17, 1.6],
    [-35.617634, 83.162025, 11, 1.6],
    [-34.6223, -75.948874, 11, 1.6],
    [14.510422, 98.038058, 17, 1.6],
    [9.724441, -89.865684, 17, 1.6],
    [-22.438222, 85.376326, 17, 1.6],
    [-34.876895, 76.57103, 11, 1.6],
    [24.594236, -93.667888, 17, 1.6],
    [19.156577, 84.472749, 17, 1.6],
    [-39.207618, 89.959324, 11, 1.6],
    [-41.714768, -89.262697, 11, 1.6],
    [9.022621, 89.55288, 17, 1.6],
    [14.023498, -98.771733, 17, 1.6],
    [30.053586, 95.282001, 17, 1.6],
    [35.538827, -82.36739, 11, 1.6],
    [38.50253, 85.592008, 17, 2.218845],
    [34.201732, -91.440866, 17, 1.6],
    [49.958496, -81.07035, 11, 1.6],
    [-28.755806, 92.806799, 11, 1.6],
    [22.09297, 78.214332, 17, 1.6],
    [-24.870397, -93.078187, 11, 1.6],
    [31.474489, 88.356951, 17, 1.6],
  ],
  // Snowfield (island)
  3034562417: [
    [-24.392184, -95.174508, 17, 1.6],
    [-21.428205, 84.156594, 17, 1.6],
    [22.198672, 95.061133, 17, 1.6],
    [-39.186382, -76.050702, 11, 1.6],
    [-23.870653, 95.046166, 17, 1.6],
    [35.829101, 82.438981, 17, 1.6],
    [-45.502151, 81.714997, 11, 1.6],
    [-20.638181, -84.742953, 17, 1.6],
    [-31.527299, 76.897261, 17, 3.391507],
    [35.959627, -77.509424, 11, 1.6],
    [-31.468496, -92.858463, 11, 1.6],
    [12.756576, -88.787473, 17, 1.6],
    [20.317234, -87.991614, 17, 1.6],
    [-41.71796, -90.696751, 11, 1.6],
    [-33.48421, 96.745026, 17, 1.6],
    [40.393308, -89.701301, 11, 1.6],
    [-36.5484, 90.902071, 11, 1.6],
  ],
  // Desert
  1932791302: [
    [37.566807, 85.323143, 11, 1.6],
    [-30.910123, 84.191773, 11, 1.6],
    [-18.433504, 84.343888, 17, 1.6],
    [22.633941, -89.482597, 11, 1.6],
    [23.991033, 95.996485, 17, 1.6],
    [12.06965, -90.595036, 17, 1.6],
    [-38.275227, -78.424722, 11, 1.6],
    [38.428039, -80.613755, 11, 1.6],
    [45.896483, -85.951384, 17, 1.6],
    [15.255413, 98.614975, 17, 1.6],
    [-28.945594, 76.929197, 17, 1.6],
    [-28.11555, 92.257737, 17, 1.6],
    [20.794145, 87.784672, 17, 1.6],
    [38.961625, -87.288145, 17, 1.6],
    [28.510002, -93.998356, 11, 1.6],
    [33.303323, 95.81163, 17, 1.6],
    [13.492099, 88.239583, 17, 1.6],
    [42.248376, 95.682642, 17, 1.769305],
  ],
  // Desert (island)
  1896408263: [
    [19.081113, -83.20838, 17, 1.6],
    [-27.130816, -92.748111, 17, 1.6],
    [18.831438, 83.149298, 17, 1.6],
    [-28.340143, 83.07093, 11, 1.6],
    [11.99741, -89.227547, 17, 1.6],
    [-20.752788, -84.544755, 17, 1.6],
    [10.453103, 89.101557, 17, 1.6],
    [-40.309924, -82.178764, 17, 1.816306],
    [18.632146, -97.016821, 17, 1.6],
    [25.327587, 95.10229, 17, 1.6],
    [37.028544, -81.243866, 17, 1.6],
    [-13.645427, -86.303744, 17, 1.6],
    [14.816591, 97.841337, 17, 1.6],
    [34.524485, 92.458207, 17, 4.524535],
    [27.656201, -93.859668, 17, 1.6],
    [56.699016, -55.699007, 11, 2.149918],
    [26.300151, 85.515162, 11, 2.313615],
    [-22.388029, -77.580602, 17, 1.6],
    [-19.79751, 83.537948, 17, 1.6],
    [25.30938, -85.471871, 11, 2.20258],
    [33.232735, 81.615009, 11, 2.40515],
    [-33.723329, -77.404693, 11, 1.934384],
    [13.883935, -102.108169, 17, 1.6],
    [-34.358598, -89.500886, 17, 3.053341],
    [41.951092, 89.153544, 17, 1.6],
    [25.775293, -100.497082, 17, 1.6],
    [36.516868, -91.423644, 11, 1.6],
    [-35.914504, 82.067217, 11, 1.6],
    [32.633828, 75.756454, 17, 2.04362],
    [6.436827, 83.975939, 17, 1.6],
    [49.864236, 84.056826, 17, 1.805409],
    [36.304474, -77.410808, 11, 1.6],
    [51.485341, 76.654844, 11, 1.745384],
  ],
  // Tropical
  3191924140: [
    [19.250968, -84.883965, 17, 1.6],
    [-40.106534, -82.160176, 11, 1.6],
    [40.580077, -85.736058, 17, 1.6],
    [36.985729, 86.306972, 11, 1.6],
    [16.277218, -98.256917, 17, 1.6],
    [-27.874547, -93.305463, 11, 1.6],
    [45.871145, 82.935575, 11, 1.6],
    [-47.504234, -86.359935, 11, 1.6],
    [10.91926, -89.932776, 17, 1.6],
    [32.813494, -92.760425, 11, 1.6],
    [24.141768, 95.536602, 17, 1.6],
    [-40.005407, 88.759233, 11, 1.6],
    [26.029868, -95.571221, 17, 1.6],
    [12.831615, 98.568096, 17, 1.6],
    [30.96358, -83.311909, 11, 2.13814],
    [-36.424187, 76.313177, 11, 1.6],
    [32.48626, 94.86743, 17, 1.6],
    [29.444618, -75.493054, 17, 4.370546],
    [-22.125546, -96.653793, 17, 1.6],
    [-41.803632, -91.57301, 11, 1.6],
    [-33.76, 93.2, 11, 1.6],
  ],
  // Tropical (island)
  3673718844: [
    [17.893584, 84.417715, 17, 1.6],
    [-23.383335, -94.549313, 17, 1.6],
    [19.484134, -83.973251, 17, 1.6],
    [-20.86332, 83.472604, 17, 1.6],
    [10.827433, 88.839227, 17, 1.6],
    [-38.676727, -81.919769, 17, 1.6],
    [-24.012666, 93.709933, 17, 1.6],
    [24.583773, -93.817278, 17, 1.6],
    [16.009973, 97.448902, 17, 1.6],
    [-19.8183, -83.480033, 17, 1.6],
    [-38.231618, 78.249599, 11, 1.6],
    [37.029112, -80.193633, 11, 1.6],
    [24.785789, 95.673495, 17, 1.6],
    [-13.597011, -85.407972, 17, 1.6],
    [-64.548153, -44.617288, 11, 1.6],
    [40.866157, -86.745666, 11, 1.6],
    [22.625961, 78.926022, 17, 1.625853],
    [31.592078, 94.346273, 17, 1.6],
    [-36.456723, -74.922793, 13.145236, 3.129818],
    [-39.329874, 85.925233, 17, 1.6],
    [23.01772, 78.743484, 17, 2.544347],
    [36.779633, 85.676308, 11, 1.6],
    [-32.746572, -91.676874, 11, 1.6],
    [-43.653321, -75.402086, 17, 1.6],
    [33.718787, 79.24669, 11, 2.08769],
  ],
  // Savanna
  2410523286: [
    [19.524275, -83.025052, 17, 1.6],
    [-24.952557, -95.681848, 17, 1.6],
    [36.370438, 82.703723, 11, 1.6],
    [23.28021, 95.55275, 17, 1.6],
    [11.886716, -88.78076, 17, 1.6],
    [-20.232606, -86.448253, 17, 1.6],
    [-32.287386, -93.619622, 17, 1.6],
    [-44.128292, -81.315581, 17, 1.6],
    [17.485265, -96.885702, 17, 1.6],
    [-36.969983, -87.373901, 17, 1.6],
    [38.908839, -78.344119, 17, 1.6],
    [15.566113, 98.664431, 17, 1.6],
    [35.825415, -84.338221, 17, 1.6],
    [-42.691535, -71.254442, 17, 3.313216],
    [-23.196589, -79.531359, 17, 1.6],
    [31.412969, 95.446617, 17, 1.6],
    [24.295044, -95.786686, 17, 1.6],
    [30.463042, -78.294706, 11, 1.674256],
    [20.35275, 86.808616, 17, 1.6],
    [35.422038, 75.959874, 11, 1.6],
    [37.025479, 89.28694, 11, 1.6],
    [-31.039073, -77.196803, 17, 1.6],
    [-51.695723, -82.59538, 17, 2.601481],
    [-67.681045, -65.550487, 11, 2.371757],
    [-31.227095, -84.061121, 13.846676, 3.296828],
    [29.84, -92.08, 11, 1.6],
    [-36.855168, -70.782387, 17, 1.730386],
    [-25.514291, -92.847405, 17, 1.6],
    [-26.777392, -92.143382, 17, 1.6],
    [-26.777392, -92.143382, 17, 1.6],
    [-26.777392, -92.143382, 17, 1.6],
    [-25.514291, -92.847405, 17, 1.6],
    [-33.76524, -88.248516, 17, 1.6],
    [-44.247012, -82.406216, 17, 1.6],
    [-17.065966, -99.23001, 17, 1.6],
    [-15.270005, -88.560008, 17, 1.6],
    [-21.941956, -84.390039, 17, 1.6],
    [-50.879898, -81.634045, 17, 1.6],
  ],
  // Savanna (island)
  3435063619: [
    [17.9344, -83.332229, 17, 1.6],
    [-21.531711, 85.083555, 17, 1.6],
    [-37.002056, 79.024345, 11, 1.6],
    [28.657654, 90.978404, 11, 1.6],
    [11.74651, -88.649864, 17, 1.6],
    [39.348967, -83.175157, 17, 1.6],
    [28.499928, -91.44446, 11, 1.6],
    [21.223331, -98.128495, 17, 1.6],
    [29.406033, -78.884631, 11, 1.6],
    [30.200287, -79.013559, 11, 1.797219],
    [43.09867, -77.839, 17, 1.6],
    [36.991378, -71.008622, 11, 1.763528],
  ],
  // Badlands
  1511932964: [
    [20.130483, 84.294362, 17, 1.6],
    [-23.68641, -93.417095, 17, 1.6],
    [20.62335, -83.371019, 17, 1.6],
    [-41.576655, -85.83205, 11, 1.6],
    [11.321811, 89.006011, 17, 1.6],
    [-35.287317, -82.049995, 17, 1.6],
    [-20.847777, -83.306196, 17, 1.6],
    [35.61108, -79.911101, 11, 1.6],
    [24.941577, 97.1542, 17, 1.6],
    [-33.081682, -75.281391, 11, 1.6],
    [-13.978187, -84.18817, 17, 1.6],
    [38.201331, 81.784217, 17, 1.6],
    [15.765792, 98.618282, 17, 1.6],
    [43.051494, 76.347326, 17, 1.6],
    [-32.69278, 78.107841, 11, 1.6],
    [28.596337, -90.549482, 11, 1.6],
    [41.880067, 89.60813, 11, 1.6],
    [29.385808, 91.680198, 11, 1.6],
    [33.628526, 99.473595, 17, 1.6],
  ],
};

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

// Every base road leaves FORWARD: spawn → a waypoint at the pad's front
// corner → out through its cradle gap. Players face the field on deploy
// (the client's faceTheAction), so both exit roads sit in a fresh spawn's
// view instead of dog-legging behind the pad. The field-facing corridors
// this opens are covered by the exterior baffles and by the sightline
// validator, which grows off-road hills wherever a view still leaks.
let SPAWN_WAYPTS: [[number, number], [number, number]] = [
  [12, -94],
  [-12, 94],
];
let SPAWN_WAYPTS2: [[number, number], [number, number]] = [
  [-12, -94],
  [12, 94],
];

// Where each exit road bends once it's outside the gate (rotated toward
// midfield). The straight spawn→gate leg ends here; past the bend the exit
// axis is bare dirt, so the on-axis baffle (and the validator) can seal it.
let OUTER_WAYPTS: [[number, number], [number, number]] = [
  [30, -55],
  [-30, 55],
];
let OUTER_WAYPTS2: [[number, number], [number, number]] = [
  [-30, -55],
  [30, 55],
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
    // gap there. South-frame coordinates throughout (both z negative).
    const ringD = 21;
    const legGapAz = (wpx: number, wpz: number, gpx: number, gpz: number): number => {
      for (let t = 0; t <= 1; t += 0.05) {
        const px = wpx + (gpx - wpx) * t;
        const pz = wpz + (gpz - wpz) * t;
        if (Math.hypot(px, pz + 100) >= ringD) return Math.atan2(px, pz + 100);
      }
      return Math.atan2(gpx, gpz + 100);
    };
    const side = rng() < 0.5 ? 1 : -1;
    const gx = side * (27 + rng() * 6);
    const gz = -(86 + rng() * 4);
    GATES[team] = [gx * flip, gz * flip];
    // Front-corner waypoint: the road leaves the pad toward the field.
    const wx = side * (12 + rng() * 2);
    const wz = -(93.5 + rng() * 1.5);
    SPAWN_WAYPTS[team] = [wx * flip, wz * flip];
    const gapAz = legGapAz(wx, wz, gx, gz);
    // The second exit road leaves out the OPPOSITE front flank through its
    // own gate — the bowl is never a one-door trap, and a fresh spawn sees
    // both routes fan out ahead.
    const gx2 = -side * (27 + rng() * 6);
    const gz2 = -(86 + rng() * 4);
    GATES2[team] = [gx2 * flip, gz2 * flip];
    const wx2 = -side * (12 + rng() * 2);
    const wz2 = -(93.5 + rng() * 1.5);
    SPAWN_WAYPTS2[team] = [wx2 * flip, wz2 * flip];
    const gap2Az = legGapAz(wx2, wz2, gx2, gz2);
    // Cradle arc: hills every ~19°, wrapping past the flanks to ±120° (the
    // exit roads leave FORWARD, so the rear flanks are free for dirt now —
    // and they need it: flank-skimming rays used to be blocked by luck and
    // the validator). Gaps only at the two road gates. Stamps ADD where
    // they overlap, so amplitude is tuned for a ~4-5m ridge — enough to
    // hide the pad, low enough to stay a hill, gentle enough to walk over
    // anywhere (the countdown, not the dirt, keeps campers out). No mounds
    // INSIDE the ring: the bowl floor stays clear for the roads and the
    // validator covers whatever the gaps leak.
    for (let az = -2.09; az <= 2.09; az += 0.34) {
      // The skip window is barely wider than the road cut itself: the road
      // grades through the remaining shoulder (a sunken gate), and the
      // narrow aperture leaves slanting rays nothing to thread.
      if (Math.abs(az - gapAz) < 0.36 || Math.abs(az - gap2Az) < 0.36) continue;
      const dist = 20 + rng() * 4;
      put(Math.sin(az) * dist, -100 + Math.cos(az) * dist, 15 + rng() * 4, 2.5 + rng() * 0.6);
    }
    // Outside the gate every exit road BENDS once, around an outer waypoint
    // rotated toward midfield — so the straight in-bowl leg a fresh spawn
    // looks down is never the same line a distant scope can look up. The
    // baffle sits ON the vacated exit axis behind the bend, closing the
    // straight corridor the road itself no longer occupies; a pair of
    // gatepost mounds hugs the road just outside the gate (a defile), so
    // rays slanting through the gap at any other angle hit dirt — a far
    // baffle alone can't cover an aperture it sits 25m behind.
    for (const [az, sgn, store] of [
      [gapAz, side, OUTER_WAYPTS],
      [gap2Az, -side, OUTER_WAYPTS2],
    ] as const) {
      const outAz = az - 0.8 * sgn;
      const outD = 48 + rng() * 6;
      store[team] = [Math.sin(outAz) * outD * flip, (-100 + Math.cos(outAz) * outD) * flip];
      const baffleD = 44 + rng() * 4;
      put(Math.sin(az) * baffleD, -100 + Math.cos(az) * baffleD, 13, 3.0 + rng() * 0.4);
      for (const lat of [1, -1] as const) {
        const md = 26 + rng() * 3;
        const mAz = az + lat * (0.28 + rng() * 0.04);
        put(Math.sin(mAz) * md, -100 + Math.cos(mAz) * md, 9.5 + rng(), 2.9 + rng() * 0.4);
      }
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
// Climate: which world this seed is.
//
// Biome classification in the literature is a Whittaker diagram — temperature
// against moisture — and that is what this does, with one adaptation for the
// scale. The arena is 224m across. Classifying every ~66m cell independently
// on the diagram would seat a dune sea one cell from a snowfield, which is the
// classic failure of a naive biome grid (the usual fix is an explicit
// adjacency constraint). So the Whittaker lookup runs ONCE per seed and picks
// the map's climate, and the per-cell field below keeps its four LOCAL roles —
// open / wooded / rocky / wet. Each climate re-expresses those roles: "wooded"
// is a birch wood in the temperate, a snow-laden taiga in the snow, palms in
// the tropics, dead scrub in the desert. One coherent place per match, six
// very different places across the seed rotation.
//
// Temperature and moisture are drawn from INDEPENDENT seed hashes. Correlated
// axes collapse the diagram onto its diagonal and lose half the table.

export const CLIMATE_TEMPERATE = 0;
export const CLIMATE_SNOW = 1;
export const CLIMATE_DESERT = 2;
export const CLIMATE_TROPICAL = 3;
export const CLIMATE_SAVANNA = 4;
export const CLIMATE_BADLANDS = 5;

export const CLIMATE_NAMES = [
  "Temperate",
  "Snowfield",
  "Desert",
  "Tropical",
  "Savanna",
  "Badlands",
] as const;

// Whittaker lookup, [temperature band][moisture band], cold->hot and arid->wet.
// The cold row is snow at every moisture: the diagram's tundra/taiga/ice-sheet
// corner reads as one place at arena scale. The hot row is where moisture
// actually separates worlds — dunes, then grass savanna, then jungle.
const WHITTAKER: readonly (readonly number[])[] = [
  [CLIMATE_SNOW, CLIMATE_SNOW, CLIMATE_SNOW, CLIMATE_SNOW],
  [CLIMATE_BADLANDS, CLIMATE_TEMPERATE, CLIMATE_TEMPERATE, CLIMATE_TEMPERATE],
  [CLIMATE_DESERT, CLIMATE_SAVANNA, CLIMATE_TEMPERATE, CLIMATE_TROPICAL],
  [CLIMATE_DESERT, CLIMATE_DESERT, CLIMATE_SAVANNA, CLIMATE_TROPICAL],
];

// Sub-seed labels for the two Whittaker axes. Independent hashes: correlated
// axes collapse the diagram onto its diagonal. These particular values are
// picked so the four curated seeds spread over Snow / Temperate / Desert /
// Tropical — see planClimate.
const CLIMATE_TEMP_LABEL = 0xc2;
const CLIMATE_MOIST_LABEL = 0xd2;

// Tree silhouettes. These are FORMS, not species — what a "palm" or a "snag"
// is coloured like is the climate's business (see the client's canopy/bark
// rows), but the shape is what you read at 80m through a scope.
//   conifer   stacked tiers narrowing to a spire — taiga, temperate crags
//   broadleaf layered asymmetric crown on a stout bole — temperate farmland
//   palm      bare curving stem, radial drooping fronds — oasis, coast
//   acacia    bare stem under one wide FLAT crown — savanna
//   cactus    columnar green trunk with raised arms, no crown — desert
//   snag      dead: bare trunk, a few broken branch stubs — badlands, dunes
//   emergent  tall straight bole, small high crown, buttress roots — jungle
export type TreeForm = "conifer" | "broadleaf" | "palm" | "acacia" | "cactus" | "snag" | "emergent";

let CLIMATE: number = CLIMATE_TEMPERATE;

// The active climate. Client presentation and the generator both read this;
// it is pure seed state, so both sides agree without anything on the wire.
export function climate(): number {
  return CLIMATE;
}

export function climateName(): string {
  return CLIMATE_NAMES[CLIMATE];
}

// Per-climate generation traits. Anything that changes how a biome ROLE is
// expressed lives here rather than as scattered climate conditionals, so a new
// climate is one table row. Colors are the client's business — this is only
// what the generator itself decides: species, densities, ground relief.
interface ClimateTraits {
  // What GROWS here, per biome role (open, wooded, rocky, wet). Each entry is
  // a weighted bag of silhouettes — repeats weight the draw. This is the thing
  // that makes a world recognisable from across the map: a savanna is flat
  // acacia crowns on bare stems, a jungle is straight emergent boles, a desert
  // is columnar cactus and dead snags. Colour alone never sold the difference.
  treeForms: readonly [
    readonly TreeForm[],
    readonly TreeForm[],
    readonly TreeForm[],
    readonly TreeForm[],
  ];
  // Canopy color bands to sample for leafy crowns; repeats weight the draw.
  // Indices key the client's per-climate canopy row. Needle forms always take
  // band 5, so every climate's row 5 is its needle color.
  broadleaf: readonly number[];
  // Trunk bark ids (client palette, 2 bits): 0 default, 1 needle, 2 pale,
  // 3 the climate's oddity (dead white, palm, charred).
  paleGroveP: number; // chance a ~22m cell of wooded ground is a pale stand
  oddBarkP: number; // chance any one broadleaf takes bark 3
  // Rock strata bands to sample (client palette, 2 bits), repeats weight.
  rockBands: readonly number[];
  // Added to the tree-density mask per role — arid worlds thin right out,
  // jungles close in. Applied on top of the shared per-role bias.
  treeDensity: number;
  // Boulder-cluster count scale: badlands are strewn, jungles are buried.
  rockDensity: number;
  // Hedgerow count scale. Hedges are field boundaries — they belong to farmed
  // temperate country and read as a mistake anywhere arid, so dry climates
  // trade them for the extra boulders above.
  hedgeDensity: number;

  // --- Vernacular architecture. A climate that only repainted the ground read
  // as a palette swap, because people kept building the same house in it. Real
  // vernacular form follows climate and the materials to hand: heavy timber
  // and steep roofs under snow load, thick mud brick with a flat parapet roof
  // where rain never falls, deep shaded verandas in the wet tropics. These
  // knobs are what the lot planner reads instead of hard-coded odds.
  styleMix: readonly BuildingStyle[]; // weighted bag; repeats weight the draw
  flatRoofP: number; // roof is flat rather than gabled
  storyBias: number; // shifts the story roll: <0 low-rise, >0 stacked
  elongation: number; // >1 stretches the street frontage toward a hall
  porchP: number; // shaded veranda over the front door
  chimneyP: number; // stack up a windowless wall — only cold places heat
  parapetP: number; // crouch-cover kerb around a flat roof
  // Which special lot kinds this climate builds at all, and how often one is
  // rolled in place of a plain house. Order matters only as a weighted bag.
  specialKinds: readonly LotKind[];
  specialP: number;
  // Odds this climate's map is an ISLAND rather than mainland. The tropics are
  // mostly islands; the badlands are landlocked by definition.
  islandP: number;
}

const CLIMATE_TRAITS: readonly ClimateTraits[] = [
  // Temperate — mixed farming country: brick, timber and a little poured
  // concrete, gable and flat roofs in equal measure, chimneys on the brick.
  {
    treeForms: [
      ["broadleaf", "broadleaf", "broadleaf", "conifer"],
      ["broadleaf", "broadleaf", "conifer", "conifer"],
      ["conifer", "conifer", "conifer", "broadleaf", "snag"],
      ["broadleaf", "broadleaf", "broadleaf", "conifer"],
    ],
    broadleaf: [0, 0, 0, 0, 1, 1, 2, 2, 3, 4, 6],
    paleGroveP: 0.35,
    oddBarkP: 0.0,
    rockBands: [0, 0, 0, 0, 0, 1, 1, 2, 3, 3],
    treeDensity: 0,
    rockDensity: 1,
    hedgeDensity: 1,
    styleMix: ["brick", "log", "concrete"],
    flatRoofP: 0.5,
    storyBias: 0,
    elongation: 1,
    porchP: 0.4,
    chimneyP: 0.55,
    parapetP: 0.4,
    specialKinds: ["longhouse", "granary"],
    specialP: 0.18,
    islandP: 0.22,
  },
  // Snow — taiga conifers under snow load, pale aspen stands, bare frozen
  // ground. Building is heavy timber, low and long, with steep roofs that
  // shed the load and a chimney on nearly every one.
  {
    treeForms: [
      ["conifer", "conifer", "broadleaf", "snag"],
      ["conifer", "conifer", "conifer", "conifer", "broadleaf"],
      ["conifer", "conifer", "conifer", "snag"],
      ["conifer", "conifer", "broadleaf"],
    ],
    broadleaf: [7, 7, 7, 2, 2, 0, 1],
    paleGroveP: 0.6,
    oddBarkP: 0.18,
    rockBands: [0, 0, 0, 2, 2, 1, 3],
    treeDensity: -0.04,
    rockDensity: 1.1,
    hedgeDensity: 0.35,
    styleMix: ["log", "log", "log", "brick"],
    flatRoofP: 0.06,
    storyBias: -0.12,
    elongation: 1.35,
    porchP: 0.12,
    chimneyP: 0.85,
    parapetP: 0.15,
    specialKinds: ["longhouse", "longhouse", "granary"],
    specialP: 0.3,
    islandP: 0.18,
  },
  // Desert — dune seas, almost no canopy, sandstone outcrops. No timber to
  // build with, so it's thick mud brick and block: compact, stacked, flat
  // roofs behind a parapet, and walled courtyards against the sun and wind.
  {
    treeForms: [
      ["cactus", "cactus", "snag", "snag", "acacia"],
      ["cactus", "snag", "snag", "acacia", "palm"],
      ["cactus", "snag", "snag"],
      ["palm", "palm", "palm", "acacia"],
    ],
    broadleaf: [6, 6, 7, 7, 2],
    paleGroveP: 0.12,
    oddBarkP: 0.5,
    rockBands: [1, 1, 1, 1, 1, 0, 2],
    treeDensity: -0.13,
    rockDensity: 1.35,
    hedgeDensity: 0,
    styleMix: ["adobe", "adobe", "adobe", "concrete"],
    flatRoofP: 0.92,
    storyBias: 0.18,
    elongation: 0.85,
    porchP: 0.28,
    chimneyP: 0.03,
    parapetP: 0.85,
    specialKinds: ["compound", "compound", "granary", "roundhut"],
    specialP: 0.36,
    islandP: 0.1,
  },
  // Tropical — closed jungle canopy, dark wet greens, overgrown rock. Timber
  // frames on masonry footings, steep roofs for the rain, and a deep shaded
  // veranda on nearly everything.
  {
    treeForms: [
      ["palm", "broadleaf", "broadleaf", "emergent"],
      ["emergent", "emergent", "broadleaf", "broadleaf", "palm"],
      ["emergent", "broadleaf", "palm"],
      ["palm", "palm", "broadleaf", "emergent"],
    ],
    broadleaf: [1, 1, 1, 1, 0, 0, 2, 4],
    paleGroveP: 0.2,
    oddBarkP: 0.4,
    rockBands: [0, 0, 0, 0, 2, 2, 3],
    treeDensity: 0.18,
    // Volcanic ground: dark basalt breaking through the canopy everywhere, so
    // the tropics get MORE loose stone than anywhere but the badlands, not the
    // least of any climate.
    rockDensity: 1.45,
    hedgeDensity: 0.25,
    styleMix: ["log", "log", "brick"],
    flatRoofP: 0.12,
    storyBias: 0.05,
    elongation: 1.15,
    porchP: 0.8,
    chimneyP: 0.04,
    parapetP: 0.2,
    specialKinds: ["stilt", "stilt", "stilt", "roundhut", "longhouse", "granary"],
    specialP: 0.5,
    islandP: 0.75,
  },
  // Savanna — golden grass, sparse flat-crowned acacia, dry riverbeds.
  // Laterite brick under wide shading eaves; low, spread out, half of it
  // flat-roofed and walled against the herds.
  {
    treeForms: [
      ["acacia", "acacia", "acacia", "acacia", "snag"],
      ["acacia", "acacia", "acacia", "broadleaf", "palm"],
      ["acacia", "snag", "snag", "broadleaf"],
      ["acacia", "palm", "palm", "broadleaf"],
    ],
    broadleaf: [2, 2, 2, 6, 6, 0, 3],
    paleGroveP: 0.28,
    oddBarkP: 0.22,
    rockBands: [1, 1, 0, 0, 0, 2, 3],
    treeDensity: -0.1,
    rockDensity: 1.15,
    hedgeDensity: 0.2,
    styleMix: ["adobe", "adobe", "log"],
    flatRoofP: 0.58,
    storyBias: -0.14,
    elongation: 0.95,
    porchP: 0.62,
    chimneyP: 0.08,
    parapetP: 0.55,
    specialKinds: ["roundhut", "roundhut", "roundhut", "compound", "granary"],
    specialP: 0.48,
    islandP: 0.2,
  },
  // Badlands — cold arid rock. Stepped mesas, scorched stumps, no soil worth
  // the name and no wood either: quarried block, squat and heavy, parapets
  // everywhere because the wind takes anything lighter.
  {
    treeForms: [
      ["snag", "snag", "snag", "cactus", "conifer"],
      ["snag", "snag", "conifer", "conifer", "cactus"],
      ["snag", "snag", "snag", "conifer"],
      ["conifer", "snag", "broadleaf"],
    ],
    broadleaf: [7, 7, 6, 6, 2, 3],
    paleGroveP: 0.15,
    oddBarkP: 0.45,
    rockBands: [1, 1, 2, 2, 0, 0, 3],
    treeDensity: -0.12,
    rockDensity: 1.5,
    hedgeDensity: 0,
    styleMix: ["concrete", "concrete", "adobe"],
    flatRoofP: 0.74,
    storyBias: 0.08,
    elongation: 0.9,
    porchP: 0.18,
    chimneyP: 0.35,
    parapetP: 0.75,
    specialKinds: ["compound", "granary"],
    specialP: 0.28,
    islandP: 0.0,
  },
];

let TRAITS: ClimateTraits = CLIMATE_TRAITS[CLIMATE_TEMPERATE];

export function climateTraits(): ClimateTraits {
  return TRAITS;
}

// Roll the seed's point on the Whittaker diagram. Runs first in buildMap so
// everything downstream can read the climate.
//
// IMPORTANT: anything a climate changes that MOVES the terrain heightfield —
// dune relief, mesa steps, per-climate water, and settlement layout, since lot
// pads flatten ground — invalidates the baked spawn-cover repairs, which were
// ray-marched against one specific heightfield. That's allowed, but it means
// re-running `npm run curate:map-seeds` and pasting the new tables;
// `npm run test:map-seeds` is the detector when someone forgets.
//
// The label constants below are chosen so the four curated seeds land on four
// DIFFERENT climates — the runtime rotates through exactly those seeds, so an
// unlucky hash would hide most of the table from players.
// The Whittaker roll for any seed, WITHOUT building its map — two hashes and a
// table read. Lets a caller search seed space for a given climate cheaply
// (see the dev biome picker) instead of generating worlds to find out.
export function climateForSeed(seed: number): number {
  const s = seed >>> 0;
  const axis = (label: number): number => (subSeedOf(s, label) >>> 8) / 0x1000000;
  const band = (v: number): number => Math.min(3, Math.floor(v * 4));
  return WHITTAKER[band(axis(CLIMATE_TEMP_LABEL))][band(axis(CLIMATE_MOIST_LABEL))];
}

function planClimate(): void {
  CLIMATE = climateForSeed(SEED);
  TRAITS = CLIMATE_TRAITS[CLIMATE];
}

// ---------------------------------------------------------------------------
// Biomes: a jittered-grid Voronoi field with domain-warped borders. Each
// ~66m cell gets a seed point and a biome; a point's biome is its nearest
// seed after warping the lookup, so borders meander organically instead of
// reading as straight Voronoi edges. Biomes steer terrain character, ground
// palette (client), tree density/species, rocks, hedges and reeds — cosmetics
// and cover density, never traversability, so no side is walled in.
//
// The four ids are LOCAL ROLES, not fixed landscapes: what "forest" or "marsh"
// looks like is the active climate's business (see CLIMATE_TRAITS). Naming
// them for the temperate case is a holdover, but every consumer treats them as
// open / wooded / rocky / wet.

export const BIOME_MEADOW = 0; // open ground: meadow, dune flat, savanna grass
export const BIOME_FOREST = 1; // wooded: forest, taiga, jungle, dead scrub
export const BIOME_ROCKY = 2; // high ground: crags, mesas, icy tors
export const BIOME_MARSH = 3; // wet low ground: bog, oasis, slush, mangrove

const BIOME_CELL = 66;
const BIOME_WARP = 15;

// Cell (cx,cz) -> jittered seed point + biome id, statelessly from the seed.
// Wet ground gravitates to the river lowlands; away from water it's rare.
// Climate deliberately does NOT shift this mix: the biome field feeds
// reliefAt, and the terrain heightfield is frozen (see planClimate).
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

// Roads never exceed this grade (rise/run): the baked profile cuts bumps and
// fills dips until every piece complies, so no lane climbs a hill shoulder
// or dives off the spawn-bowl rim at a wall-like pitch.
const MAX_ROAD_GRADE = 0.15;

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
// `skipSpawnPads` ignores the two spawn pads (always FLAT_PADS[0] and [1]):
// road PAINT uses it so each base's two exit roads run visibly across the
// (already flat) pad and converge on the spawn point, instead of dying at
// the pad apron — the terrain shape everywhere still treats them as pads.
function padFade(x: number, z: number, skipSpawnPads = false): number {
  let f = 1;
  for (let i = skipSpawnPads ? 2 : 0; i < FLAT_PADS.length; i++) {
    const [cx, cz, hw, hd] = FLAT_PADS[i];
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
  // The road keeps its pull across pad aprons — killing it there let the raw
  // relief poke through a 2.5m ring around every pad, turning each exit road
  // into a wall right where it left the spawn pad. Building pads still stay
  // flat: their target blends to pad height (0) inside the fade ring, and the
  // baked profile is already cone-clamped to meet them at grade. Spawn pads
  // are skipped so the exit ramps rise smoothly across the pad itself.
  return { w: edge, targetY: targetY * padFade(x, z, true) };
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
  return { w: w * padFade(x, z, true), cobble: bestSeg.half > 3 };
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

// --- Landform ---------------------------------------------------------------
// Orthogonal to climate: the same six climates can be a piece of continent or
// an island. This is the biggest single thing you read about a map before you
// read anything else — open sea on two sides changes every route on it, and it
// costs almost nothing to render, because the client already draws one sheet
// at water level and shades a beach wherever the ground crosses it.
export const LANDFORM_MAINLAND = 0;
export const LANDFORM_ISLAND = 1;

let LANDFORM: number = LANDFORM_MAINLAND;
// Coast ellipse. The LONG axis runs north-south on purpose: both bases sit at
// z = ±100, so the island has to reach past them or a team would spawn in the
// surf. The sea therefore opens up east and west, and across the corners.
let ISLAND_RX = 90;
let ISLAND_RZ = 124;
const SEA_DEPTH = 3.4; // deep enough to read as ocean, not as a flooded field
const SEA_SHELF = 0.15; // beach width, in units of the normalized radius

export function landform(): number {
  return LANDFORM;
}

export function isIsland(): boolean {
  return LANDFORM === LANDFORM_ISLAND;
}

function planLandform(rng: () => number): void {
  LANDFORM = rng() < TRAITS.islandP ? LANDFORM_ISLAND : LANDFORM_MAINLAND;
  ISLAND_RX = 84 + rng() * 12;
  ISLAND_RZ = 122 + rng() * 8;
}

// Sea depth at (x,z); 0 on land. The coastline is that ellipse warped by fbm,
// which is what makes it read as a coast instead of a swimming pool.
function seaDepthAt(x: number, z: number): number {
  if (LANDFORM !== LANDFORM_ISLAND) return 0;
  const warp = fbm2(x + 5100, z + 5100, 3, 1 / 62) * 0.12;
  const d = Math.hypot(x / ISLAND_RX, z / ISLAND_RZ) + warp;
  if (d <= 1) return 0;
  return smooth(Math.min(1, (d - 1) / SEA_SHELF)) * SEA_DEPTH;
}

// How deep the water carve is at (x,z), before pad/road fading. >0 digs the
// channel or a lake; the small <0 lip raises a bank berm. 0 = untouched land.
// The sea folds in HERE rather than into terrainBase, so every consumer that
// already avoids water — anchor siting, lot clearance, prop scatter, road
// costs — keeps a settlement out of the surf without knowing the sea exists.
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
  return Math.max(dug, seaDepthAt(x, z));
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
function computeBaseHeightAt(x: number, z: number): number {
  const h = terrainBase(x, z);
  if (ROAD_SEGS.length === 0) return h;
  const r = roadFieldAt(x, z);
  return r.w > 0 ? h + (r.targetY - h) * r.w : h;
}

// Startup consumers repeatedly ask for the same one-metre terrain samples:
// minimap coloring, render geometry, Jolt terrain, and bot navigation. Keep a
// bounded per-map memo for exact grid points after procedural generation has
// finished. Fractional gameplay queries still take the exact uncached path.
const BASE_HEIGHT_CACHE_PAD = 10;
const BASE_HEIGHT_CACHE_MIN = -SIZE / 2 - BASE_HEIGHT_CACHE_PAD;
const BASE_HEIGHT_CACHE_N = SIZE + BASE_HEIGHT_CACHE_PAD * 2 + 1;
let baseHeightCache: Float64Array | null = null;

// Drop the memoized heights inside a stamp's footprint. HILLS is an input to
// reliefAt, so pushing a repair stamp makes every cached sample under it stale
// — and the sightline repair search reads the field back through baseHeightAt
// to decide whether the stamp worked. Without this the search is blind: it
// re-samples, sees the pre-stamp ground, concludes nothing changed, and grinds
// out hundreds of useless hills. (It used to run inside buildMap, before the
// cache was allocated, which is why the baked tables are small.)
function invalidateBaseHeightPatch(cx: number, cz: number, r: number): void {
  const cache = baseHeightCache;
  if (!cache) return;
  const lo = (v: number): number => Math.max(0, Math.floor(v - r - BASE_HEIGHT_CACHE_MIN));
  const hi = (v: number): number =>
    Math.min(BASE_HEIGHT_CACHE_N - 1, Math.ceil(v + r - BASE_HEIGHT_CACHE_MIN));
  const i0 = lo(cx);
  const i1 = hi(cx);
  const j0 = lo(cz);
  const j1 = hi(cz);
  for (let j = j0; j <= j1; j++) {
    cache.fill(Number.NaN, j * BASE_HEIGHT_CACHE_N + i0, j * BASE_HEIGHT_CACHE_N + i1 + 1);
  }
}

export function baseHeightAt(x: number, z: number): number {
  const ix = x - BASE_HEIGHT_CACHE_MIN;
  const iz = z - BASE_HEIGHT_CACHE_MIN;
  const cache = baseHeightCache;
  if (
    cache &&
    Number.isInteger(ix) &&
    Number.isInteger(iz) &&
    ix >= 0 &&
    iz >= 0 &&
    ix < BASE_HEIGHT_CACHE_N &&
    iz < BASE_HEIGHT_CACHE_N
  ) {
    const index = iz * BASE_HEIGHT_CACHE_N + ix;
    const cached = cache[index];
    if (!Number.isNaN(cached)) return cached;
    const height = computeBaseHeightAt(x, z);
    cache[index] = height;
    return height;
  }
  return computeBaseHeightAt(x, z);
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
  const stride = n + 1;

  // Adjacent tiles share their corners. Generate the grid once instead of
  // evaluating the procedural height function four times per tile; the
  // indices below still produce exactly the same triangle surface.
  for (let iz = 0; iz <= n; iz++) {
    const z = -outer + iz * cell;
    for (let ix = 0; ix <= n; ix++) {
      const x = -outer + ix * cell;
      vertices.push(x, baseHeightAt(x, z), z);
    }
  }

  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x0 = -outer + ix * cell;
      const z0 = -outer + iz * cell;
      // Skip cells fully inside the core hole.
      if (Math.abs(x0 + cell / 2) < inner && Math.abs(z0 + cell / 2) < inner) continue;
      const a = iz * stride + ix;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
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

export type BuildingStyle = "brick" | "adobe" | "log" | "concrete";

export interface BuildingOpts {
  stories: number;
  style: BuildingStyle;
  doorSides: ReadonlyArray<0 | 1 | 2 | 3>; // some houses have several doors
  roof: "flat" | "gable";
  ladder: boolean; // exterior step-ladder to the roof/eaves
  kind?: string; // descriptive only, for `npm run review:entities`
  rng: () => number;
  // Variety knobs (all optional):
  barn?: boolean; // one big open hall + loft instead of partitioned rooms
  wagonDoor?: boolean; // 2.5m cart opening instead of a 1.3m doorway
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
  const firstPanelIdx = g.panels.length;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const unit =
    style === "brick" ? BRICK : style === "adobe" ? ADOBE : style === "log" ? LOG : CONCRETE;
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
  const doorHalf = o.wagonDoor ? 1.25 : 0.65;
  const doorTop = o.wagonDoor ? 2.45 : 2.05;
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
    // Overhang the gable ends: a roof flush with its walls is the silhouette
    // of a box with a lid, and the shadow an eave throws is most of what makes
    // a building read as built rather than extruded.
    const VERGE = 0.34;
    const along0 = (ridgeAlongX ? x0 : z0) - VERGE;
    const along1 = (ridgeAlongX ? x1 : z1) + VERGE;
    const crossBase = ridgeAlongX ? z0 : x0;
    const nAlong = Math.max(1, Math.round((along1 - along0) / PLANK.l));
    const alongL = (along1 - along0) / nAlong; // stretched to close the eaves
    // The treads are a staircase — that is what you WALK on, and the collider
    // keeps it. But a staircase is the boxiest silhouette on the map, so each
    // tread RENDERS as a slab tilted into the roof plane and stretched to the
    // slope length: consecutive slabs meet edge to edge and the gable reads as
    // one continuous pitch. Centres already lie on that plane, so the visual
    // never drifts more than half a riser from the surface underfoot.
    const pitch = Math.atan2(GABLE_RISE, gStepW);
    const slopeW = gStepW / Math.cos(pitch);
    const strip = (cross: number, y: number, down: -1 | 1, eave = false): void => {
      // Turn about the ridge, downhill toward the eave this side falls to.
      const h = (down * pitch * (ridgeAlongX ? 1 : -1)) / 2;
      const rot: [number, number, number, number] = ridgeAlongX
        ? [Math.sin(h), 0, 0, Math.cos(h)]
        : [0, 0, Math.sin(h), Math.cos(h)];
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
          rot,
          // The bottom tread renders wider than it collides, and the extra
          // hangs out past the wall as an eave — free, because `vis` never
          // touches the box.
          vis: ridgeAlongX
            ? [l, ROOF_STEP_H, slopeW + (eave ? 0.8 : 0)]
            : [slopeW + (eave ? 0.8 : 0), ROOF_STEP_H, l],
          buildingId: id,
        });
      }
    };
    for (let i = 0; i < gSteps; i++) {
      const y = height + i * GABLE_RISE + ROOF_STEP_H / 2;
      // Near side climbs as cross grows, so it falls back toward crossBase.
      strip(crossBase + (i + 0.5) * gStepW, y, -1, i === 0);
      strip(crossBase + span - (i + 0.5) * gStepW, y, 1, i === 0);
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

  // Panels are append-only with ids in push order, so this structure's
  // pieces are exactly the array tail — scanning the whole map per building
  // is quadratic and shows up in map build time once yards get dense.
  const mine = g.panels.slice(firstPanelIdx);
  g.buildings.push({
    id,
    kind: "building",
    sub: o.kind ?? "building",
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

// Procedural trees. Seven silhouettes (see TreeForm), drawn from the active
// climate's per-biome-role bag, so what grows on a savanna ridge and what
// grows on a jungle ridge are different PLANTS and not the same plant in a
// different green. The trunk is the structure — break two segments and it
// falls. Every piece is tagged with a seed band so pieceColor gives one tree a
// coherent species/season while individual clumps still vary.
function tree(g: Gen, x: number, z: number, rng: () => number, biome = BIOME_MEADOW): void {
  const slabFirst = nextPanelId;
  const id = nextBuildingId++;
  const base = baseHeightAt(x, z);
  const bag = TRAITS.treeForms[biome];
  const form = bag[Math.floor(rng() * bag.length)];
  const SEG = 0.8;
  const big = rng() < 0.22;
  const small = !big && rng() < 0.32;
  const sizeF = big ? 1.35 : small ? 0.75 : 1;

  // Trunk length in segments, per form. The bare-stemmed forms (palm, acacia,
  // emergent) run tall precisely because the silhouette IS the bare stem.
  const segs = Math.max(
    2,
    Math.round(
      (form === "conifer"
        ? 5.5
        : form === "broadleaf"
          ? 4.5
          : form === "palm"
            ? 6.5
            : form === "acacia"
              ? 5.5
              : form === "cactus"
                ? 4.5
                : form === "snag"
                  ? 5
                  : 8.5) * sizeF, // emergent
    ),
  );
  const girth0 =
    (form === "conifer"
      ? 0.3
      : form === "palm"
        ? 0.32
        : form === "acacia"
          ? 0.3
          : form === "cactus"
            ? // A saguaro is a COLUMN. At 0.42 across it was a green stick
              // with two twigs on it, which is not what anyone pictures.
              0.78
            : form === "snag"
              ? 0.46
              : form === "emergent"
                ? 0.44
                : 0.46) *
      sizeF +
    rng() * 0.06;

  // Canopy band: needle forms take band 5 (each climate's needle colour);
  // everything leafy draws from the climate's weighted list. The band is an
  // INDEX, not a colour — the client resolves it against the active climate's
  // palette row, so no extra bits go on the wire.
  const needle = form === "conifer";
  const drawn = TRAITS.broadleaf[Math.floor(rng() * TRAITS.broadleaf.length)];
  // Palms don't flower and don't turn: a blossom-red or autumn-orange frond
  // reads as a dead palm, which is not what a beach is for. Bands 3 and 4 are
  // the flowering/turning slots, so a palm that draws one falls back to green.
  const canopyBand = needle ? 5 : form === "palm" && drawn >= 3 && drawn <= 4 ? 0 : drawn;
  // Pale stands: wooded cells hash into whole groves of pale trunks (birch in
  // the temperate, aspen under snow, ghost gum on the savanna) — clumped, so
  // they read as a stand rather than salt-and-pepper.
  const paleGrove =
    (form === "broadleaf" || form === "acacia") &&
    biome === BIOME_FOREST &&
    hash2(Math.floor(x / 22) + 9001, Math.floor(z / 22) + 7001) < TRAITS.paleGroveP;
  // Bark 3 is the climate's oddity: dead white in the badlands, palm in the
  // tropics, sun-bleached driftwood in the desert. Palms and snags always take
  // it — that IS the oddity those slots were painted for.
  const bark = needle
    ? 1
    : form === "palm" || form === "snag"
      ? 3
      : paleGrove
        ? 2
        : rng() < TRAITS.oddBarkP
          ? 3
          : rng() < 0.12
            ? 2
            : 0;

  // Lean. A palm curves (each segment offsets further along one bearing); the
  // rest either stand straight or take a slight uniform tilt.
  const leanA = rng() * Math.PI * 2;
  const curve = form === "palm";
  const leanAmt = curve
    ? 0.16 + rng() * 0.12
    : form === "conifer" || form === "emergent" || form === "cactus"
      ? 0
      : (big ? 0.1 : 0.05) * (rng() < 0.5 ? 1 : 0);
  const span = segs * SEG;
  let serial = 0;
  const trunkIds: number[] = [];
  const canopyIds: number[] = [];

  // Offset of the trunk axis at height fraction f. Straight forms are a
  // constant lean; the palm bends, so its offset grows with f squared.
  const offAt = (f: number): [number, number] => {
    const t = curve ? f * f : f;
    return [Math.sin(leanA) * leanAmt * span * t, Math.cos(leanA) * leanAmt * span * t];
  };

  const trunkSeg = (
    px: number,
    py: number,
    pz: number,
    gx: number,
    gz = gx,
    h = SEG,
    material: PanelMaterial = "trunk",
  ): void => {
    trunkIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: px,
      y: py,
      z: pz,
      ex: gx,
      ey: h,
      ez: gz,
      material,
      seed:
        (material === "canopy" ? canopyBand : bark) | (serial++ << (material === "canopy" ? 3 : 2)),
      buildingId: id,
    });
  };
  // Bare woody outgrowth — a snag's broken stub, an emergent's buttress root.
  // Falls with the tree but isn't part of what holds it up.
  const limb = (cx: number, cy: number, cz: number, ex: number, ey: number, ez: number): void => {
    canopyIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: cx,
      y: cy,
      z: cz,
      ex,
      ey,
      ez,
      material: "post",
      seed: bark | (serial++ << 2),
      buildingId: id,
    });
  };
  // One palm leaf, anchored at the crown and thrown out along a bearing. The
  // MESH is a blade turned onto that bearing (`rot` + `vis`); the BOX stays
  // the world-space bounds it sweeps, because merged slab bodies and the
  // hit-resolve are AABB-only and would ignore the rotation.
  //
  // The blade mesh runs base->tip along local +X inside a unit box, with its
  // stalk at (-0.5, +0.5, 0). Orientation is yaw onto the bearing composed
  // over a pitch that cocks the leaf up out of the crown.
  const frond = (
    bx: number,
    by: number,
    bz: number,
    bearing: number,
    pitch: number,
    len: number,
    wide: number,
    drop: number,
  ): void => {
    const ca = Math.cos(bearing);
    const sa = Math.sin(bearing);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    // The blade only fills 84% of its box across the width. Fit it here rather
    // than in fitOrganicColliders(), because the box below is a ROTATED bound
    // and scaling its world axes afterwards would not mean anything.
    const wideF = wide * MESH_FIT.frond[2];
    // R = Ry(-bearing) * Rz(pitch): pitch in the blade's own plane, then swing
    // the whole leaf around to its bearing.
    const hy = -bearing / 2;
    const hp = pitch / 2;
    const [yx, yw] = [Math.sin(hy), Math.cos(hy)];
    const [pz, pw] = [Math.sin(hp), Math.cos(hp)];
    const rot: [number, number, number, number] = [yx * pz, yx * pw, yw * pz, yw * pw];
    // Stalk sits at local (-0.5, +0.5, 0), so the piece centre is half a blade
    // out along +X and half a drop down — both turned by R.
    const lx = len / 2;
    const ly = -drop / 2;
    const rx = lx * cp - ly * sp;
    const ry = lx * sp + ly * cp;
    // Exact world AABB of the rotated box: |R| applied to its half-extents.
    canopyIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: bx + rx * ca,
      y: by + ry,
      z: bz + rx * sa,
      ex: Math.abs(ca * cp) * len + Math.abs(ca * sp) * drop + Math.abs(sa) * wideF,
      ey: Math.abs(sp) * len + Math.abs(cp) * drop,
      ez: Math.abs(sa * cp) * len + Math.abs(sa * sp) * drop + Math.abs(ca) * wideF,
      material: "frond",
      rot,
      vis: [len, drop, wideF],
      seed: canopyBand | (serial++ << 3),
      buildingId: id,
    });
  };
  // One conifer tier: a cone skirt of needles. A spruce is a stack of these,
  // which is both the canonical low-poly evergreen and a quarter of the pieces
  // the old ring-of-lumps crown cost.
  const bough = (cy: number, rad: number, h: number): void => {
    canopyIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: topX,
      y: cy,
      z: topZ,
      ex: rad * 2,
      ey: h,
      ez: rad * 2,
      material: "bough",
      seed: canopyBand | (serial++ << 3),
      buildingId: id,
    });
  };
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

  // --- Trunk. A cactus IS its trunk (green, ribbed, no bark), so it stacks
  // canopy-material segments instead; everything else stacks bark.
  const cactus = form === "cactus";
  for (let s = 0; s < segs; s++) {
    const f = s / segs;
    const [ox, oz] = offAt(f);
    const taper = cactus ? 0.08 : form === "palm" ? 0.12 : 0.28;
    const gx = girth0 * (1 - taper * f);
    trunkSeg(x + ox, base + (s + 0.5) * SEG, z + oz, gx, gx, SEG, cactus ? "canopy" : "trunk");
  }
  const [tox, toz] = offAt(1);
  const topX = x + tox;
  const topZ = z + toz;
  const top = base + span;

  switch (form) {
    case "conifer": {
      // Tiers overlap so the skirts read as one ragged spire rather than a
      // stack of separate hats, and each is nudged off-axis a little so the
      // silhouette isn't a perfect solid of revolution.
      const tiers = 4 + (big ? 1 : 0);
      const baseR = (big ? 2.2 : 1.65) * (0.88 + rng() * 0.24);
      const drop = big ? 1.15 : 0.95;
      for (let t = 0; t < tiers; t++) {
        const f = 1 - t / tiers; // 1 at the bottom skirt, ~0 at the leader
        const rad = 0.34 + baseR * f * (0.9 + rng() * 0.2);
        bough(top - (tiers - 1 - t) * drop + 0.35, rad, drop * 1.85);
      }
      break;
    }
    case "broadleaf": {
      const crownR = (big ? 2.4 : small ? 1.2 : 1.8) + rng() * 0.4;
      const layers = 3 + (big ? 1 : 0);
      const ax = Math.cos(leanA + 1) * 0.3 * crownR; // light-seeking asymmetry
      const az = Math.sin(leanA + 1) * 0.3 * crownR;
      // Inner mass first. The rings alone are a hollow shell of blobs: the
      // outermost one on a small tree could sit clear of every neighbour and
      // hang in the air, and a shot-out ring left the crown see-through.
      clump(topX + ax * 0.5, top + layers * 0.3, topZ + az * 0.5, crownR, layers * 0.62, crownR);
      for (let L = 0; L < layers; L++) {
        const lf = (L + 0.6) / (layers + 0.6);
        const layerR = crownR * Math.sin(Math.PI * lf);
        // Layers overlap: at 0.85 apart they were spaced further than the
        // clumps were tall and the stack came apart between tiers.
        const cy = top - 0.3 + L * 0.72;
        const ring = 3 + Math.round(layerR * 1.1);
        for (let k = 0; k < ring; k++) {
          const a = (k / ring) * Math.PI * 2 + L;
          const rr = layerR * (0.42 + 0.4 * rng());
          const sz = 0.7 + layerR * 0.32 * (0.7 + 0.6 * rng());
          clump(
            topX + ax + Math.cos(a) * rr,
            cy - rr * 0.15,
            topZ + az + Math.sin(a) * rr,
            sz,
            sz * 0.8,
            sz,
          );
        }
      }
      break;
    }
    case "palm": {
      // 5-9 oversized leaves radiating from the crown, each ONE blade mesh.
      // That is how a stylized palm is built: the silhouette is carried by a
      // few big shapes, not by many small ones. (It is also cheaper — eight
      // pieces where the old clump-of-cubes crown cost fifty.)
      const fronds = 5 + Math.floor(rng() * 4);
      const a0 = rng() * Math.PI * 2;
      for (let k = 0; k < fronds; k++) {
        const a = a0 + (k / fronds) * Math.PI * 2 + (rng() - 0.5) * 0.5;
        const len = (big ? 3.5 : 2.7) * (0.82 + rng() * 0.36);
        // Leaves sit anywhere from cocked-up to nearly horizontal; the mesh's
        // own arc carries each one over into a drooping tip from there.
        const pitch = 0.12 + rng() * 0.5;
        frond(topX, top + 0.15, topZ, a, pitch, len, len * (0.3 + rng() * 0.12), len * 0.5);
      }
      // The crown itself: the knot of old leaf bases the fronds spring from.
      clump(topX, top + 0.1, topZ, 0.8, 0.62, 0.8);
      if (rng() < 0.6) {
        const fa = rng() * Math.PI * 2;
        clump(topX + Math.cos(fa) * 0.4, top - 0.25, topZ + Math.sin(fa) * 0.4, 0.5, 0.45, 0.5);
      }
      break;
    }
    case "acacia": {
      // The savanna signature: a wide umbrella on a bare stem. It has to have
      // DEPTH — built as two flat discs it read as a table top from the side,
      // which is the one angle you actually see it from in play. Layers now
      // shrink as they rise and the clumps are chunky enough to overlap.
      const crownR = (big ? 3.8 : small ? 2.3 : 3.0) + rng() * 0.5;
      const ax = Math.cos(leanA + 1) * 0.22 * crownR;
      const az = Math.sin(leanA + 1) * 0.22 * crownR;
      const layers = 3;
      for (let L = 0; L < layers; L++) {
        const f = L / (layers - 1);
        // Widest just above the fork, tapering to a domed top.
        const rad = crownR * (1 - f * 0.52);
        const cy = top + 0.1 + f * 1.15;
        const ring = 5 + Math.round(rad * 1.6);
        for (let k = 0; k < ring; k++) {
          const a = (k / ring) * Math.PI * 2 + L * 0.7;
          const rr = rad * (0.52 + 0.48 * rng());
          const sz = 1.0 + rad * 0.3 * (0.75 + 0.5 * rng());
          clump(
            topX + ax + Math.cos(a) * rr,
            cy - (rr / Math.max(0.001, rad)) * 0.28, // rim droops below the dome
            topZ + az + Math.sin(a) * rr,
            sz,
            0.62,
            sz,
          );
        }
      }
      // Solid heart so the underside isn't see-through from below.
      clump(topX + ax, top + 0.45, topZ + az, crownR * 0.72, 0.95, crownR * 0.72);
      break;
    }
    case "cactus": {
      // Saguaro: a thick column with arms that step out and turn up. The arms
      // MUST overlap both the stem and each other — stepping them out at a
      // fixed count left the elbow starting outside the trunk and each segment
      // short of the next, so the arms hung in the air beside the cactus.
      const arms = rng() < 0.18 ? 0 : rng() < 0.55 ? 1 : 2;
      const a0 = rng() * Math.PI * 2;
      for (let k = 0; k < arms; k++) {
        const a = a0 + k * (Math.PI * 0.7 + rng() * 0.6);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const hf = 0.32 + rng() * 0.26;
        const elbowY = base + span * hf;
        const armG = girth0 * 0.7;
        const reach = girth0 * 1.1 + 0.5 + rng() * 0.35;
        // Enough steps that consecutive centres sit closer together than a
        // segment is wide, and the first one starts inside the stem.
        const steps = Math.max(2, Math.ceil(reach / (armG * 0.7)));
        for (let e = 0; e < steps; e++) {
          const t = e / (steps - 1);
          const rr = reach * t;
          // The elbow lifts as it goes out, so the arm turns rather than
          // sticking out square.
          trunkSeg(
            x + ca * rr,
            elbowY + t * t * 0.35,
            z + sa * rr,
            armG,
            armG,
            SEG * 0.95,
            "canopy",
          );
        }
        // Upright arm, overlapping the elbow's outer end.
        const armSegs = 2 + Math.floor(rng() * 3);
        for (let e = 0; e < armSegs; e++) {
          trunkSeg(
            x + ca * reach,
            elbowY + 0.35 + (e + 0.5) * SEG * 0.85,
            z + sa * reach,
            armG,
            armG,
            SEG * 0.95,
            "canopy",
          );
        }
      }
      break;
    }
    case "snag": {
      // Dead standing timber. As a thin pole with three little nubs it read as
      // a twig; a snag is a BROKEN TREE, so it wants a heavy trunk, a splintered
      // top and a few long limbs that still hold their old reach.
      const stubs = 3 + Math.floor(rng() * 3);
      for (let k = 0; k < stubs; k++) {
        const a = rng() * Math.PI * 2;
        const hf = 0.3 + rng() * 0.6;
        const [ox, oz] = offAt(hf);
        const reach = 1.0 + rng() * 1.4;
        const rise = 0.25 + rng() * 0.6; // dead limbs angle up, not out
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        // Step count comes off the limb's TRUE length, not its horizontal
        // reach — the limb sweeps up as t^2, so a short steep one took bigger
        // strides in y than in x and came apart at the tip. Each piece is then
        // stretched to span its own step on every axis, so the chain always
        // overlaps however the reach and the rise trade off.
        const steps = Math.max(3, Math.ceil(Math.hypot(reach, rise) / 0.5));
        for (let e = 0; e < steps; e++) {
          const t = (e + 0.5) / steps;
          const g = 0.3 * (1 - t * 0.55);
          const t0 = Math.max(0, t - 1 / steps);
          limb(
            x + ox + ca * reach * t,
            base + span * hf + rise * t * t,
            z + oz + sa * reach * t,
            Math.max(g, Math.abs(ca) * (reach / steps) * 1.9),
            Math.max(g, rise * (t * t - t0 * t0) * 1.9),
            Math.max(g, Math.abs(sa) * (reach / steps) * 1.9),
          );
        }
      }
      // Splintered crown: a couple of jagged spars where the top broke off.
      const spars = 2 + Math.floor(rng() * 2);
      for (let k = 0; k < spars; k++) {
        const a = rng() * Math.PI * 2;
        const r = girth0 * (0.2 + rng() * 0.5);
        const h = 0.55 + rng() * 0.7;
        // Sunk so the spar's foot is inside the trunk. Perched on top of it,
        // a tall spar's base cleared the trunk and the splinter floated.
        limb(
          topX + Math.cos(a) * r,
          top - 0.15 + h / 2,
          topZ + Math.sin(a) * r,
          girth0 * 0.42,
          h,
          girth0 * 0.42,
        );
      }
      break;
    }
    case "emergent": {
      // Rainforest giant: a long clean bole to a small dense crown, standing
      // on buttress roots. Reading UP a bare trunk is what makes a jungle feel
      // tall rather than just cluttered.
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + rng() * 0.4;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const reach = girth0 * 1.9;
        limb(
          x + ca * reach * 0.6,
          base + 0.55,
          z + sa * reach * 0.6,
          Math.max(0.22, Math.abs(ca) * reach * 1.5),
          1.1,
          Math.max(0.22, Math.abs(sa) * reach * 1.5),
        );
      }
      const crownR = (big ? 3.2 : 2.5) + rng() * 0.4;
      // Solid heart FIRST: without it the ring clumps sat out at radius with
      // nothing bridging them back to a 0.44m bole, so half the crown was
      // floating free of the tree that was supposed to be holding it up.
      clump(topX, top + 0.35, topZ, crownR * 1.1, 1.7, crownR * 1.1);
      // Three tiers, widest in the MIDDLE. Two tiers shrinking upward made a
      // flat disc on a pole — the tree read as a lollipop where it is supposed
      // to read as a canopy spreading out above everything else.
      for (let L = 0; L < 3; L++) {
        const rad = crownR * (L === 0 ? 0.72 : L === 1 ? 1 : 0.78);
        const cy = top + 0.1 + L * 0.85;
        const ring = 4 + Math.round(rad * 1.3);
        for (let k = 0; k < ring; k++) {
          const a = (k / ring) * Math.PI * 2 + L * 0.8;
          const rr = rad * (0.45 + 0.55 * rng());
          const sz = 0.9 + rad * 0.3 * (0.7 + 0.5 * rng());
          clump(topX + Math.cos(a) * rr, cy, topZ + Math.sin(a) * rr, sz, sz * 0.7, sz);
        }
      }
      break;
    }
  }

  g.buildings.push({
    id,
    kind: "tree",
    sub: form,
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
  // Strata band, weighted per climate: sandstone dominates the desert, black
  // volcanic rock the tropics, banded rock the badlands. As with canopy bands the
  // value is an index the client resolves against the active climate's row.
  const rb = rng();
  const band = TRAITS.rockBands[Math.floor(rb * TRAITS.rockBands.length)];
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

// A round hut: an octagonal masonry drum under a stepped conical thatch roof,
// with one doorway. There is no rectangle anywhere in it, which is the whole
// point — a cluster of these reads as a different CULTURE from a street of
// gabled boxes, not as the same village repainted. Savanna and tropical.
function roundHut(
  g: Gen,
  cx: number,
  cz: number,
  w: number,
  front: 0 | 1 | 2 | 3,
  style: BuildingStyle,
  rng: () => number,
): void {
  const id = nextBuildingId++;
  const firstPanelIdx = g.panels.length;
  const unit =
    style === "brick" ? BRICK : style === "adobe" ? ADOBE : style === "log" ? LOG : CONCRETE;
  const R = w / 2;
  const SIDES = 10;
  // Huts in one cluster are hand-built, not stamped: the drum runs a course
  // taller or shorter and the thatch oversails by a varying amount.
  const rows = Math.max(2, Math.round(WALL_HEIGHT / unit.h) + (rng() < 0.35 ? 1 : 0));
  const eave = 1.16 + rng() * 0.14;
  const plate = 2 * R * Math.tan(Math.PI / SIDES);
  // Which facet the doorway lands on — the one nearest the street bearing.
  const frontAngle =
    front === 0 ? Math.PI / 2 : front === 1 ? -Math.PI / 2 : front === 2 ? 0 : Math.PI;
  const doorFacet = Math.round(((frontAngle - Math.PI / SIDES) / (Math.PI * 2)) * SIDES);
  const wallFirst = nextPanelId;
  for (let s = 0; s < SIDES; s++) {
    const a = (s / SIDES) * Math.PI * 2 + Math.PI / SIDES;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const isDoor = (((s - doorFacet) % SIDES) + SIDES) % SIDES === 0;
    for (let row = 0; row < rows; row++) {
      const y = (row + 0.5) * unit.h;
      // The doorway eats the lower courses of one facet.
      if (isDoor && y < 2.05) continue;
      // Stagger alternate courses around the drum so the joints bond.
      const jitter = row % 2 === 0 ? 0 : plate * 0.12;
      g.panels.push({
        id: nextPanelId++,
        x: cx + ca * R - sa * jitter,
        y,
        z: cz + sa * R + ca * jitter,
        ex: Math.abs(ca) > Math.abs(sa) ? unit.t : plate,
        ey: unit.h,
        ez: Math.abs(ca) > Math.abs(sa) ? plate : unit.t,
        material: style,
        buildingId: id,
      });
    }
  }
  endSlab(g, wallFirst);
  // Steep thatched cone. The panels are TILTED onto the slope (rot + vis) so
  // the roof reads as one surface rather than a stack of discs, and it is now
  // as tall as the drum is wide. Four flat rings on a shallow rise gave a
  // wedding cake under a mushroom cap, which is the thing about this hut that
  // most obviously did not work.
  //
  // As everywhere else, `rot`/`vis` turn and size the MESH while ex/ey/ez stay
  // the true world AABB — merged slab bodies and pieceAt() ignore rotation.
  const roofFirst = nextPanelId;
  const roofIds: number[] = [];
  const tiers = 6;
  const wallTop = rows * unit.h;
  const eaveR = R * eave;
  // Derived from the eave roll rather than a fresh draw: a new rng() here
  // would shift the whole downstream stream and invalidate the curated seeds.
  const roofH = R * (1.05 + (eave - 1.16) * 1.8);
  const pitch = Math.atan2(roofH, eaveR);
  const sp = Math.sin(pitch);
  const cp = Math.cos(pitch);
  const sp2 = Math.sin(pitch / 2);
  const cp2 = Math.cos(pitch / 2);
  const slant = (Math.hypot(eaveR, roofH) / tiers) * 1.15; // overlap, like shingles
  for (let t = 0; t < tiers; t++) {
    const f = (t + 0.5) / tiers;
    const rMid = eaveR * (1 - f);
    const yMid = wallTop + 0.1 + roofH * f;
    const ring = Math.max(4, Math.round(rMid * 3.0));
    const arc = ((2 * Math.PI * rMid) / ring) * 1.25;
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2 + t * 0.5;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // Yaw onto the bearing, then tip down the slope: local +X runs from the
      // ridge out to the eave, local +Z spans the arc.
      const sy = Math.sin(a / 2);
      const cy = Math.cos(a / 2);
      roofIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: cx + ca * rMid,
        y: yMid,
        z: cz + sa * rMid,
        ex: slant * Math.abs(cp * ca) + THATCH_T * Math.abs(sp * ca) + arc * Math.abs(sa),
        ey: slant * sp + THATCH_T * cp,
        ez: slant * Math.abs(cp * sa) + THATCH_T * Math.abs(sp * sa) + arc * Math.abs(ca),
        material: "plank",
        rot: [sy * sp2, -sy * cp2, -cy * sp2, cy * cp2],
        vis: [slant, THATCH_T, arc],
        buildingId: id,
      });
    }
  }
  // The apex knot the thatch is bound off against — and the plug for the hole
  // the converging rings leave at the top.
  roofIds.push(nextPanelId);
  g.panels.push({
    id: nextPanelId++,
    x: cx,
    y: wallTop + 0.1 + roofH - 0.3,
    z: cz,
    ex: Math.max(1.1, eaveR * 0.32),
    ey: 0.9,
    ez: Math.max(1.1, eaveR * 0.32),
    material: "plank",
    buildingId: id,
  });
  endSlab(g, roofFirst);
  const mine = g.panels.slice(firstPanelIdx);
  g.buildings.push({
    id,
    kind: "building",
    sub: "roundhut",
    cx,
    cz,
    w,
    d: w,
    wallPanelIds: mine.filter((p) => p.material !== "plank").map((p) => p.id),
    roofPanelIds: roofIds,
    collapseFraction: 0.5,
  });
}

// A stilt house: a timber room lifted a storey clear of the ground on posts,
// reached by a ladder, with a railed verandah and a steep gable. Wet-tropics
// vernacular, and it plays like nothing else on the map — you can run and
// shoot UNDER it, so it breaks a firing line without blocking movement.
function stiltHouse(
  g: Gen,
  cx: number,
  cz: number,
  w: number,
  d: number,
  front: 0 | 1 | 2 | 3,
  style: BuildingStyle,
  rng: () => number,
): void {
  const id = nextBuildingId++;
  const firstPanelIdx = g.panels.length;
  const unit =
    style === "brick" ? BRICK : style === "adobe" ? ADOBE : style === "log" ? LOG : CONCRETE;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const lift = 2.4 + rng() * 0.4; // clear headroom underneath
  const rows = Math.max(2, Math.round(WALL_HEIGHT / unit.h));

  // Posts on a grid under the floor.
  const postFirst = nextPanelId;
  const nx = Math.max(2, Math.round(w / 3));
  const nz = Math.max(2, Math.round(d / 3));
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      // Only the perimeter and a sparse interior grid — a forest of posts
      // underneath would defeat the point of the open undercroft.
      const edge = i === 0 || i === nx || j === 0 || j === nz;
      if (!edge && (i % 2 !== 0 || j % 2 !== 0)) continue;
      const px = x0 + (i * w) / nx;
      const pz = z0 + (j * d) / nz;
      g.panels.push({
        id: nextPanelId++,
        x: px,
        y: lift / 2,
        z: pz,
        ex: 0.28,
        ey: lift,
        ez: 0.28,
        material: "post",
        buildingId: id,
      });
    }
  }
  endSlab(g, postFirst);

  // Floor deck.
  const deckFirst = nextPanelId;
  const deckIds: number[] = [];
  const dnx = Math.max(1, Math.round(w / PLANK.l));
  const dnz = Math.max(1, Math.round(d / PLANK.w));
  for (let i = 0; i < dnx; i++) {
    for (let j = 0; j < dnz; j++) {
      deckIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: x0 + ((i + 0.5) * w) / dnx,
        y: lift + PLANK.h / 2,
        z: z0 + ((j + 0.5) * d) / dnz,
        ex: w / dnx,
        ey: PLANK.h,
        ez: d / dnz,
        material: "plank",
        buildingId: id,
      });
    }
  }
  endSlab(g, deckFirst);

  // Walls, one storey, sitting on the deck. Doorway on the front, windows on
  // the rest — the same openings vocabulary as a ground-built house.
  const walls: Array<[axis: "x" | "z", mid: number, fixed: number]> = [
    ["x", cx, z1],
    ["x", cx, z0],
    ["z", cz, x1],
    ["z", cz, x0],
  ];
  const baseY = lift + PLANK.h;
  for (let side = 0; side < 4; side++) {
    const [axis, mid, fixed] = walls[side];
    const a0 = axis === "x" ? x0 : z0;
    const a1 = axis === "x" ? x1 : z1;
    const gaps: GapRect[] =
      side === front
        ? [{ lo: mid - 0.65, hi: mid + 0.65, y0: baseY, y1: baseY + 2.05 }]
        : [{ lo: mid - 1.05, hi: mid + 1.05, y0: baseY + 1.3, y1: baseY + 2.05 }];
    masonryRun(g, axis, a0, a1, fixed, baseY, rows, unit, style, id, gaps);
  }

  // Steep gable over the top, stepped like every other roof in the world.
  const roofFirst = nextPanelId;
  const roofIds: number[] = [];
  const ridgeAlongX = w >= d;
  const span = ridgeAlongX ? d : w;
  const steps = Math.max(2, Math.round(span / 2 / PLANK.w));
  const stepW = span / 2 / steps;
  const top = baseY + rows * unit.h;
  // Same trick as the gable roof: walk the staircase, see a pitched plane.
  const pitch = Math.atan2(0.36, stepW);
  const slopeW = stepW / Math.cos(pitch);
  for (let s = 0; s < steps; s++) {
    const inset = s * stepW;
    const y = top + 0.16 + s * 0.36;
    for (const sign of [-1, 1]) {
      const off = (span / 2 - inset - stepW / 2) * sign;
      // Each half falls away from the ridge toward its own eave.
      const h = (sign * pitch * (ridgeAlongX ? 1 : -1)) / 2;
      const rot: [number, number, number, number] = ridgeAlongX
        ? [Math.sin(h), 0, 0, Math.cos(h)]
        : [0, 0, Math.sin(h), Math.cos(h)];
      roofIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: ridgeAlongX ? cx : cx + off,
        y,
        z: ridgeAlongX ? cz + off : cz,
        ex: ridgeAlongX ? w + 0.7 : stepW,
        ey: 0.36,
        ez: ridgeAlongX ? stepW : d + 0.7,
        material: "plank",
        rot,
        vis: ridgeAlongX ? [w + 0.7, 0.36, slopeW] : [slopeW, 0.36, d + 0.7],
        buildingId: id,
      });
    }
  }
  endSlab(g, roofFirst);

  // Ladder up to the deck on a blank flank.
  const flank = ((front + 2) % 4) as 0 | 1 | 2 | 3;
  const [laxis, , lfixed] = walls[flank];
  const outSign = flank === 0 || flank === 2 ? 1 : -1;
  const lalong = laxis === "x" ? cx + w * 0.28 : cz + d * 0.28;
  g.ladders.push({
    x: laxis === "x" ? lalong : lfixed + outSign * 0.2,
    z: laxis === "x" ? lfixed + outSign * 0.2 : lalong,
    nx: laxis === "x" ? 0 : outSign,
    nz: laxis === "x" ? outSign : 0,
    y1: baseY + 0.6,
  });

  const mine = g.panels.slice(firstPanelIdx);
  g.buildings.push({
    id,
    kind: "building",
    sub: "stilt",
    cx,
    cz,
    w,
    d,
    // The posts ARE the structure: shoot enough of them out and the house
    // comes down, which is a genuinely different demolition puzzle.
    wallPanelIds: mine
      .filter((p) => p.material !== "plank" && p.material !== "glass")
      .map((p) => p.id),
    roofPanelIds: [...roofIds, ...deckIds],
    collapseFraction: 0.45,
  });
}

// --- Works structures ------------------------------------------------------
// Industry doesn't use the house generator at all. These are sheet metal on a
// steel frame, not masonry courses: bigger pieces, fewer of them, and shapes a
// mason would never build. That difference is meant to be legible at range and
// under the feet — a works reads as hard cover and long straight sightlines
// where a hamlet reads as broken ground.

// Sheet steel comes in big panels; that is why a shed costs a fraction of the
// pieces a brick building of the same size would.
const SHEET = { l: 2.0, h: 1.0, t: 0.16 };

// A steel-frame hall: corrugated walls between corner and bay columns, a wide
// roller door on the front, a strip of clerestory glazing up high, and a flat
// walkable roof. Interior is one clear span — that's what a shed is for.
function shed(
  g: Gen,
  cx: number,
  cz: number,
  w: number,
  d: number,
  front: 0 | 1 | 2 | 3,
  stories: number,
  rng: () => number,
): void {
  const id = nextBuildingId++;
  const firstPanelIdx = g.panels.length;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const height = stories * WALL_HEIGHT;
  const rows = Math.max(1, Math.round(height / SHEET.h));
  const roofIds: number[] = [];
  const walls: Array<[axis: "x" | "z", mid: number, fixed: number]> = [
    ["x", cx, z1],
    ["x", cx, z0],
    ["z", cz, x1],
    ["z", cz, x0],
  ];
  // Roller door: a wagon-to-lorry sized opening, full height of the ground
  // storey. Width varies by shed — a fabrication bay is not a store.
  const doorHalf = 2.0 + rng() * 1.2;
  for (let side = 0; side < 4; side++) {
    const [axis, mid, fixed] = walls[side];
    const a0 = axis === "x" ? x0 : z0;
    const a1 = axis === "x" ? x1 : z1;
    const gaps: GapRect[] = [];
    if (side === front) {
      gaps.push({ lo: mid - doorHalf, hi: mid + doorHalf, y0: 0, y1: WALL_HEIGHT * 0.95 });
    }
    // Clerestory: a continuous glazed band under the eaves, which is what
    // makes a shed read as industrial rather than as a big blank box.
    const clerY = height - SHEET.h * 1.2;
    gaps.push({ lo: a0 + 1.2, hi: a1 - 1.2, y0: clerY, y1: clerY + SHEET.h * 0.9 });
    masonryRun(g, axis, a0, a1, fixed, 0, rows, SHEET, "metal", id, gaps);
  }
  // Frame: columns at the corners and at bay centres, standing proud.
  const colFirst = nextPanelId;
  const bays = Math.max(2, Math.round(w / (4.2 + rng() * 1.6)));
  for (const zz of [z0, z1]) {
    for (let b = 0; b <= bays; b++) {
      const px = x0 + ((x1 - x0) * b) / bays;
      g.panels.push({
        id: nextPanelId++,
        x: px,
        y: height / 2,
        z: zz,
        ex: 0.34,
        ey: height,
        ez: 0.34,
        material: "post",
        buildingId: id,
      });
    }
  }
  endSlab(g, colFirst);
  // Flat roof deck, walkable, with a low kerb — high ground in a flat yard.
  const deckFirst = nextPanelId;
  const nx = Math.max(1, Math.round(w / 2.4));
  const nz = Math.max(1, Math.round(d / 2.4));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      roofIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: x0 + ((i + 0.5) * w) / nx,
        y: height + 0.09,
        z: z0 + ((j + 0.5) * d) / nz,
        ex: w / nx,
        ey: 0.18,
        ez: d / nz,
        material: "metal",
        buildingId: id,
      });
    }
  }
  endSlab(g, deckFirst);
  // Ladder up a blank flank to the roof.
  const flank = ((front + 2) % 4) as 0 | 1 | 2 | 3;
  const [laxis, , lfixed] = walls[flank];
  const outSign = flank === 0 || flank === 2 ? 1 : -1;
  const lalong = laxis === "x" ? x0 + 1.4 : z0 + 1.4;
  g.ladders.push({
    x: laxis === "x" ? lalong : lfixed + outSign * (SHEET.t / 2),
    z: laxis === "x" ? lfixed + outSign * (SHEET.t / 2) : lalong,
    nx: laxis === "x" ? 0 : outSign,
    nz: laxis === "x" ? outSign : 0,
    y1: height + 0.6,
  });
  // Panels are append-only with ids in push order, so this structure's
  // pieces are exactly the array tail — scanning the whole map per building
  // is quadratic and shows up in map build time once yards get dense.
  const mine = g.panels.slice(firstPanelIdx);
  g.buildings.push({
    id,
    kind: "building",
    sub: "shed",
    cx,
    cz,
    w,
    d,
    wallPanelIds: mine
      .filter((p) => p.material === "metal" || p.material === "post")
      .map((p) => p.id),
    roofPanelIds: [...roofIds, ...mine.filter((p) => p.material === "glass").map((p) => p.id)],
    collapseFraction: 0.5,
  });
}

// A storage bin: an octagonal steel shell on stub legs, capped with a cone.
// Tall, narrow and hard — the landmark you give directions by, and the one
// piece of cover on a works yard that nobody shoots through.
function silo(g: Gen, cx: number, cz: number, rng: () => number, stories: number): void {
  const id = nextBuildingId++;
  const firstPanelIdx = g.panels.length;
  const R = 2.5;
  const legH = 1.5;
  const height = stories * WALL_HEIGHT;
  const SIDES = 8;
  // Every other generator plants itself on the terrain; this one indexed its
  // heights from world zero, so on any ground above sea level the silo sank
  // into the hill and on anything below it hung in the air.
  const base = baseHeightAt(cx, cz);
  // Octagon: eight flat plates, each a stack of courses.
  const wallFirst = nextPanelId;
  const rows = Math.max(1, Math.round((height - legH) / SHEET.h));
  const plate = 2 * R * Math.tan(Math.PI / SIDES); // chord of one face
  for (let s = 0; s < SIDES; s++) {
    const a = (s / SIDES) * Math.PI * 2 + Math.PI / SIDES;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let row = 0; row < rows; row++) {
      g.panels.push({
        id: nextPanelId++,
        x: cx + ca * R,
        y: base + legH + (row + 0.5) * SHEET.h,
        z: cz + sa * R,
        // The plate lies across its own radius: wide along the tangent, thin
        // along the normal. Axis-aligned boxes can only approximate that, so
        // pick whichever axis the face is more nearly square to.
        ex: Math.abs(ca) > Math.abs(sa) ? SHEET.t * 2 : plate,
        ey: SHEET.h,
        ez: Math.abs(ca) > Math.abs(sa) ? plate : SHEET.t * 2,
        material: "metal",
        buildingId: id,
      });
    }
  }
  endSlab(g, wallFirst);
  // Legs.
  const legFirst = nextPanelId;
  for (let s = 0; s < 4; s++) {
    // Every other PLATE bearing, at the plate radius. On their own 45deg ring
    // at 0.82R the legs fell between the plates and missed the shell entirely:
    // the drum was a cylinder standing on four posts it never touched, so
    // nothing tied it to the ground and shooting the legs did nothing to it.
    const a = ((s * 2) / SIDES) * Math.PI * 2 + Math.PI / SIDES;
    g.panels.push({
      id: nextPanelId++,
      x: cx + Math.cos(a) * R,
      y: base + legH / 2,
      z: cz + Math.sin(a) * R,
      ex: 0.3,
      ey: legH,
      ez: 0.3,
      material: "post",
      buildingId: id,
    });
  }
  endSlab(g, legFirst);
  // Stepped cone cap.
  const capFirst = nextPanelId;
  const capIds: number[] = [];
  for (let t = 0; t < 3; t++) {
    const rr = R * (1 - t * 0.3);
    capIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: cx,
      y: base + legH + rows * SHEET.h + 0.25 + t * 0.45,
      z: cz,
      ex: rr * 2,
      ey: 0.45,
      ez: rr * 2,
      material: "metal",
      buildingId: id,
    });
  }
  endSlab(g, capFirst);
  g.ladders.push({
    x: cx + R + 0.2,
    z: cz,
    nx: 1,
    nz: 0,
    y1: base + legH + rows * SHEET.h + 0.4,
  });
  // Panels are append-only with ids in push order, so this structure's
  // pieces are exactly the array tail — scanning the whole map per building
  // is quadratic and shows up in map build time once yards get dense.
  const mine = g.panels.slice(firstPanelIdx);
  g.buildings.push({
    id,
    kind: "building",
    sub: "silo",
    cx,
    cz,
    w: R * 2,
    d: R * 2,
    wallPanelIds: mine.filter((p) => !capIds.includes(p.id)).map((p) => p.id),
    roofPanelIds: capIds,
    collapseFraction: 0.55,
  });
}

// A squat process vessel: chest-to-head high, ringed with a catwalk kerb and
// tied to its neighbours by a low pipe run. Cover you fight around, not in.
function tank(g: Gen, cx: number, cz: number, w: number, rng: () => number): void {
  const id = nextBuildingId++;
  const firstPanelIdx = g.panels.length;
  const R = w / 2;
  const SIDES = 8;
  const h = 2.2 + rng() * 0.8;
  const rows = Math.max(1, Math.round(h / SHEET.h));
  const plate = 2 * R * Math.tan(Math.PI / SIDES);
  const base = baseHeightAt(cx, cz);
  const wallFirst = nextPanelId;
  for (let s = 0; s < SIDES; s++) {
    const a = (s / SIDES) * Math.PI * 2 + Math.PI / SIDES;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    for (let row = 0; row < rows; row++) {
      g.panels.push({
        id: nextPanelId++,
        x: cx + ca * R,
        y: base + (row + 0.5) * (h / rows),
        z: cz + sa * R,
        ex: Math.abs(ca) > Math.abs(sa) ? SHEET.t * 2 : plate,
        ey: h / rows,
        ez: Math.abs(ca) > Math.abs(sa) ? plate : SHEET.t * 2,
        material: "metal",
        buildingId: id,
      });
    }
  }
  endSlab(g, wallFirst);
  // Lid.
  const lidFirst = nextPanelId;
  const lidIds: number[] = [nextPanelId];
  g.panels.push({
    id: nextPanelId++,
    x: cx,
    y: base + h + 0.12,
    z: cz,
    ex: R * 1.9,
    ey: 0.24,
    ez: R * 1.9,
    material: "metal",
    buildingId: id,
  });
  endSlab(g, lidFirst);
  // Panels are append-only with ids in push order, so this structure's
  // pieces are exactly the array tail — scanning the whole map per building
  // is quadratic and shows up in map build time once yards get dense.
  const mine = g.panels.slice(firstPanelIdx);
  g.buildings.push({
    id,
    kind: "building",
    sub: "tank",
    cx,
    cz,
    w,
    d: w,
    wallPanelIds: mine.filter((p) => !lidIds.includes(p.id)).map((p) => p.id),
    roofPanelIds: lidIds,
    collapseFraction: 0.6,
  });
}

// A compound's courtyard wall: a chest-high mud-brick ring set back from the
// house, with one gateway on the street side. Arid vernacular — shade, wind
// break, livestock pen — and in play a piece of standing cover with exactly
// one legal approach, which is what makes pushing a desert hamlet feel unlike
// pushing a snow one. Its own building id, so it collapses on its own.
const THATCH_T = 0.34; // thickness of a roundhut thatch panel

const COURTYARD_PAD = 4.8; // yard reserved around a compound lot, in metres

function courtyard(
  g: Gen,
  cx: number,
  cz: number,
  w: number,
  d: number,
  front: 0 | 1 | 2 | 3,
  rng: () => number,
): void {
  const id = nextBuildingId++;
  const slabFirst = nextPanelId;
  const firstPanelIdx = g.panels.length;
  // Stay inside COURTYARD_PAD: the planner reserved exactly that much.
  const hw = w / 2 + 3.2 + rng() * 1.4;
  const hd = d / 2 + 3.2 + rng() * 1.4;
  const h = 1.35 + rng() * 0.25;
  const step = 0.9; // block run; short enough that a breach reads as a hole
  const gateHalf = 1.6;
  // Walk the rectangle side by side, skipping the gateway span on the front.
  const sides: Array<[number, number, number, number, 0 | 1 | 2 | 3]> = [
    [cx - hw, cz + hd, cx + hw, cz + hd, 0],
    [cx - hw, cz - hd, cx + hw, cz - hd, 1],
    [cx + hw, cz - hd, cx + hw, cz + hd, 2],
    [cx - hw, cz - hd, cx - hw, cz + hd, 3],
  ];
  for (const [ax, az, bx, bz, side] of sides) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / step));
    // Blocks have to ABUT. At 0.55 of the run they were spaced a full step
    // apart and only half that wide, so the "wall" was a picket fence you
    // could see and shoot straight through — and no structural check caught
    // it, because every block sits on the ground on its own.
    const run = (len / n) * 1.02;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      // The gateway: a gap at the middle of the street-facing side.
      if (side === front && Math.abs((t - 0.5) * len) < gateHalf) continue;
      if (onRoad(x, z) > 0) continue; // never wall off the road itself
      g.panels.push({
        id: nextPanelId++,
        x,
        y: baseHeightAt(x, z) + h * 0.5,
        z,
        ex: side >= 2 ? 0.3 : run,
        ey: h,
        ez: side >= 2 ? run : 0.3,
        material: "adobe",
        buildingId: id,
      });
    }
  }
  g.buildings.push({
    id,
    kind: "building",
    sub: "courtyard",
    cx,
    cz,
    w: hw * 2,
    d: hd * 2,
    wallPanelIds: g.panels.slice(firstPanelIdx).map((p) => p.id),
    roofPanelIds: [],
    // A garden wall carries nothing, so it never collapses as a unit — you
    // shoot a hole and step through, which is exactly the cover we want.
    collapseFraction: 1,
  });
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
    sub: "ruin",
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
// seed, wired together by an MST-plus-loops road network of jittered polylines
// that shies away from hills and fords the river where it must. Fully
// deterministic from the map seed.
//
// Nothing here is mirrored. The four conquest greens are placed freely and
// then MEASURED for fairness (see the flag search below), and each cluster
// draws its own street plan, so no two settlements — and no two halves of a
// map — lay out the same way.

// What a lot is FOR. Kind drives footprint, height, material and roof before
// the climate's own bias is applied, so a granary reads as a granary in snow
// and in sand — it just gets built out of what that climate has.
//   house     the default; the climate's bias does most of the work
//   tower     square watchtower, 3 stories, ladder to a parapet roof
//   barn      one open hall + loft, wide wagon door — farmsteads
//   ruin      roofless pre-destroyed walls (its own generator)
//   longhouse long narrow hall, steep gable — cold and wet climates
//   granary   small, tall, blank-walled store on a plinth — everywhere
//   compound  squat walled block behind a courtyard wall — arid climates
//   roundhut  octagonal drum under a conical thatch cone — savanna, tropics
//   stilt     room lifted clear of the ground on posts — wet tropics
// Industrial sites build none of the above; their structures are steel and
// concrete and have their own generators:
//   shed      wide steel-frame hall, roller door, walkable flat roof
//   silo      tall octagonal bin on legs — a landmark you navigate by
//   tank      squat wide vessel, chest-high, hard cover in the open
type LotKind =
  | "house"
  | "tower"
  | "barn"
  | "ruin"
  | "longhouse"
  | "granary"
  | "compound"
  | "roundhut"
  | "stilt"
  | "shed"
  | "silo"
  | "tank";

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

// How many lots the main village actually placed, of the count its archetype
// asked for. The village is the one settlement whose size is fixed up front
// rather than by whatever room the terrain leaves, so this is the honest
// measure of whether a seed has a town on it — see the gate in
// scripts/curate-map-seeds.ts.
export function villageLotCount(): [placed: number, wanted: number] {
  return VILLAGE_LOTS_STAT;
}
let VILLAGE_LOTS_STAT: [number, number] = [0, 0];

function planLayout(rng: () => number): Layout {
  const half = SIZE / 2;
  const pads: Array<[number, number, number, number]> = [];
  const lots: LotPlan[] = [];
  const stalls: Array<[number, number]> = [];
  const farms: Array<[number, number, number]> = [];
  const nodes: Array<[number, number]> = [];

  // Which wall (0=+z,1=-z,2=+x,3=-x) faces direction (dx,dz).
  const sideFacing = (dx: number, dz: number): 0 | 1 | 2 | 3 =>
    Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 2 : 3) : dz > 0 ? 0 : 1;

  // Spawns: flat pads + road endpoints (nodes 0 and 1). Each base's roads
  // run FORWARD: spawn → front-corner waypoint (nodes 4/5, 8/9) → out
  // through the cradle's gates (nodes 2/3, 6/7) → one bend at the outer
  // waypoints (nodes 10-13) where they join the field network. A fresh
  // spawn facing the field sees both exits ahead; a distant scope looking
  // back up either exit axis meets the on-axis baffle past the bend.
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
  nodes.push(OUTER_WAYPTS[0]);
  nodes.push(OUTER_WAYPTS[1]);
  nodes.push(OUTER_WAYPTS2[0]);
  nodes.push(OUTER_WAYPTS2[1]);

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

  // How a cluster arranges itself. Every settlement used to be one straight
  // street with lots alternating sides, which is why villages 200m apart read
  // as the same village: the plan, not the palette, is what you recognise.
  //   street  ribbon development along an axis, lots alternating sides
  //   green   lots ringing the clearing, all fronts turned in on it
  //   cluster grown-not-planned: an organic scatter with jittered frontage
  //   grid    surveyed: everything square to one axis, in rows — industry
  type PlanKind = "street" | "green" | "cluster" | "grid";
  interface Anchor {
    type: "village" | "hamlet" | "farm" | "industrial";
    x: number;
    z: number;
    axis: number;
    count: number;
    plan: PlanKind;
  }
  // --- Settlement archetype -------------------------------------------------
  // Climate decides what a place is BUILT of. This decides what KIND of place
  // it is, and it is the thing that was missing: every map ran the same
  // skeleton — one central village, five flag hamlets, farms sprinkled between
  // — so no amount of palette, architecture or vegetation work could stop two
  // maps reading as the same level. Now the macro composition itself changes.
  interface SettlementPlan {
    name: string;
    village: number; // lots in the central village; 0 means no centre at all
    villagePlan: PlanKind;
    worksCap: number; // how many flag zones may be industrial
    worksP: number;
    flagCount: [number, number]; // lots per flag settlement [base, spread]
    freeHamlets: [number, number];
    farms: [number, number];
    lotTarget: number; // how many lots the top-up pass fills toward
    bias: PlanKind | null; // forces outlying plans, for the shapeliest archetypes
  }
  const SETTLEMENTS: readonly SettlementPlan[] = [
    // A proper market town: a big plaza-centred core, modest outskirts.
    {
      name: "market town",
      village: 16,
      villagePlan: "green",
      worksCap: 1,
      worksP: 0.3,
      flagCount: [7, 4],
      freeHamlets: [2, 2],
      farms: [5, 4],
      lotTarget: 54,
      bias: null,
    },
    // No centre worth the name — holdings scattered across open country.
    {
      name: "scattered holdings",
      village: 5,
      villagePlan: "cluster",
      worksCap: 1,
      worksP: 0.25,
      flagCount: [6, 3],
      freeHamlets: [6, 3],
      farms: [9, 4],
      lotTarget: 58,
      bias: null,
    },
    // Heavy industry: works on most flags, hard right angles everywhere.
    {
      name: "industrial belt",
      village: 8,
      villagePlan: "street",
      worksCap: 4,
      worksP: 0.8,
      flagCount: [9, 4],
      freeHamlets: [2, 2],
      farms: [3, 3],
      lotTarget: 56,
      bias: null,
    },
    // Everything strung along tracks: long, thin, linear fights.
    {
      name: "ribbon settlement",
      village: 13,
      villagePlan: "street",
      worksCap: 2,
      worksP: 0.4,
      flagCount: [8, 3],
      freeHamlets: [4, 3],
      farms: [6, 4],
      lotTarget: 56,
      bias: "street",
    },
    // One dense, walled core and very little else — an urban crush.
    {
      name: "stronghold",
      village: 20,
      villagePlan: "green",
      worksCap: 1,
      worksP: 0.3,
      flagCount: [8, 3],
      freeHamlets: [1, 2],
      farms: [4, 3],
      lotTarget: 52,
      bias: "cluster",
    },
  ];
  const SETTLEMENT = SETTLEMENTS[Math.floor(rng() * SETTLEMENTS.length)];

  const rollPlan = (): PlanKind => {
    if (SETTLEMENT.bias) return SETTLEMENT.bias;
    const r = rng();
    return r < 0.45 ? "street" : r < 0.75 ? "green" : "cluster";
  };

  // One village near the center; hamlets and farms placed freely around it.
  const anchors: Anchor[] = [
    {
      type: "village",
      // Set down on the far side of the duel lane, not on the map's centre.
      // The village ring is 20-28 across and the lane corridor rolls anywhere
      // from 15 to 37 out, so a centred village was bisected by dead ground
      // about half the time — it was placing three lots in sixteen and on some
      // seeds none at all, which is most of why the maps read as all hamlets.
      x: -Math.sign(DUEL_LANE_X) * (12 + rng() * 12),
      z: -4 + (rng() * 2 - 1) * 6,
      axis: rng() < 0.5 ? 0 : Math.PI / 2,
      count: SETTLEMENT.village,
      plan: SETTLEMENT.villagePlan,
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
  // --- The four outer conquest flags (A/C, D/E): asymmetric by position,
  // balanced by measurement.
  //
  // These used to be two 180°-mirrored pairs, which bought fairness cheaply
  // but made every map read as a rotated copy of itself. A map doesn't need
  // mirrored geometry to be fair — it needs each team's PUSH to cost the same.
  // So greens now land wherever the ground allows, and a candidate set is
  // accepted only if measured approach costs come out level:
  //   · each team is cheapest to exactly two of the four (no 3–1 carve-up),
  //   · ranked by depth, flags pair off ACROSS teams within DEPTH_TOL — one
  //     team's deep flag is about as deep as the other's, while sitting
  //     nowhere near its mirror position,
  //   · and the net advantage over the whole set stays under NET_TOL.
  // Flags also keep real breathing room: at least 46m from every other flag
  // (including B at the center house).
  const FLAG_MIN_DIST = 46;
  const NET_TOL = 14; // metres of net approach cost across all four greens
  const RAW_TOL = 22; // same, on bare distance — a check on the cost proxy
  const DEPTH_TOL = 26; // metres between rank-paired opposing greens
  // Approach cost: the straight run from a spawn, surcharged for fords and
  // climbs. Not a pathfind — a cheap stand-in for how hard the push is, and
  // enough to stop one team from owning the whole easy half of the map.
  const approachCost = (sx: number, sz: number, px: number, pz: number): number => {
    const dist = Math.hypot(px - sx, pz - sz);
    const n = 10;
    let mult = 0;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const x = sx + (px - sx) * t;
      const z = sz + (pz - sz) * t;
      const wet = waterCarveAt(x, z) > 0.1 ? 0.35 : 0;
      mult += 1 + wet + Math.max(0, terrainBase(x, z) - 1.2) * 0.1;
    }
    return (dist * mult) / n;
  };
  // adv > 0 means team 0 (the south spawn) gets there cheaper. `raw` is the
  // same measure on bare distance: the surcharges above are a coarse proxy, so
  // the set has to look level on plain metres too before we trust them.
  interface Green {
    x: number;
    z: number;
    adv: number;
    raw: number;
  }
  const advOf = (px: number, pz: number): number =>
    approachCost(0, 100, px, pz) - approachCost(0, -100, px, pz);
  const rawOf = (px: number, pz: number): number =>
    Math.hypot(px, pz - 100) - Math.hypot(px, pz + 100);

  // Sample a pool of legal greens once, then search sets within it — far
  // cheaper than re-rolling positions for every candidate set.
  const pool: Green[] = [];
  for (let i = 0; i < 600 && pool.length < 96; i++) {
    const ang = rng() * Math.PI * 2;
    const rad = 46 + rng() * 42;
    const x = Math.cos(ang) * rad;
    const z = Math.sin(ang) * rad;
    if (Math.hypot(x, z) < FLAG_MIN_DIST) continue; // B holds the origin
    if (!anchorClear(x, z, 36, 68, 0.04)) continue;
    pool.push({ x, z, adv: advOf(x, z), raw: rawOf(x, z) });
  }
  const spread = (set: readonly Green[]): boolean =>
    set.every((g, i) =>
      set.every((h, j) => j <= i || Math.hypot(g.x - h.x, g.z - h.z) >= FLAG_MIN_DIST),
    );
  // Deepest-first for the south pool, deepest-first for the north pool.
  const southPool = pool.filter((g) => g.adv > 0);
  const northPool = pool.filter((g) => g.adv < 0);
  // Draw two distinct entries, deeper one first.
  const drawPair = (arr: Green[], deeper: (g: Green) => number): [Green, Green] => {
    const i = Math.floor(rng() * arr.length);
    let j = Math.floor(rng() * (arr.length - 1));
    if (j >= i) j++;
    return deeper(arr[i]) >= deeper(arr[j]) ? [arr[i], arr[j]] : [arr[j], arr[i]];
  };
  let bestSet: Green[] | null = null;
  let bestErr = Infinity;
  if (southPool.length >= 2 && northPool.length >= 2) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const [sDeep, sNear] = drawPair(southPool, (g) => g.adv);
      const [nDeep, nNear] = drawPair(northPool, (g) => -g.adv);
      const set = [sDeep, sNear, nDeep, nNear];
      if (!spread(set)) continue;
      // Rank-paired depth error, plus the net tilt of the whole set.
      const deepErr = Math.max(0, Math.abs(sDeep.adv + nDeep.adv) - DEPTH_TOL);
      const nearErr = Math.max(0, Math.abs(sNear.adv + nNear.adv) - DEPTH_TOL);
      const net = sDeep.adv + sNear.adv + nDeep.adv + nNear.adv;
      const netErr = Math.max(0, Math.abs(net) - NET_TOL);
      const rawNet = sDeep.raw + sNear.raw + nDeep.raw + nNear.raw;
      const rawErr = Math.max(0, Math.abs(rawNet) - RAW_TOL);
      const err = deepErr + nearErr + netErr + rawErr;
      if (err < bestErr) {
        bestErr = err;
        bestSet = set;
        if (err === 0) break; // inside every tolerance; stop looking
      }
    }
  }
  // Every accepted green becomes a hamlet anchor; sizes vary per green now
  // that twins no longer have to match each other.
  // Not every flag is a village green. Some are WORKS — a surveyed yard of
  // steel sheds, silos and tanks behind a fence. Fighting over a grid of hard
  // right angles and hard cover plays nothing like fighting over a green, and
  // it is the clearest signal that two flags on one map are different places.
  // Capped at two so a map never reads as all industry.
  const flagAnchors: Anchor[] = [];
  let works = 0;
  for (const g of bestSet ?? []) {
    const industrial = works < SETTLEMENT.worksCap && rng() < SETTLEMENT.worksP;
    if (industrial) works++;
    const a: Anchor = industrial
      ? {
          type: "industrial",
          x: g.x,
          z: g.z,
          // Works are surveyed: everything squares to one bearing.
          axis: rng() * Math.PI,
          count: SETTLEMENT.flagCount[0] + Math.floor(rng() * SETTLEMENT.flagCount[1]),
          plan: "grid",
        }
      : {
          type: "hamlet",
          x: g.x,
          z: g.z,
          axis: rng() * Math.PI,
          count: SETTLEMENT.flagCount[0] + Math.floor(rng() * SETTLEMENT.flagCount[1]),
          plan: rollPlan(),
        };
    anchors.push(a);
    flagAnchors.push(a);
  }
  // Free hamlets and farms land wherever they land — no mirroring. The map
  // is random; only the flag greens above are (nearly) fair-by-position.
  const nFreeHamlets = SETTLEMENT.freeHamlets[0] + Math.floor(rng() * SETTLEMENT.freeHamlets[1]);
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
        count: 5 + Math.floor(rng() * 4),
        plan: rollPlan(),
      });
      break;
    }
  }
  const nFarms = SETTLEMENT.farms[0] + Math.floor(rng() * SETTLEMENT.farms[1]);
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
        count: 2 + (rng() < 0.55 ? 1 : 0),
        plan: "street", // a farmyard is a barn and a house facing a track
      });
      break;
    }
  }

  for (const a of anchors) {
    nodes.push([a.x, a.z]);
    // A clearing pad keeps the cluster centre open and flat (plaza / green /
    // yard) — pads also zero the water carve, so every green is dry.
    const clearR =
      a.type === "village" ? 7 : a.type === "industrial" ? 8 : a.type === "hamlet" ? 5 : 3.5;
    pads.push([a.x, a.z, clearR, clearR]);
    if (a.type === "farm") farms.push([a.x, a.z, a.axis]);
  }

  // --- Road graph over the nodes, BEFORE lots: lots must reject the road
  // corridors, and the corridors only depend on the node graph.
  const N = nodes.length;
  // Forced base plumbing: spawn↔front waypoint↔gate↔outer bend waypoint
  // (nodes: 0,1 spawns · 2,3 gates · 4,5 waypoints · 6,7 second gates ·
  // 8,9 second waypoints · 10-13 outer waypoints). Nothing else may touch a
  // spawn, waypoint, or gate node — the network attaches at the outer
  // waypoints, past the bend, so no field edge can straighten an exit axis.
  const FORCED: ReadonlyArray<[number, number]> = [
    [0, 4],
    [4, 2],
    [2, 10],
    [1, 5],
    [5, 3],
    [3, 11],
    [0, 8],
    [8, 6],
    [6, 12],
    [1, 9],
    [9, 7],
    [7, 13],
  ];
  const forced = (i: number, j: number): boolean =>
    FORCED.some(([a, b]) => (a === i && b === j) || (a === j && b === i));
  const isPlumbing = (n: number): boolean => n < 10;
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

  // --- Lots, laid out by each cluster's own plan (street / green / cluster).
  // Kind comes first — what the building is FOR — then the climate bends its
  // material, roof, height and proportions. Villages get the big landmarks
  // (and sometimes a watchtower); hamlets carry the odd ruin; farms lean on
  // barns; and every climate rolls its own specials from CLIMATE_TRAITS.
  const localStreets: Array<[number, number, number, number]> = [];
  let towerPlaced = false;
  // Re-site the village before anything is built. It is the only anchor that
  // was never validated — hamlets and farms get anchorClear(), the village was
  // simply dropped near the middle — and between the duel-lane corridor, the
  // roads that converge on the centre and open water it routinely landed
  // somewhere that could not hold it. It wants sixteen lots and was placing
  // three, and on some seeds none, which is why every map read as hamlets and
  // farms with no town in it. Score candidates by the only thing that matters:
  // how many of its ring slots are actually buildable.
  {
    const v = anchors[0];
    const probeR = Math.max(13, (v.count * 13) / (2 * Math.PI) + 6);
    // Scored the way the village will actually be laid out. A ring probe is
    // the wrong question for a ribbon village, and the street-plan ones were
    // being sited on a criterion that had nothing to do with where their lots
    // would go — one map ended up with no town at all.
    const vdx = Math.cos(v.axis);
    const vdz = Math.sin(v.axis);
    const vspan = Math.max(v.count - 1, 0.6) * 8.5;
    const score = (vx: number, vz: number): number => {
      let ok = 0;
      for (let k = 0; k < v.count; k++) {
        if (v.plan === "street") {
          const along = (v.count === 1 ? 0 : k / (v.count - 1) - 0.5) * vspan;
          const off = (k % 2 === 0 ? 1 : -1) * 8; // nominal setback + half depth
          const cx = vx + vdx * along - vdz * off;
          const cz = vz + vdz * along + vdx * off;
          if (lotClear(cx, cz, 10, 8)) ok++;
          continue;
        }
        const ang = (k / v.count) * Math.PI * 2;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        // A green rings a fixed radius (the retry spiral reaches the outer
        // rank); a cluster scatters through the whole disc.
        const radii = v.plan === "green" ? [probeR + 4, probeR + 13] : [11, 18, 25];
        for (const r of radii) {
          if (lotClear(vx + ca * r, vz + sa * r, 10, 8)) {
            ok++;
            break;
          }
        }
      }
      return ok;
    };
    let best = score(v.x, v.z);
    const consider = (cx: number, cz: number): void => {
      const sc = score(cx, cz);
      if (sc > best) {
        best = sc;
        v.x = cx;
        v.z = cz;
      }
    };
    for (let t = 0; t < 60 && best < v.count; t++) {
      // Off the duel lane by construction, and kept near enough to the middle
      // that the town is still the map's centre of gravity.
      consider(-Math.sign(DUEL_LANE_X) * (10 + rng() * 26), (rng() * 2 - 1) * 30);
    }
    // Some maps have no room at all on the preferred side — water, or the road
    // net, or both. Rather than leave the map with no town, widen the search to
    // the whole playable middle. Off-centre beats absent.
    for (let t = 0; t < 90 && best < 4; t++) {
      consider((rng() * 2 - 1) * (half - 46), (rng() * 2 - 1) * 46);
    }
  }
  // Weighted draw from the climate's material bag, so a snow map is timber and
  // a desert map is mud brick without either being monotonous.
  const climateStyle = (): BuildingStyle =>
    TRAITS.styleMix[Math.floor(rng() * TRAITS.styleMix.length)];
  VILLAGE_LOTS_STAT = [0, anchors[0].count];
  for (const a of anchors) {
    const dir: [number, number] = [Math.cos(a.axis), Math.sin(a.axis)];
    const perp: [number, number] = [-dir[1], dir[0]];
    const spacing = 8.5;
    const spanLen = Math.max(a.count - 1, 0.6) * spacing;

    // --- Works yard. Nothing here shares the town code path: the structures
    // are different (sheds, silos, tanks), the arrangement is a surveyed grid
    // rather than anything organic, and every one of them squares to the same
    // bearing. That regularity IS the read — you know a works from a hamlet at
    // a glance, before you can make out a single building.
    if (a.type === "industrial") {
      const COL = 17; // bay pitch across the yard
      const ROW = 15; // and along it
      const cols = 3;
      let put = 0;
      for (let i = 0; i < a.count * 6 && put < a.count; i++) {
        // Walk the grid by CELL. This used to index by attempt, so a bay the
        // terrain rejected consumed a grid position outright; with the yard
        // also capped at four rows every works ran out of cells after eight
        // tries and finished with two sheds and nothing else.
        const col = i % cols;
        const row = Math.floor(i / cols);
        if (row > 5) break;
        const along = (row - 2) * ROW;
        const across = (col - 1) * COL;
        // Big halls first, then the vessels that serve them. Any bay past the
        // second may be a vessel — gated on put === 2 exactly, a silo needed
        // the third bay specifically to land, and across eleven maps one did.
        const kind: LotKind =
          put < 2 ? "shed" : rng() < 0.45 ? "silo" : rng() < 0.5 ? "tank" : "shed";
        const w = kind === "shed" ? 13 + rng() * 4 : kind === "silo" ? 5.5 : 6.5 + rng() * 1.5;
        const d = kind === "shed" ? 9 + rng() * 3 : kind === "silo" ? 5.5 : 6.5 + rng() * 1.5;
        const cx = a.x + dir[0] * along + perp[0] * across;
        const cz = a.z + dir[1] * along + perp[1] * across;
        if (!lotClear(cx, cz, w, d)) continue;
        lots.push({
          cx,
          cz,
          w,
          d,
          // Everything faces the same way — that is what surveyed means.
          front: sideFacing(-perp[0], -perp[1]),
          stories: kind === "silo" ? 4 : kind === "tank" ? 1 : 2,
          style: "concrete",
          roof: "flat",
          ladder: kind !== "tank",
          kind,
        });
        pads.push([cx, cz, w / 2 + 1.2, d / 2 + 1.2]);
        put++;
      }
      // A haul road straight through the yard, on the survey bearing.
      localStreets.push([
        a.x - dir[0] * 38,
        a.z - dir[1] * 38,
        a.x + dir[0] * 42,
        a.z + dir[1] * 42,
      ]);
      continue;
    }
    // Ring radius for the "green" plan: big enough that count lots fit around
    // it shoulder to shoulder, and never tighter than the clearing pad.
    // A green's circumference has to hold the lots themselves, not just their
    // centres. At the 8.5m street pitch a sixteen-house village needed about
    // 180m of ring and was given 150, so it saturated after three or four
    // buildings and then spent every remaining retry failing — the single
    // biggest reason villages came out as hamlets.
    const ringR = Math.max(a.type === "village" ? 13 : 10, (a.count * 13) / (2 * Math.PI) + 6);
    const ringPhase = rng() * Math.PI * 2;
    let placed = 0;
    for (let i = 0; i < a.count * 8 && placed < a.count; i++) {
      const big = a.type === "village" && placed < 3;
      let kind: LotKind = "house";
      // The one landmark. Bounded by attempt count as well as by slot: a 7x7
      // tower that will not fit used to re-ask for the same blocked spot every
      // retry — one village burned 56 of them and got no tower AND no house.
      if (a.type === "village" && !towerPlaced && placed === 3 && i - placed < 10 && rng() < 0.65) {
        kind = "tower";
      } else if (a.type === "farm" && placed === 0 && rng() < 0.6) kind = "barn";
      else if (a.type === "hamlet" && rng() < 0.12) kind = "ruin";
      else if (!big && rng() < TRAITS.specialP) {
        kind = TRAITS.specialKinds[Math.floor(rng() * TRAITS.specialKinds.length)];
      }
      // Footprint. Houses take the climate's elongation (long timber halls in
      // the cold, compact blocks in the sand); the purpose-built kinds keep
      // their own proportions, because a granary is a granary anywhere.
      let w: number;
      let d: number;
      if (kind === "tower") {
        // Narrow and tall. At 7x7 over three storeys the village's one landmark
        // came out wider than it was high — a block, not a watchtower, and
        // invisible from anywhere you would actually want to see it from.
        w = 5.2;
        d = 5.2;
      } else if (kind === "barn") {
        w = 10 + rng() * 3;
        d = 7.5 + rng() * 2;
      } else if (kind === "longhouse") {
        w = 15 + rng() * 5;
        d = 6 + rng() * 1.5;
      } else if (kind === "granary") {
        w = 5 + rng() * 1.5;
        d = 5 + rng() * 1.5;
      } else if (kind === "compound") {
        w = 10 + rng() * 3;
        d = 9.5 + rng() * 2.5;
      } else if (kind === "roundhut") {
        // Round: one diameter, no frontage to elongate.
        w = 6.5 + rng() * 2.5;
        d = w;
      } else if (kind === "stilt") {
        w = 7.5 + rng() * 2.5;
        d = 6.5 + rng() * 2;
      } else {
        const base = (big ? 9.5 : 6.5) + rng() * 4;
        w = Math.min(14, base * TRAITS.elongation);
        d = Math.min(11, (6 + rng() * (big ? 4.5 : 3)) / Math.sqrt(TRAITS.elongation));
      }

      // Where the lot sits, and which way it faces — the plan decides both.
      let cx: number;
      let cz: number;
      let faceX: number;
      let faceZ: number;
      if (a.plan === "green") {
        // Ring the clearing, fronts turned in. Retries nudge along the ring
        // AND push outward: pinned to one radius, the village lost every slot
        // a road or the duel lane happened to cross, and the main village was
        // placing three lots out of sixteen. Walking out in a spiral lets it
        // thicken into a second rank instead of giving the slot up.
        const tries = i - placed;
        const ang = ringPhase + ((placed + tries * 0.37) / a.count) * Math.PI * 2;
        const rad = ringR + d / 2 + (rng() - 0.5) * 2.5 + Math.min(tries, 26) * 0.55;
        cx = a.x + Math.cos(ang) * rad;
        cz = a.z + Math.sin(ang) * rad;
        faceX = a.x - cx;
        faceZ = a.z - cz;
      } else if (a.plan === "cluster") {
        // Grown, not planned: scattered inside a loose disc, each building
        // roughly facing the centre but free to sit askew.
        const ang = rng() * Math.PI * 2;
        const rad = 8 + rng() * (a.type === "village" ? 18 : 13);
        cx = a.x + Math.cos(ang) * rad;
        cz = a.z + Math.sin(ang) * rad;
        const turn = (rng() - 0.5) * 1.8;
        faceX = (a.x - cx) * Math.cos(turn) - (a.z - cz) * Math.sin(turn);
        faceZ = (a.x - cx) * Math.sin(turn) + (a.z - cz) * Math.cos(turn);
      } else {
        // Ribbon along the axis, alternating sides. Retries wander further and
        // flip sides, so a road or a neighbor's pad in the way costs one slot
        // position, not the whole lot.
        const slot = a.count === 1 ? 0 : placed / (a.count - 1) - 0.5;
        const along = slot * spanLen + (rng() - 0.5) * (3 + i * 0.7);
        const sideSign = (placed + i) % 2 === 0 ? 1 : -1;
        const setback = a.type === "farm" ? 3 + rng() * 6 : 1.0 + rng() * 1.5;
        const off = 2 + setback + d / 2;
        cx = a.x + dir[0] * along + perp[0] * off * sideSign;
        cz = a.z + dir[1] * along + perp[1] * off * sideSign;
        faceX = -perp[0] * sideSign;
        faceZ = -perp[1] * sideSign;
      }
      if (!lotClear(cx, cz, w, d)) continue;
      if (kind === "tower") towerPlaced = true;
      const front = sideFacing(faceX, faceZ);

      // Height. Purpose fixes some kinds outright; the rest take the climate's
      // story bias — stacked flat-roofed blocks in arid country, low halls
      // under snow.
      let stories: number;
      if (kind === "tower") stories = 5;
      // A hut is one drum and a stilt house is one raised room — both are
      // single-storey by definition, and their generators assume it.
      else if (kind === "roundhut" || kind === "stilt") stories = 1;
      else if (kind === "barn" || kind === "compound") stories = 2;
      else if (kind === "ruin") stories = 1;
      else if (kind === "granary") stories = 3;
      else if (kind === "longhouse") stories = rng() + TRAITS.storyBias < 0.75 ? 1 : 2;
      else if (big) stories = 2 + (rng() + TRAITS.storyBias < 0.5 ? 0 : 1);
      else {
        const r = rng() - TRAITS.storyBias;
        stories = r < 0.5 ? 1 : r < 0.82 ? 2 : 3;
      }

      // Material. Towers and barns are what the settlement could afford to
      // build them from; everything else draws the climate's mix.
      const style: BuildingStyle =
        kind === "barn"
          ? TRAITS.styleMix.includes("log")
            ? "log"
            : "brick"
          : kind === "tower"
            ? rng() < 0.5
              ? "brick"
              : "concrete"
            : kind === "compound"
              ? "adobe"
              : climateStyle();

      // Roof. Snow and rain force a pitch; arid country roofs flat and uses
      // the space. Barns and longhouses are always gabled, towers always flat.
      const roof: "flat" | "gable" =
        kind === "roundhut" || kind === "stilt"
          ? "gable" // both carry their own roof; the field is unused
          : kind === "tower" || kind === "compound"
            ? "flat"
            : kind === "barn" || kind === "longhouse"
              ? "gable"
              : rng() < TRAITS.flatRoofP
                ? "flat"
                : "gable";

      // Massing. A house that is one box reads as one box however good its
      // roof is; real vernacular grows a lower wing off the main block, and
      // the stepped ridge is most of what makes a village skyline. Split the
      // lot ACROSS its long axis rather than growing it — the pad below is
      // derived from w/d, and widening a footprint moves the heightfield,
      // which would invalidate every baked spawn-cover repair.
      const wingable =
        (kind === "house" || kind === "barn") && stories === 2 && Math.max(w, d) > 9.5;
      // Kept deliberately low: a wing is a whole second envelope, and brick
      // walls cost ~9.6 panels per square metre, so this rate is what fits the
      // panel budget on the densest temperate seeds.
      const wing = wingable && rng() < 0.28;
      if (wing) {
        const alongX = w >= d;
        const span = alongX ? w : d;
        const mainL = span * (0.58 + rng() * 0.08);
        const wingL = span - mainL;
        // Main block keeps the storeys and the ridge; the wing is a single
        // storey under its own lower roof, flush against the party wall.
        const off = (span - mainL) / 2;
        lots.push({
          cx: cx + (alongX ? -off : 0),
          cz: cz + (alongX ? 0 : -off),
          w: alongX ? mainL : w,
          d: alongX ? d : mainL,
          front,
          stories,
          style,
          roof,
          ladder: rng() < 0.5,
          kind,
        });
        // The wing abuts the main block on one face — putting its door there
        // would open it into a wall, so a door that lands on the party side
        // moves to the opposite face.
        const party = alongX ? 3 : 1;
        lots.push({
          cx: cx + (alongX ? (span - wingL) / 2 : 0),
          cz: cz + (alongX ? 0 : (span - wingL) / 2),
          w: alongX ? wingL : w * (0.72 + rng() * 0.16),
          d: alongX ? d * (0.72 + rng() * 0.16) : wingL,
          front: front === party ? (((party + 2) % 4) as 0 | 1 | 2 | 3) : front,
          stories: 1,
          style,
          roof,
          ladder: false,
          kind: "house",
        });
      } else {
        lots.push({
          cx,
          cz,
          w,
          d,
          front,
          stories,
          style,
          roof,
          ladder: kind === "tower" || kind === "granary" ? true : rng() < 0.5,
          kind,
        });
      }
      // A compound reserves its whole walled yard: neighbours keep out, and
      // the ground inside is flattened like the courtyard it is. COURTYARD_PAD
      // must stay above the widest setback courtyard() can roll.
      const yard = kind === "compound" ? COURTYARD_PAD : 0.9;
      pads.push([cx, cz, w / 2 + yard, d / 2 + yard]);
      placed++;
      if (a.type === "village") VILLAGE_LOTS_STAT[0]++;
    }
    // Only ribbon plans get a street through them; greens and clusters are
    // reached by the road network at their anchor node.
    if (a.plan === "street" && a.count >= 2) {
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
  // This cap, not the panel budget, was what actually pinned every map to
  // roughly forty buildings — most maps finish 6-18k panels under budget.
  for (let i = 0; i < 420 && lots.length < SETTLEMENT.lotTarget; i++) {
    const a = anchors[i % anchors.length];
    if (a.type === "farm") continue;
    const ang = rng() * Math.PI * 2;
    const dist = 10 + rng() * 14;
    const w = Math.min(14, (6.5 + rng() * 4) * TRAITS.elongation);
    const d = (6 + rng() * 3) / Math.sqrt(TRAITS.elongation);
    const cx = a.x + Math.cos(ang) * dist;
    const cz = a.z + Math.sin(ang) * dist;
    if (!lotClear(cx, cz, w, d)) continue;
    lots.push({
      cx,
      cz,
      w,
      d,
      front: sideFacing(a.x - cx, a.z - cz),
      stories: rng() - TRAITS.storyBias < 0.5 ? 1 : 2,
      style: climateStyle(),
      roof: rng() < TRAITS.flatRoofP ? "flat" : "gable",
      ladder: rng() < 0.5,
      kind: "house",
    });
    pads.push([cx, cz, w / 2 + 0.9, d / 2 + 0.9]);
  }

  // Pads are final — publish so terrainBase + road baking flatten correctly.
  FLAT_PADS = pads;

  // Bake the polylines into road segments. Heights are sampled from the
  // padded pre-road terrain and then GRADED to a maximum steepness: a lower
  // envelope cuts the bumps, an upper envelope fills the dips, and their
  // midpoint is the profile — balanced cut-and-fill, so a road over a hill
  // shoulder reads as a graded cutting instead of a climb (roadFieldAt pulls
  // the terrain to this profile inside the road band, which is what digs the
  // cuttings and raises the embankments).
  interface RoadChain {
    xs: number[];
    zs: number[];
    hs: number[];
    ds: number[]; // ds[i] = run from point i to i+1
    half: number;
  }
  const chains: RoadChain[] = [];
  const addChain = (pts: Array<[number, number]>, half: number): void => {
    // Subdivide to <=7m pieces so the profile can bend where the ground does.
    const xs: number[] = [pts[0][0]];
    const zs: number[] = [pts[0][1]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 7));
      for (let k = 1; k <= n; k++) {
        xs.push(ax + ((bx - ax) * k) / n);
        zs.push(az + ((bz - az) * k) / n);
      }
    }
    const hs = xs.map((x, i) => terrainBase(x, zs[i]));
    const ds: number[] = [];
    for (let i = 0; i < xs.length - 1; i++) {
      ds.push(Math.hypot(xs[i + 1] - xs[i], zs[i + 1] - zs[i]) || 0.001);
    }
    chains.push({ xs, zs, hs, ds, half });
  };
  for (const pl of polylines) addChain(pl.pts, pl.half);
  for (const [ax, az, bx, bz] of localStreets)
    addChain(
      [
        [ax, az],
        [bx, bz],
      ],
      2.0,
    );

  // Grade the network as ONE graph, not chain by chain: chain endpoints at
  // the same node collapse to a single graph point, so every road meeting a
  // junction agrees on its height there by construction (no lips). The lower
  // envelope relaxes each point down to the cheapest cap-sloped path from any
  // ground sample (cutting bumps); the upper envelope is its mirror (filling
  // dips); their midpoint is the profile — balanced cut-and-fill that never
  // exceeds MAX_ROAD_GRADE across any piece, junctions included.
  const nodeKey = (x: number, z: number): number => Math.round(x * 4) * 300000 + Math.round(z * 4);
  const nodeIds = new Map<number, number>();
  const h0: number[] = [];
  const nodeXs: number[] = [];
  const nodeZs: number[] = [];
  const chainIds: number[][] = [];
  const graphEdges: Array<[number, number, number]> = [];
  for (const c of chains) {
    const cids: number[] = [];
    for (let i = 0; i < c.xs.length; i++) {
      const isEnd = i === 0 || i === c.xs.length - 1;
      let id = isEnd ? nodeIds.get(nodeKey(c.xs[i], c.zs[i])) : undefined;
      if (id === undefined) {
        id = h0.length;
        h0.push(c.hs[i]);
        nodeXs.push(c.xs[i]);
        nodeZs.push(c.zs[i]);
        if (isEnd) nodeIds.set(nodeKey(c.xs[i], c.zs[i]), id);
      }
      cids.push(id);
    }
    for (let i = 0; i < cids.length - 1; i++) graphEdges.push([cids[i], cids[i + 1], c.ds[i]]);
    chainIds.push(cids);
  }
  const lo = h0.slice();
  const up = h0.slice();
  for (let guard = 0; guard < 500; guard++) {
    let changed = false;
    for (const [a, b, d] of graphEdges) {
      const capD = MAX_ROAD_GRADE * d;
      if (lo[b] > lo[a] + capD + 1e-4) {
        lo[b] = lo[a] + capD;
        changed = true;
      }
      if (lo[a] > lo[b] + capD + 1e-4) {
        lo[a] = lo[b] + capD;
        changed = true;
      }
      if (up[b] < up[a] - capD - 1e-4) {
        up[b] = up[a] - capD;
        changed = true;
      }
      if (up[a] < up[b] - capD - 1e-4) {
        up[a] = up[b] - capD;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Roads must LAND on the pads they serve, at pad height. The balanced
  // midpoint is free to float above a pad node (the upper envelope fills it
  // to soften a climb beyond), which reads as a dirt wall where the graded
  // embankment meets the flat clearing. Clamp the profile into the
  // MAX_ROAD_GRADE cone of every pad surface (all pads sit at height 0):
  // inside a pad the profile IS the pad, and it may only rise at road grade
  // with distance from the pad rectangle. Spawn pads are exempt — their exit
  // ramps are meant to rise across the pad (padFade's skipSpawnPads
  // contract). The clamp is the median of three functions that each respect
  // the grade cap, so the result still respects it everywhere.
  const prof: number[] = [];
  for (let i = 0; i < h0.length; i++) {
    let cone = Infinity;
    for (let pi = 2; pi < FLAT_PADS.length; pi++) {
      const [cx, cz, hw, hd] = FLAT_PADS[pi];
      const dx = Math.max(0, Math.abs(nodeXs[i] - cx) - hw);
      const dz = Math.max(0, Math.abs(nodeZs[i] - cz) - hd);
      const reach = MAX_ROAD_GRADE * Math.hypot(dx, dz);
      if (reach < cone) cone = reach;
    }
    prof.push(Math.max(-cone, Math.min(cone, (lo[i] + up[i]) / 2)));
  }

  const roads: RoadSeg[] = [];
  for (let ci = 0; ci < chains.length; ci++) {
    const c = chains[ci];
    const cids = chainIds[ci];
    for (let i = 0; i < cids.length - 1; i++) {
      roads.push({
        ax: c.xs[i],
        az: c.zs[i],
        bx: c.xs[i + 1],
        bz: c.zs[i + 1],
        ay: prof[cids[i]],
        by: prof[cids[i + 1]],
        half: c.half,
      });
    }
  }
  ROAD_SEGS = roads;
  rebuildRoadGrid();

  // Conquest zones: the center house plus the four balanced hamlet greens,
  // always on flat dry clearing pads. (If the pool couldn't seat four —
  // vanishingly rare — mirrored fallback flags fill in.)
  const zonePos: Array<[number, number]> = flagAnchors
    .slice(0, 4)
    // Ring order, counter-clockwise from due east, so a letter always means
    // "roughly over there" even though the greens no longer mirror.
    .sort((a, b) => Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x))
    .map((a): [number, number] => [a.x, a.z]);
  while (zonePos.length < 4) {
    // Mirrored fallback pairs, far apart from each other and from B.
    const x = 54 + zonePos.length * 6;
    const z = zonePos.length >= 2 ? -32 : 30;
    zonePos.push([-x, -z], [x, z]);
    pads.push([-x, -z, 5, 5], [x, z, 5, 5]);
  }
  // Stable lettering around that ring.
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
// leaking rays bundle (off-road so the baked road profile can't cut a
// channel back through it) and the check reruns. Terrain-only on purpose:
// buildings block plenty of views, but they're destructible — the dirt
// carries the guarantee. Runs BEFORE structures are seated, so everything
// still lands on the final ground.
//
// The greedy pass is order-sensitive: a stamp can raise a distant threat's
// eye and re-open rays whose good spots are already on the never-reuse list.
// Restarting with fresh memory (grid resampled, no poisoned spots) reliably
// seals the last few rays, so the wrapper runs up to three passes.

function validateSpawnCover(): void {
  for (let pass = 0; pass < 3; pass++) {
    if (validateSpawnCoverPass()) return;
  }
}

// Set only by curateSpawnRepairs(), so the search sees the raw heightfield
// instead of one the previous table has already fixed.
let SKIP_BAKED_REPAIRS = false;

// Build-time helper for curating map seeds. Runtime clients and servers use
// the baked repair stamps below and never execute the expensive ray marcher.
export function validateCuratedSpawnCover(): boolean {
  const firstRepair = HILLS.length;
  validateSpawnCover();
  return HILLS.length === firstRepair;
}

// Build-time: run the repair search on a seed with no baked stamps and hand
// back what it added, ready to paste into CURATED_SPAWN_REPAIRS. Re-run
// scripts/curate-map-seeds.ts whenever anything moves the heightfield —
// including the settlement layout, since lot pads flatten terrain through
// shapeFade.
export function curateSpawnRepairs(): Array<[number, number, number, number]> {
  // Rebuild the world WITHOUT this seed's existing baked stamps first. A
  // caller has necessarily already built the map to look at it, which pushed
  // the old table into HILLS; searching from there finds an already-sealed map,
  // reports "nothing to add", and bakes an empty table that unseals it for
  // real. `npm run test:map-seeds` catches that, but only after the fact.
  SKIP_BAKED_REPAIRS = true;
  try {
    rebuildMap();
    const firstRepair = HILLS.length;
    validateSpawnCover();
    return HILLS.slice(firstRepair).map(([x, z, r, a]) => [x, z, r, a]);
  } finally {
    SKIP_BAKED_REPAIRS = false;
  }
}

// One full greedy pass; true = no leaks remain.
function validateSpawnCoverPass(): boolean {
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
    invalidateBaseHeightPatch(hx, hz, r); // the stamp just changed this ground
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

  for (let iter = 0; iter < 40; iter++) {
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
    if (leaks.length === 0) return true;

    // Bundle the leaks where their rays cross the spawn approach and grow a
    // hill at each of the densest crossings (several per pass — leak fans
    // come in bundles from different directions). Each bucket remembers the
    // steepest ray slope so a fix placed anywhere along the ray can be sized.
    interface Bucket {
      x: number;
      z: number;
      sx: number; // pad-side anchor sums: the march must follow the TRUE
      sz: number; // rays (pad corner → threat), not a spawn-center guess —
      n: number; //  9m of anchor error puts far candidates metres off-ray
      slope: number; // max dY/ddist of its leaking rays (from the pad out)
      td: number; // nearest threat distance: stamps must stay well short of
      //             the threats they block, or raising the ground raises the
      //             THREAT'S EYE and the fix chases its own tail upward
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
      const b = buckets.get(key) ?? { x: 0, z: 0, sx: 0, sz: 0, n: 0, slope: 0, td: Infinity };
      b.x += px;
      b.z += pz;
      b.sx += sx;
      b.sz += sz;
      b.n++;
      b.slope = Math.max(b.slope, (hAt(tx, tz) - hAt(sx, sz)) / dist);
      b.td = Math.min(b.td, dist);
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
      const asx = b.sx / b.n;
      const asz = b.sz / b.n;
      const d0 = Math.hypot(cx - asx, cz - asz) || 1;
      const dirX = (cx - asx) / d0;
      const dirZ = (cz - asz) / d0;
      const taken = (qx: number, qz: number, poisonOk: boolean): boolean =>
        onRoad(qx, qz) > 0 ||
        padFade(qx, qz) < 0.75 ||
        (!poisonOk && fixStamps.some(([fx, fz]) => Math.hypot(fx - qx, fz - qz) < 6.5));
      let px = -1;
      let pz = -1;
      let amp = 0;
      let rr = 0;
      // The march runs past the exit roads' outer bends (~55m): a ray that
      // parallels a road can only be blocked where the road has turned away.
      // In road-dense seeds the first open dirt can be one lane over, so
      // every distance also tries side-steps — a wide mound whose SHOULDER
      // tops the ray, sized by the stamp's smoothstep falloff. Of every
      // workable candidate, take the CHEAPEST (least added height): small
      // stamps seal just as well and don't hoist distant threats' eyes,
      // which is what set off fix-one-open-two cascades.
      // Pass 2 (densest bundle only, when pass 1 found nothing): TOP-UP a
      // poisoned spot. `need` is measured against the CURRENT ground, so a
      // re-stamp adds only the remaining shortfall — it can't stack towers,
      // and it un-sticks the endgame where every open spot has already been
      // tried once against a since-raised threat eye.
      let bestA = Infinity;
      for (const poisonOk of b === ranked[0] ? [false, true] : [false]) {
        for (const off of [0, 5, -5, 8, -8]) {
          for (const d of [d0, 17, 21, 25, 29, 33, 37, 41, 45, 50, 55, 61, 67, 74, 82]) {
            if (d > b.td - 20) break; // a stamp's skirt must never reach a threat
            const qx = asx + dirX * d - dirZ * off;
            const qz = asz + dirZ * d + dirX * off;
            if (taken(qx, qz, poisonOk)) continue;
            // +0.15 headroom: an exactly-sized stamp that still leaks (grid
            // interpolation, a later stamp raising the threat's eye) poisons
            // its spot, which is worse than a slightly taller hill.
            const need = EYE + b.slope * d + 1.3 + 0.15 - hAt(qx, qz);
            if (need < 0.4 && poisonOk) continue; // already tall enough here
            const a = Math.max(1.6, off === 0 ? need : need / smooth(1 - Math.abs(off) / 17));
            if (a >= bestA) continue;
            bestA = a;
            amp = Math.min(5.4, a);
            rr = off === 0 ? Math.max(11, Math.min(17, amp * 4.2)) : 17;
            px = qx;
            pz = qz;
          }
        }
        if (px !== -1) break; // top-ups only when no fresh spot exists at all
      }
      if (px === -1) continue;
      const spacing = leaks.length <= 8 ? 8 : 12;
      if (placedNow.some(([qx, qz]) => Math.hypot(qx - px, qz - pz) < spacing)) continue;
      // Single stamp, only where the leak is — the map is asymmetric, so a
      // mirrored twin would be a hill with no job.
      HILLS.push([px, pz, rr, amp]);
      refreshPatch(px, pz, rr);
      placedNow.push([px, pz]);
      fixStamps.push([px, pz]);
    }
    if (placedNow.length === 0) return false; // nowhere left to raise ground
  }
  return false; // out of iterations with leaks left — the next pass retries
}

// ---------------------------------------------------------------------------

function buildMap(): MapDef {
  nextPanelId = 1;
  nextBuildingId = 0;
  FLAT_PADS = [];
  ROAD_SEGS = [];
  ROAD_GRID = new Map();
  // Seed-derived planning, in fixed order: climate, noise permutation, water,
  // hills, then the settlement layout (which bakes the roads), then the
  // terrain-only sightline guarantee — all BEFORE any structure is seated, so
  // everything lands on the final ground. Climate goes first: water frequency,
  // biome mix and relief character all read it.
  planClimate();
  // Landform reads TRAITS (island odds are per climate) and is read by the
  // water carve, so it sits between climate and water.
  planLandform(mulberry32(subSeed(0x33)));
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
  const repairs = SKIP_BAKED_REPAIRS ? undefined : CURATED_SPAWN_REPAIRS[SEED];
  if (repairs) {
    for (const [x, z, radius, amplitude] of repairs) HILLS.push([x, z, radius, amplitude]);
  }

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
    // Works structures have nothing in common with the house generator.
    if (lot.kind === "shed") {
      shed(g, lot.cx, lot.cz, lot.w, lot.d, f, lot.stories, rng);
      return;
    }
    if (lot.kind === "silo") {
      silo(g, lot.cx, lot.cz, rng, lot.stories);
      return;
    }
    if (lot.kind === "tank") {
      tank(g, lot.cx, lot.cz, lot.w, rng);
      return;
    }
    // Neither of these is a box with a roof on it, so neither goes through
    // building() — the whole point is that they don't share its silhouette.
    if (lot.kind === "roundhut") {
      roundHut(g, lot.cx, lot.cz, lot.w, f, lot.style, rng);
      return;
    }
    if (lot.kind === "stilt") {
      stiltHouse(g, lot.cx, lot.cz, lot.w, lot.d, f, lot.style, rng);
      return;
    }
    const doorSides: Array<0 | 1 | 2 | 3> = [f];
    if (!fixedCenter) {
      // A granary is a store: one door, blank walls, and that's the point —
      // it reads as a solid block of cover you have to walk around.
      const through = lot.kind === "granary" ? 0.15 : 0.78;
      if (rng() < through) doorSides.push(((f + 2) % 4) as 0 | 1 | 2 | 3); // opposite
      if (lot.kind !== "granary") {
        if (rng() < 0.45) doorSides.push(((f + 1) % 4) as 0 | 1 | 2 | 3); // a side
        if (rng() < 0.22) doorSides.push(((f + 3) % 4) as 0 | 1 | 2 | 3); // the other side
      }
    }
    // A longhouse is one hall end to end, like a barn — but with a normal
    // doorway rather than a wagon door, so it takes the barn interior only
    // when it's big enough to be worth hollowing out.
    const openHall = lot.kind === "barn" || (lot.kind === "longhouse" && lot.stories === 1);
    building(g, lot.cx, lot.cz, lot.w, lot.d, {
      kind: lot.kind,
      stories: lot.stories,
      style: lot.style,
      doorSides,
      roof: lot.roof,
      ladder: lot.ladder,
      rng,
      barn: openHall,
      wagonDoor: lot.kind === "barn",
      parapet:
        lot.kind === "tower" ||
        lot.kind === "compound" ||
        (lot.roof === "flat" && !fixedCenter && rng() < TRAITS.parapetP),
      porch:
        (lot.kind === "house" || lot.kind === "longhouse") &&
        !fixedCenter &&
        lot.stories <= 2 &&
        rng() < TRAITS.porchP,
      chimney: lot.kind !== "granary" && lot.kind !== "tower" && rng() < TRAITS.chimneyP,
    });
    // Arid settlements build behind a wall: the compound's courtyard is a
    // real piece of level geometry, not a texture — chest-high cover with one
    // gateway, so pushing a desert hamlet plays differently from a snow one.
    if (lot.kind === "compound") courtyard(g, lot.cx, lot.cz, lot.w, lot.d, lot.front, rng);
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
  const TREE_CAP = 210;
  const treeBias = [-0.14, 0.2, -0.08, -0.02]; // meadow, forest, rocky, marsh
  const climTree = TRAITS.treeDensity; // jungles close in, dune seas thin out
  let treeCount = 0;
  for (let i = 0; i < 3400 && treeCount < TREE_CAP; i++) {
    const x = (treeRng() * 2 - 1) * (half - 6);
    const z = (treeRng() * 2 - 1) * (half - 6);
    const keepCoreOpen = treeRng();
    const loneRoll = treeRng();
    if (Math.hypot(x, z) < 26 && keepCoreOpen < 0.7) continue; // the plaza approach stays readable
    const b = biomeAt(x, z);
    const density = fbm2(x + 5200, z + 5200, 3, 1 / 52) * 0.5 + 0.5 + treeBias[b] + climTree;
    if (density < 0.46) continue;
    if (density < 0.56 && loneRoll > 0.12) continue; // lone field trees only
    const spacing = density > 0.72 ? 2.1 : 3.1;
    if (!clearOf(x, z, spacing)) continue;
    tree(g, x, z, treeRng, b);
    placed.push([x, z, spacing]);
    treeCount++;
  }

  // Boulder clusters — most live on the rocky high ground. Bare climates strew
  // more of them (they are the only cover a dune sea or a mesa field has);
  // jungle floors bury them under canopy instead.
  const rockRng = mulberry32(subSeed(0x5c));
  const ROCK_CLUSTERS = Math.round(74 * TRAITS.rockDensity);
  for (let i = 0; i < ROCK_CLUSTERS; i++) {
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
  // ground grow their own cover). Farmed country only — see hedgeDensity.
  const HEDGES = Math.round(30 * TRAITS.hedgeDensity);
  for (let i = 0; i < HEDGES; i++) {
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
// world without re-importing anything. It starts lightweight: runtime owners
// initialize the authoritative seed before building physics or presentation,
// avoiding a throwaway default-map build during every game launch.
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
// The client draws these four materials with a mesh that is NOT a unit cube,
// so ex/ey/ez — which IS the collider, and the only thing pieceAt() and the
// merged slab bodies ever see — has to be the mesh's true world AABB.
// Measured, not guessed: foliage overshot its box by 39% across (you could see
// leaves a bullet flew straight through) and a conifer bough underfilled it by
// 13% (you could hit a cone that was not there).
//
// Each number is the unit geometry's own AABB. The client scales every one of
// them by the inverse so the mesh lands exactly on the unit box, and asserts
// that it did — so the two halves cannot drift apart silently.
export const MESH_FIT: Readonly<Record<string, readonly [number, number, number]>> = {
  // Foliage and rock are spun about Y per piece, so their horizontal bound is
  // the swept radius rather than the resting box.
  canopy: [1.389, 1.22, 1.389],
  rock: [1.201, 0.981, 1.201],
  bough: [0.866, 1, 1],
  frond: [1, 1, 0.836],
};

// Applied AFTER generation on purpose. Every overlap, clearance and contact
// decision upstream is about where the leaves are DRAWN, which is the question
// those decisions are actually asking; only the collider needs the true bound.
function fitOrganicColliders(panels: PanelDef[]): void {
  for (const p of panels) {
    const f = MESH_FIT[p.material];
    // An oriented piece's box is already a rotated bound, so scaling its world
    // axes would mean nothing. Those are fitted at emission instead, where the
    // mesh's own local dimensions are still in hand.
    if (!f || p.rot) continue;
    p.ex *= f[0];
    p.ey *= f[1];
    p.ez *= f[2];
  }
}

export function initMap(seed: number): void {
  const s = seed >>> 0;
  if (s === SEED && MAP.panels.length > 0) return;
  SEED = s;
  rebuildMap();
}

function rebuildMap(): void {
  baseHeightCache = null;
  resetCraters();
  const def = buildMap();
  fitOrganicColliders(def.panels);
  MAP.statics = def.statics;
  MAP.panels = def.panels;
  MAP.buildings = def.buildings;
  MAP.slabs = def.slabs;
  MAP.ladders = def.ladders;
  MAP.spawns = def.spawns;
  ZONES.length = 0;
  for (const zn of LAYOUT.zones) ZONES.push(zn);
  baseHeightCache = new Float64Array(BASE_HEIGHT_CACHE_N * BASE_HEIGHT_CACHE_N);
  baseHeightCache.fill(Number.NaN);
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

// Deployed cover, rubble, settled chunks, and falling chunks get ids above
// this; generated map panel ids must stay below it for the round lifetime.
export const BUILT_PANEL_ID_BASE = 1_000_000;

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
