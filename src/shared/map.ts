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

const SIZE = 56;
const TERRAIN_AMPLITUDE = 1.1;

// Footprints that must stay flat: building pads and spawn zones.
const FLAT_PADS: Array<[number, number, number, number]> = [
  // [cx, cz, halfW, halfD]
  [0, 0, 7.5, 6.5],
  [-15, -12, 6.5, 6.5],
  [15, 12, 6.5, 6.5],
  [16, -14, 6.5, 5.5],
  [-16, 14, 6.5, 5.5],
  [0, -23, 8, 5], // team 0 spawn
  [0, 23, 8, 5], // team 1 spawn
];

export function heightAt(x: number, z: number): number {
  const raw = valueNoise(x + 1000, z + 1000, 13) * 0.7 + valueNoise(x + 2000, z + 2000, 5.5) * 0.3;
  let h = raw * TERRAIN_AMPLITUDE;
  // Fade to zero inside flat pads (with a 2.5m blend skirt).
  for (const [cx, cz, hw, hd] of FLAT_PADS) {
    const dx = Math.max(0, Math.abs(x - cx) - hw);
    const dz = Math.max(0, Math.abs(z - cz) - hd);
    const dist = Math.hypot(dx, dz);
    if (dist < 2.5) h *= smooth(dist / 2.5);
  }
  // Settle to zero at the perimeter so the boundary walls seat cleanly.
  const edge = SIZE / 2 - Math.max(Math.abs(x), Math.abs(z));
  if (edge < 3) h *= smooth(Math.max(0, edge) / 3);
  return h;
}

// Triangle grid for the physics mesh. The client renders its own geometry
// from the same heightAt, so collision matches visuals exactly.
export const TERRAIN_CELL = 1;

export function terrainMesh(): { vertices: number[]; indices: number[] } {
  const half = SIZE / 2;
  const n = Math.floor(SIZE / TERRAIN_CELL);
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let iz = 0; iz <= n; iz++) {
    for (let ix = 0; ix <= n; ix++) {
      const x = -half + ix * TERRAIN_CELL;
      const z = -half + iz * TERRAIN_CELL;
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
): void {
  const id = nextBuildingId++;
  const firstPanel = nextPanelId;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const unit = style === "brick" ? BRICK : LOG;
  const rows = Math.round(WALL_HEIGHT / unit.h);

  // Door: 1.3m x 2.05m, centered. Windows: 2.1m wide at sill height, on
  // every other wall. Pieces are clipped, so brick walls get cut bricks
  // around openings and log walls get sawed log ends.
  const door = (mid: number): GapRect[] => [{ lo: mid - 0.65, hi: mid + 0.65, y0: 0, y1: 2.05 }];
  const win = (mid: number): GapRect[] => [{ lo: mid - 1.05, hi: mid + 1.05, y0: 1.3, y1: 2.05 }];
  const pick = (side: number, mid: number) => (doorSide === side ? door(mid) : win(mid));

  masonryRun(g, "x", x0, x1, z1, 0, rows, unit, style, id, pick(0, cx));
  masonryRun(g, "x", x0, x1, z0, 0, rows, unit, style, id, pick(1, cx));
  masonryRun(g, "z", z0, z1, x1, 0, rows, unit, style, id, pick(2, cz));
  masonryRun(g, "z", z0, z1, x0, 0, rows, unit, style, id, pick(3, cz));

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
      y: WALL_HEIGHT / 2,
      z: pz,
      ex: 0.3,
      ey: WALL_HEIGHT,
      ez: 0.3,
      material: "post",
      buildingId: id,
    });
  }

  // Roof: staggered planks laid across the footprint.
  const roofIds: number[] = [];
  const roofY = WALL_HEIGHT + PLANK.h / 2;
  const strips = Math.round(d / PLANK.w);
  const npl = Math.round(w / PLANK.l);
  for (let s = 0; s < strips; s++) {
    const z = z0 + (s + 0.5) * PLANK.w;
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
      roofIds.push(nextPanelId);
      g.panels.push({
        id: nextPanelId++,
        x: c,
        y: roofY,
        z,
        ex: l,
        ey: PLANK.h,
        ez: PLANK.w,
        material: "plank",
        buildingId: id,
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
    wallPanelIds: mine.filter((p) => p.material !== "plank").map((p) => p.id),
    roofPanelIds: roofIds,
    collapseFraction: 0.35,
  });
}

function tree(g: Gen, x: number, z: number, rng: () => number): void {
  const id = nextBuildingId++;
  const base = heightAt(x, z);
  const SEG = 0.8;
  const trunkIds: number[] = [];
  for (let seg = 0; seg < 4; seg++) {
    trunkIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x,
      y: base + (seg + 0.5) * SEG,
      z,
      ex: 0.45,
      ey: SEG,
      ez: 0.45,
      material: "trunk",
      buildingId: id,
    });
  }
  // Canopy: a crown clump on top, smaller clumps ringed around it.
  const canopyIds: number[] = [];
  const clumps: Array<[number, number, number, number]> = [[0, 3.55, 0, 1.7]];
  for (let i = 0; i < 3; i++) {
    const ang = rng() * Math.PI * 2;
    const r = 0.55 + rng() * 0.4;
    clumps.push([Math.sin(ang) * r, 2.75 + rng() * 0.5, Math.cos(ang) * r, 1.25 + rng() * 0.5]);
  }
  for (const [ox, oy, oz, s] of clumps) {
    canopyIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x: x + ox,
      y: base + oy,
      z: z + oz,
      ex: s,
      ey: s * 0.85,
      ez: s,
      material: "canopy",
      buildingId: id,
    });
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
    collapseFraction: 0.5, // two trunk segments fell it
  });
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

  // Buildings on their flat pads (positions match FLAT_PADS): three brick,
  // two log cabins.
  building(g, 0, 0, 10, 8, 0, "brick");
  building(g, -15, -12, 8, 8, 2, "brick");
  building(g, 15, 12, 8, 8, 3, "log");
  building(g, 16, -14, 8, 6, 0, "log");
  building(g, -16, 14, 8, 6, 1, "brick");

  // Procedural placement for everything else, rejected against keep-outs.
  const placed: Array<[number, number, number]> = []; // x, z, radius
  const clearOf = (x: number, z: number, r: number): boolean => {
    if (Math.abs(x) > half - 3 || Math.abs(z) > half - 3) return false;
    for (const [cx, cz, hw, hd] of FLAT_PADS) {
      if (Math.abs(x - cx) < hw + r && Math.abs(z - cz) < hd + r) return false;
    }
    if (x > 20.5) return false; // keep the east duel lane open
    for (const [px, pz, pr] of placed) {
      if (Math.hypot(x - px, z - pz) < r + pr) return false;
    }
    return true;
  };

  // Sandbag emplacements (three staggered courses of bags).
  for (let i = 0; i < 8; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 6);
      const z = (rng() * 2 - 1) * (half - 6);
      if (!clearOf(x, z, 2.2)) continue;
      const axis: "x" | "z" = rng() < 0.5 ? "x" : "z";
      const base = heightAt(x, z);
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
  for (let i = 0; i < 14; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 5);
      const z = (rng() * 2 - 1) * (half - 5);
      if (!clearOf(x, z, 2.4)) continue;
      tree(g, x, z, rng);
      placed.push([x, z, 2.4]);
      break;
    }
  }

  // Crates, some with a smaller crate stacked on top.
  for (let i = 0; i < 10; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 5);
      const z = (rng() * 2 - 1) * (half - 5);
      if (!clearOf(x, z, 1.6)) continue;
      const s = 0.9 + rng() * 0.5;
      const base = heightAt(x, z);
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
      [0, 0.1, -23],
      [0, 0.1, 23],
    ],
  };
}

export const MAP = buildMap();

// Deployed cover panels get ids above this; map panel ids stay below it.
export const BUILT_PANEL_ID_BASE = 10000;

export function spawnPoint(team: number, idx: number): [number, number, number] {
  const c = MAP.spawns[team === 0 ? 0 : 1];
  const angle = (idx / 8) * Math.PI * 2;
  const x = c[0] + Math.sin(angle) * 3.5;
  const z = c[2] + Math.cos(angle) * 2.5;
  return [x, heightAt(x, z) + 0.1, z];
}
