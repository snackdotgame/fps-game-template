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
  | "glass" // windowpane — one hit shatters it
  | "rubble" // chunk left behind by a destroyed piece (spawned at runtime)
  | "metal"; // deployed cover sheet (built at runtime)

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
  glass: 10, // any hit shatters it
  rubble: 40,
  metal: 120,
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

export interface MapDef {
  size: number; // arena is size x size, centered on origin
  statics: StaticBox[];
  panels: PanelDef[];
  buildings: BuildingDef[];
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

const SIZE = 84;
const TERRAIN_AMPLITUDE = 1.35;

// Footprints that must stay flat: building pads and spawn zones.
const FLAT_PADS: Array<[number, number, number, number]> = [
  // [cx, cz, halfW, halfD]
  [0, 0, 7.5, 6.5],
  [-15, -12, 6.5, 6.5],
  [15, 12, 6.5, 6.5],
  [16, -14, 6.5, 5.5],
  [-16, 14, 6.5, 5.5],
  [32, 4, 6.5, 6.5],
  [-32, -25, 6.5, 5.5],
  [-31, 27, 6.5, 5.5],
  [14, -30, 6.5, 5.5],
  [0, -35, 8, 5], // team 0 spawn
  [0, 35, 8, 5], // team 1 spawn
];

// How exposed (x,z) is to terrain shaping: 1 in the open field, fading to 0
// inside flat pads and at the perimeter. Both the noise relief and crater
// digging are scaled by this, so buildings never get undermined.
function shapeFade(x: number, z: number): number {
  let f = 1;
  for (const [cx, cz, hw, hd] of FLAT_PADS) {
    const dx = Math.max(0, Math.abs(x - cx) - hw);
    const dz = Math.max(0, Math.abs(z - cz) - hd);
    const dist = Math.hypot(dx, dz);
    if (dist < 2.5) f *= smooth(dist / 2.5);
  }
  const edge = SIZE / 2 - Math.max(Math.abs(x), Math.abs(z));
  if (edge < 3) f *= smooth(Math.max(0, edge) / 3);
  return f;
}

// The pristine pre-battle terrain. Structure generation seats pieces on this,
// so later craters never move existing geometry.
export function baseHeightAt(x: number, z: number): number {
  const raw = valueNoise(x + 1000, z + 1000, 14) * 0.7 + valueNoise(x + 2000, z + 2000, 5.5) * 0.3;
  return raw * TERRAIN_AMPLITUDE * shapeFade(x, z);
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
      if (gap.lo - lo >= 0.18) next.push([lo, gap.lo]);
      if (hi - gap.hi >= 0.18) next.push([gap.hi, hi]);
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
}

function building(
  g: Gen,
  cx: number,
  cz: number,
  w: number,
  d: number,
  doorSide: 0 | 1 | 2 | 3,
  style: "brick" | "log",
  stories = 1,
): void {
  const id = nextBuildingId++;
  const firstPanel = nextPanelId;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const unit = style === "brick" ? BRICK : LOG;
  const rowsPerStory = Math.round(WALL_HEIGHT / unit.h);
  const height = stories * WALL_HEIGHT;

  // Door: 1.3m x 2.05m, centered, ground floor only. Windows: 2.1m wide at
  // sill height on every other ground wall and on EVERY upper-story wall.
  // Pieces are clipped, so brick walls get cut bricks around openings and
  // log walls get sawed log ends.
  const door = (mid: number): GapRect[] => [{ lo: mid - 0.65, hi: mid + 0.65, y0: 0, y1: 2.05 }];
  const win = (mid: number, baseY: number): GapRect[] => [
    { lo: mid - 1.05, hi: mid + 1.05, y0: baseY + 1.3, y1: baseY + 2.05 },
  ];
  const glassIds: number[] = [];
  const pane = (axis: "x" | "z", mid: number, fixed: number, baseY: number): void => {
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
  };

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
      const gaps = story === 0 && side === doorSide ? door(mid) : win(mid, baseY);
      masonryRun(g, axis, a0, a1, fixed, baseY, rowsPerStory, unit, style, id, gaps);
      if (!(story === 0 && side === doorSide)) pane(axis, mid, fixed, baseY);
    }
  }

  // Structural corner posts — destructible like everything else, just tough.
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

  // The stairwell hole (multi-story only): a column along the west wall that
  // every upper floor leaves open, with switchback flights of floating
  // treads inside it. Step-up assist walks them like real stairs.
  const roofIds: number[] = [];
  const stairHole: GapRect | null =
    stories > 1 ? { lo: x0 + 0.55, hi: x0 + 1.8, y0: z0 + 1.0, y1: z0 + 5.35 } : null;
  const STAIR_RISE = WALL_HEIGHT / 10;
  const STAIR_RUN = 0.42;
  for (let flight = 0; flight < stories - 1; flight++) {
    const baseY = flight * WALL_HEIGHT;
    const up = flight % 2 === 0; // switchback: alternate +z / -z
    for (let k = 0; k < 10; k++) {
      const z = up ? z0 + 1.3 + k * STAIR_RUN : z0 + 5.05 - k * STAIR_RUN;
      roofIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: x0 + 1.17,
        y: baseY + (k + 1) * STAIR_RISE - 0.06,
        z,
        ex: 1.15,
        ey: 0.12,
        ez: 0.5,
        material: "plank",
        buildingId: id,
      });
    }
  }

  // Floors between stories and the roof: staggered planks laid across the
  // footprint; upper floors keep the stairwell column open.
  const strips = Math.round(d / PLANK.w);
  const npl = Math.round(w / PLANK.l);
  for (let level = 1; level <= stories; level++) {
    const y = level * WALL_HEIGHT + PLANK.h / 2;
    const isRoof = level === stories;
    for (let s = 0; s < strips; s++) {
      const z = z0 + (s + 0.5) * PLANK.w;
      const inHoleZ = !isRoof && stairHole !== null && z > stairHole.y0 && z < stairHole.y1;
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
        // Clip floor planks against the stairwell column (x interval).
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
      .filter((p) => p.material !== "plank" && p.material !== "glass")
      .map((p) => p.id),
    roofPanelIds: [...roofIds, ...glassIds],
    collapseFraction: 0.35,
  });
}

// Procedural trees, two species. Oaks: a stout trunk with a clustered cube
// crown. Pines: a tall thin trunk with stacked, shrinking foliage tiers.
// Either way the trunk is the structure — break two segments and it falls.
function tree(g: Gen, x: number, z: number, rng: () => number): void {
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
}

// Boulder clusters: 1-3 destructible rocks, partially sunk into the ground.
function rocks(g: Gen, x: number, z: number, rng: () => number): void {
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
}

// ---------------------------------------------------------------------------

function buildMap(): MapDef {
  nextPanelId = 1;
  nextBuildingId = 0;
  const rng = mulberry32(MAP_SEED);
  const g: Gen = { statics: [], panels: [], buildings: [] };
  const half = SIZE / 2;

  // Perimeter walls (terrain fades to 0 at the edge so these seat flush).
  g.statics.push({ x: 0, y: 1.5, z: -half, w: SIZE, h: 3, d: 1, kind: "wall" });
  g.statics.push({ x: 0, y: 1.5, z: half, w: SIZE, h: 3, d: 1, kind: "wall" });
  g.statics.push({ x: -half, y: 1.5, z: 0, w: 1, h: 3, d: SIZE, kind: "wall" });
  g.statics.push({ x: half, y: 1.5, z: 0, w: 1, h: 3, d: SIZE, kind: "wall" });

  // Buildings on their flat pads (positions match FLAT_PADS): six brick,
  // three log cabins. The center house and the north house are two-story;
  // the east building is a three-story tower overlooking the duel lane.
  building(g, 0, 0, 10, 8, 0, "brick", 2);
  building(g, -15, -12, 8, 8, 2, "brick");
  building(g, 15, 12, 8, 8, 3, "log");
  building(g, 16, -14, 8, 6, 0, "log");
  building(g, -16, 14, 8, 6, 1, "brick");
  building(g, 32, 4, 8, 8, 3, "brick", 3);
  building(g, -32, -25, 8, 6, 0, "log");
  building(g, -31, 27, 8, 6, 1, "brick", 2);
  building(g, 14, -30, 8, 6, 0, "brick");

  // Procedural placement for everything else, rejected against keep-outs.
  const placed: Array<[number, number, number]> = []; // x, z, radius
  const clearOf = (x: number, z: number, r: number): boolean => {
    if (Math.abs(x) > half - 3 || Math.abs(z) > half - 3) return false;
    for (const [cx, cz, hw, hd] of FLAT_PADS) {
      if (Math.abs(x - cx) < hw + r && Math.abs(z - cz) < hd + r) return false;
    }
    if (x > 20.5 && x < 27.5) return false; // keep the east duel lane open
    for (const [px, pz, pr] of placed) {
      if (Math.hypot(x - px, z - pz) < r + pr) return false;
    }
    return true;
  };

  // Sandbag emplacements (three staggered courses of bags).
  for (let i = 0; i < 12; i++) {
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

  // Trees.
  for (let i = 0; i < 26; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 5);
      const z = (rng() * 2 - 1) * (half - 5);
      if (!clearOf(x, z, 2.4)) continue;
      tree(g, x, z, rng);
      placed.push([x, z, 2.4]);
      break;
    }
  }

  // Boulder clusters.
  for (let i = 0; i < 12; i++) {
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
  for (let i = 0; i < 16; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 5);
      const z = (rng() * 2 - 1) * (half - 5);
      if (!clearOf(x, z, 1.6)) continue;
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
      placed.push([x, z, 1.6]);
      break;
    }
  }

  return {
    size: SIZE,
    statics: g.statics,
    panels: g.panels,
    buildings: g.buildings,
    spawns: [
      [0, 0.1, -35],
      [0, 0.1, 35],
    ],
  };
}

export const MAP = buildMap();

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
}

export function buildSupportIndex(): SupportIndex {
  const above = new Map<number, number[]>();
  const below = new Map<number, number[]>();
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

  return { above, below, grounded };
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
