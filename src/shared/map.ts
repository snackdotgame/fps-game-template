// The battlefield, procedurally generated from a fixed seed so client and
// server build identical worlds. Terrain is a value-noise heightfield
// (flattened under buildings and spawns); buildings are fine-grained grids of
// destructible PANELS (1m x 0.625m pieces — gunfire chips them, explosions
// blow holes, enough wall loss collapses the whole structure); trees are
// destructible too — break the trunk and the tree comes down. Deployed cover
// becomes a panel at runtime.

export const MAP_SEED = 0xb17b17;

export interface StaticBox {
  x: number; // center
  y: number;
  z: number;
  w: number; // full extents
  h: number;
  d: number;
  kind: "wall" | "crate";
}

// "x"/"z": wall pieces along an axis. "flat": roof slab. "bx"/"bz": deployed
// cover (wider). "trunk": tree trunk segment. "canopy": tree foliage block.
export type PanelOrient = "x" | "z" | "flat" | "bx" | "bz" | "trunk" | "canopy";

export interface PanelDef {
  id: number;
  x: number; // center
  y: number;
  z: number;
  orient: PanelOrient;
  // Panels belonging to a structure share its id; enough structural damage
  // brings the whole thing down (BattleBit-style critical health).
  buildingId?: number;
}

export interface BuildingDef {
  id: number;
  kind: "building" | "tree";
  cx: number;
  cz: number;
  w: number;
  d: number;
  wallPanelIds: number[]; // the structural panels that count toward collapse
  roofPanelIds: number[]; // fall with the structure but don't count
  collapseFraction: number; // fraction of structural panels lost -> collapse
}

// Panel dimensions by orientation (full extents).
export const PANEL_W = 1;
export const PANEL_H = 0.625;
export const PANEL_T = 0.22;
export const WALL_ROWS = 4; // 2.5m walls

export function panelExtents(orient: PanelOrient): [number, number, number] {
  switch (orient) {
    case "x":
      return [PANEL_W, PANEL_H, PANEL_T];
    case "z":
      return [PANEL_T, PANEL_H, PANEL_W];
    case "flat":
      return [PANEL_W, PANEL_T, PANEL_W];
    case "bx":
      return [2, 1.25, PANEL_T];
    case "bz":
      return [PANEL_T, 1.25, 2];
    case "trunk":
      return [0.5, 1.0, 0.5];
    case "canopy":
      return [2.0, 1.6, 2.0];
  }
}

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
export const TERRAIN_CELL = 2;

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

function wallRun(
  g: Gen,
  orient: "x" | "z",
  a0: number,
  a1: number,
  fixed: number,
  buildingId: number | undefined,
  gaps: (col: number, row: number) => boolean = () => false,
): void {
  const cols = Math.round((a1 - a0) / PANEL_W);
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < WALL_ROWS; row++) {
      if (gaps(col, row)) continue;
      const along = a0 + (col + 0.5) * PANEL_W;
      const y = (row + 0.5) * PANEL_H;
      g.panels.push({
        id: nextPanelId++,
        x: orient === "x" ? along : fixed,
        y,
        z: orient === "x" ? fixed : along,
        orient,
        buildingId,
      });
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
): void {
  const id = nextBuildingId++;
  const firstPanel = nextPanelId;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;

  // Door: a 1-col x 3-row opening centered on its wall. Windows: a 2-col x
  // 1-row opening (row 2) centered on every other wall.
  const doorGap = (cols: number) => {
    const c = Math.floor(cols / 2);
    return (col: number, row: number) => col === c && row < 3;
  };
  const windowGap = (cols: number) => {
    const c = Math.floor(cols / 2);
    return (col: number, row: number) => (col === c || col === c - 1) && row === 2;
  };
  const pick = (side: number, cols: number) =>
    doorSide === side ? doorGap(cols) : windowGap(cols);

  wallRun(g, "x", x0, x1, z1, id, pick(0, Math.round(w)));
  wallRun(g, "x", x0, x1, z0, id, pick(1, Math.round(w)));
  wallRun(g, "z", z0, z1, x1, id, pick(2, Math.round(d)));
  wallRun(g, "z", z0, z1, x0, id, pick(3, Math.round(d)));

  const roofY = WALL_ROWS * PANEL_H + PANEL_T / 2;
  const roofIds: number[] = [];
  for (let x = x0 + PANEL_W / 2; x <= x1 - PANEL_W / 2 + 0.01; x += PANEL_W) {
    for (let z = z0 + PANEL_W / 2; z <= z1 - PANEL_W / 2 + 0.01; z += PANEL_W) {
      roofIds.push(nextPanelId);
      g.panels.push({ id: nextPanelId++, x, y: roofY, z, orient: "flat", buildingId: id });
    }
  }

  // Indestructible corner posts keep the silhouette until collapse.
  for (const [px, pz] of [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ]) {
    g.statics.push({
      x: px,
      y: (WALL_ROWS * PANEL_H) / 2,
      z: pz,
      w: 0.3,
      h: WALL_ROWS * PANEL_H,
      d: 0.3,
      kind: "wall",
    });
  }

  const mine = g.panels.filter((p) => p.id >= firstPanel);
  g.buildings.push({
    id,
    kind: "building",
    cx,
    cz,
    w,
    d,
    wallPanelIds: mine.filter((p) => p.orient !== "flat").map((p) => p.id),
    roofPanelIds: roofIds,
    collapseFraction: 0.4,
  });
}

function tree(g: Gen, x: number, z: number): void {
  const id = nextBuildingId++;
  const base = heightAt(x, z);
  const trunkIds: number[] = [];
  for (let seg = 0; seg < 2; seg++) {
    trunkIds.push(nextPanelId);
    g.panels.push({
      id: nextPanelId++,
      x,
      y: base + 0.5 + seg,
      z,
      orient: "trunk",
      buildingId: id,
    });
  }
  const canopyIds = [nextPanelId];
  g.panels.push({ id: nextPanelId++, x, y: base + 2.8, z, orient: "canopy", buildingId: id });
  g.buildings.push({
    id,
    kind: "tree",
    cx: x,
    cz: z,
    w: 0.9,
    d: 0.9,
    wallPanelIds: trunkIds,
    roofPanelIds: canopyIds,
    collapseFraction: 0.5, // one trunk segment fells it
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

  // Buildings on their flat pads (positions match FLAT_PADS).
  building(g, 0, 0, 10, 8, 0);
  building(g, -15, -12, 8, 8, 2);
  building(g, 15, 12, 8, 8, 3);
  building(g, 16, -14, 8, 6, 0);
  building(g, -16, 14, 8, 6, 1);

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

  // Freestanding cover walls (2 cols x 2 rows of panels).
  for (let i = 0; i < 8; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 6);
      const z = (rng() * 2 - 1) * (half - 6);
      if (!clearOf(x, z, 2.2)) continue;
      const along: "x" | "z" = rng() < 0.5 ? "x" : "z";
      const base = heightAt(x, z);
      for (let col = 0; col < 2; col++) {
        for (let row = 0; row < 2; row++) {
          const a = (col - 0.5) * PANEL_W;
          g.panels.push({
            id: nextPanelId++,
            x: along === "x" ? x + a : x,
            y: base + (row + 0.5) * PANEL_H,
            z: along === "x" ? z : z + a,
            orient: along,
          });
        }
      }
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
      tree(g, x, z);
      placed.push([x, z, 2.4]);
      break;
    }
  }

  // Crates.
  for (let i = 0; i < 10; i++) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const x = (rng() * 2 - 1) * (half - 5);
      const z = (rng() * 2 - 1) * (half - 5);
      if (!clearOf(x, z, 1.6)) continue;
      const s = 1.0 + rng() * 0.7;
      g.statics.push({ x, y: heightAt(x, z) + s / 2, z, w: s, h: s, d: s, kind: "crate" });
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
