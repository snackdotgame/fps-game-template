// The battlefield as data: indestructible statics (ground, perimeter, crates)
// plus destructible PANELS — the unit of BattleBit-style destruction. Wall and
// roof panels have ids and HP; gunfire chips them, sledgehammers breach them,
// explosions delete them in a radius. Deployed cover becomes a panel too.
// Client and server build identical physics worlds from this module.

export interface StaticBox {
  x: number; // center
  y: number;
  z: number;
  w: number; // full extents
  h: number;
  d: number;
  kind: "ground" | "wall" | "crate";
}

export type PanelOrient = "x" | "z" | "flat"; // wall along x, along z, or roof

export interface PanelDef {
  id: number;
  x: number; // center
  y: number;
  z: number;
  orient: PanelOrient;
  // Panels belonging to a building share its id; enough wall damage brings
  // the whole structure down (BattleBit-style critical health).
  buildingId?: number;
}

export interface BuildingDef {
  id: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  wallPanelIds: number[];
  roofPanelIds: number[];
}

// Panel dimensions by orientation (full extents).
export const PANEL_W = 2;
export const PANEL_H = 1.25;
export const PANEL_T = 0.22;

export function panelExtents(orient: PanelOrient): [number, number, number] {
  if (orient === "x") return [PANEL_W, PANEL_H, PANEL_T];
  if (orient === "z") return [PANEL_T, PANEL_H, PANEL_W];
  return [PANEL_W, PANEL_T, PANEL_W]; // flat roof slab 2x2
}

export interface MapDef {
  size: number; // arena is size x size, centered on origin
  statics: StaticBox[];
  panels: PanelDef[];
  buildings: BuildingDef[];
  // Spawn zone centers per team (players fan out around them).
  spawns: [[number, number, number], [number, number, number]];
}

// ---------------------------------------------------------------------------
// Authoring helpers.

let nextPanelId = 1;
let currentBuildingId: number | undefined;

function wallX(
  panels: PanelDef[],
  x0: number,
  x1: number,
  y: number,
  z: number,
  skip: Set<number> = new Set(),
): void {
  let i = 0;
  for (let x = x0 + PANEL_W / 2; x <= x1 - PANEL_W / 2 + 0.01; x += PANEL_W, i++) {
    if (skip.has(i)) continue;
    panels.push({ id: nextPanelId++, x, y, z, orient: "x", buildingId: currentBuildingId });
  }
}

function wallZ(
  panels: PanelDef[],
  z0: number,
  z1: number,
  y: number,
  x: number,
  skip: Set<number> = new Set(),
): void {
  let i = 0;
  for (let z = z0 + PANEL_W / 2; z <= z1 - PANEL_W / 2 + 0.01; z += PANEL_W, i++) {
    if (skip.has(i)) continue;
    panels.push({ id: nextPanelId++, x, y, z, orient: "z", buildingId: currentBuildingId });
  }
}

function roof(panels: PanelDef[], x0: number, x1: number, z0: number, z1: number, y: number): void {
  for (let x = x0 + PANEL_W / 2; x <= x1 - PANEL_W / 2 + 0.01; x += PANEL_W) {
    for (let z = z0 + PANEL_W / 2; z <= z1 - PANEL_W / 2 + 0.01; z += PANEL_W) {
      panels.push({ id: nextPanelId++, x, y, z, orient: "flat", buildingId: currentBuildingId });
    }
  }
}

// A simple rectangular building: two panel rows per wall, a door gap in the
// front, a window gap (top row only) on a side, and a flat destructible roof.
let nextBuildingId = 0;

function building(
  statics: StaticBox[],
  panels: PanelDef[],
  buildings: BuildingDef[],
  cx: number,
  cz: number,
  w: number,
  d: number,
  doorSide: 0 | 1 | 2 | 3, // 0 +z, 1 -z, 2 +x, 3 -x
): void {
  const firstPanel = nextPanelId;
  currentBuildingId = nextBuildingId++;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const rows = [PANEL_H / 2, PANEL_H * 1.5];
  const doorPanel = Math.floor(w / PANEL_W / 2);
  for (const [row, y] of rows.entries()) {
    const doorSkip = (side: number) =>
      doorSide === side && row === 0 ? new Set([doorPanel]) : new Set<number>();
    const windowSkip = (side: number) =>
      doorSide !== side && row === 1 ? new Set([0]) : new Set<number>();
    wallX(panels, x0, x1, y, z1, new Set([...doorSkip(0), ...windowSkip(0)]));
    wallX(panels, x0, x1, y, z0, new Set([...doorSkip(1), ...windowSkip(1)]));
    wallZ(panels, z0, z1, y, x1, new Set([...doorSkip(2), ...windowSkip(2)]));
    wallZ(panels, z0, z1, y, x0, new Set([...doorSkip(3), ...windowSkip(3)]));
  }
  roof(panels, x0, x1, z0, z1, PANEL_H * 2 + PANEL_T / 2);
  // Corner posts (indestructible) so a building keeps its silhouette.
  for (const [px, pz] of [
    [x0, z0],
    [x1, z0],
    [x0, z1],
    [x1, z1],
  ]) {
    statics.push({ x: px, y: PANEL_H, z: pz, w: 0.3, h: PANEL_H * 2, d: 0.3, kind: "wall" });
  }
  const mine = panels.filter((p) => p.id >= firstPanel);
  buildings.push({
    id: currentBuildingId!,
    cx,
    cz,
    w,
    d,
    wallPanelIds: mine.filter((p) => p.orient !== "flat").map((p) => p.id),
    roofPanelIds: mine.filter((p) => p.orient === "flat").map((p) => p.id),
  });
  currentBuildingId = undefined;
}

function crate(statics: StaticBox[], x: number, z: number, s = 1.4): void {
  statics.push({ x, y: s / 2, z, w: s, h: s, d: s, kind: "crate" });
}

// ---------------------------------------------------------------------------

function buildMap(): MapDef {
  nextPanelId = 1;
  nextBuildingId = 0;
  const size = 56;
  const statics: StaticBox[] = [];
  const panels: PanelDef[] = [];
  const buildings: BuildingDef[] = [];

  // Ground and perimeter (indestructible).
  statics.push({ x: 0, y: -0.5, z: 0, w: size, h: 1, d: size, kind: "ground" });
  const half = size / 2;
  statics.push({ x: 0, y: 1.5, z: -half, w: size, h: 3, d: 1, kind: "wall" });
  statics.push({ x: 0, y: 1.5, z: half, w: size, h: 3, d: 1, kind: "wall" });
  statics.push({ x: -half, y: 1.5, z: 0, w: 1, h: 3, d: size, kind: "wall" });
  statics.push({ x: half, y: 1.5, z: 0, w: 1, h: 3, d: size, kind: "wall" });

  // Buildings: a contested center block and four flanking houses.
  building(statics, panels, buildings, 0, 0, 10, 8, 0);
  building(statics, panels, buildings, -15, -12, 8, 8, 2);
  building(statics, panels, buildings, 15, 12, 8, 8, 3);
  building(statics, panels, buildings, 16, -14, 8, 6, 0);
  building(statics, panels, buildings, -16, 14, 8, 6, 1);

  // Freestanding cover walls (destructible) along the midline flanks.
  wallX(panels, -10, -2, PANEL_H / 2, 10);
  wallX(panels, 2, 10, PANEL_H / 2, -10);
  wallZ(panels, -6, 2, PANEL_H / 2, -22);
  wallZ(panels, -2, 6, PANEL_H / 2, 22);

  // Crates for hard cover.
  crate(statics, -8, 4);
  crate(statics, 8, -4);
  crate(statics, -20, 2);
  crate(statics, 20, -2);
  crate(statics, 4, 18);
  crate(statics, -4, -18);
  crate(statics, 11, 6, 1.0);
  crate(statics, -11, -6, 1.0);

  return {
    size,
    statics,
    panels,
    buildings,
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
  return [c[0] + Math.sin(angle) * 3.5, c[1], c[2] + Math.cos(angle) * 2.5];
}
