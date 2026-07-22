import { heightAt, MAP, mapSeed, type PanelDef, PLAY_HALF } from "../shared/map.js";
import { PLAYER_HEIGHT, PLAYER_RADIUS } from "../shared/physics.js";
import { type GameSim } from "../shared/sim.js";

export type BotNavPoint = [number, number, number];

// Recast produced good paths, but its multi-megabyte WASM runtime and full
// tiled-navmesh build sat directly on the server's cold-start path. This
// deterministic clearance grid stays lightweight while resolving authored
// doors, wall corners, and the terrain around buildings accurately enough for
// a player-sized capsule.
const CELL = 2;
const GRID_MIN = -PLAY_HALF;
const GRID_SIZE = Math.ceil((PLAY_HALF * 2) / CELL);
const GRID_COUNT = GRID_SIZE * GRID_SIZE;
const MAX_TERRAIN_STEP = 1.5;
const SEARCH_LIMIT = Math.min(GRID_COUNT, 10_000);
const CLEARANCE = PLAYER_RADIUS + 0.18;
const STEER_LOOKAHEAD = 3.2;
export const BOT_NAV_WAYPOINT_RADIUS = 0.8;
const CARDINALS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  ...CARDINALS,
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

// Kept async-compatible with the old API so server boot orchestration stays
// simple. There is no secondary WASM runtime to initialize anymore.
export async function initBotNav(): Promise<void> {}

export class BotNav {
  private walkable: Uint8Array | null = null;
  private heights: Float32Array | null = null;
  private blockers: Uint16Array | null = null;
  private readonly knownDestroyed = new Set<number>();
  private readonly knownBuilt = new Map<number, PanelDef>();
  private versionValue = 0;
  private sourceRevision = -1;
  private sourceMapSeed = -1;
  private sourceGeneration = -1;

  get version(): number {
    return this.versionValue;
  }

  warm(sim: GameSim): void {
    this.ensureGrid(sim);
  }

  sync(sim: GameSim): number {
    this.ensureGrid(sim);
    return this.versionValue;
  }

  findRoute(
    sim: GameSim,
    start: readonly [number, number, number],
    end: readonly [number, number, number],
  ): BotNavPoint[] | null {
    this.ensureGrid(sim);
    const walkable = this.walkable!;
    const heights = this.heights!;
    const startCell = nearestWalkable(walkable, pointCell(start[0], start[2]));
    const endCell = nearestWalkable(walkable, pointCell(end[0], end[2]));
    if (startCell < 0 || endCell < 0) return null;
    if (startCell === endCell) return [cellPoint(endCell, heights)];

    const costs = new Float32Array(GRID_COUNT);
    costs.fill(Number.POSITIVE_INFINITY);
    costs[startCell] = 0;
    const cameFrom = new Int32Array(GRID_COUNT);
    cameFrom.fill(-1);
    const closed = new Uint8Array(GRID_COUNT);
    const open = new MinHeap();
    open.push(startCell, heuristic(startCell, endCell));
    let visited = 0;

    while (open.size > 0 && visited++ < SEARCH_LIMIT) {
      const current = open.pop();
      if (current < 0 || closed[current]) continue;
      if (current === endCell) return reconstructPath(cameFrom, endCell, heights);
      closed[current] = 1;
      const cx = current % GRID_SIZE;
      const cz = Math.floor(current / GRID_SIZE);
      for (const [dx, dz] of NEIGHBORS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= GRID_SIZE || nz < 0 || nz >= GRID_SIZE) continue;
        const next = nz * GRID_SIZE + nx;
        if (!walkable[next] || closed[next]) continue;
        if (!canStep(heights, current, next)) continue;
        // Do not squeeze diagonally through two blocked corners.
        if (dx !== 0 && dz !== 0) {
          const sideX = cz * GRID_SIZE + nx;
          const sideZ = nz * GRID_SIZE + cx;
          if (
            !walkable[sideX] ||
            !walkable[sideZ] ||
            !canStep(heights, current, sideX) ||
            !canStep(heights, current, sideZ)
          ) {
            continue;
          }
        }
        const planar = dx === 0 || dz === 0 ? 1 : Math.SQRT2;
        const rise = Math.abs(heights[next] - heights[current]);
        const nextCost = costs[current] + planar + rise * 0.35;
        if (nextCost >= costs[next]) continue;
        costs[next] = nextCost;
        cameFrom[next] = current;
        open.push(next, nextCost + heuristic(next, endCell));
      }
    }
    return null;
  }

  // Keep short-horizon movement out of walls even when a visible enemy makes
  // the combat brain strafe instead of following a long objective route.
  // Candidate directions are deterministic and bounded; no per-tick A* is
  // needed for ordinary corner avoidance.
  steer(
    sim: GameSim,
    position: readonly [number, number, number],
    desiredX: number,
    desiredZ: number,
    sidePreference: number,
  ): { x: number; z: number } {
    this.ensureGrid(sim);
    const magnitude = Math.hypot(desiredX, desiredZ);
    if (magnitude < 1e-5) return { x: 0, z: 0 };
    const nx = desiredX / magnitude;
    const nz = desiredZ / magnitude;
    const side = sidePreference < 0 ? -1 : 1;
    const turns = [0, side, -side, side * 2, -side * 2, side * 3, -side * 3, 4];
    for (const turn of turns) {
      const angle = turn * (Math.PI / 4);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const x = nx * cos - nz * sin;
      const z = nx * sin + nz * cos;
      if (this.canAdvance(position[0], position[2], x, z, STEER_LOOKAHEAD)) {
        return { x: x * magnitude, z: z * magnitude };
      }
    }
    return { x: 0, z: 0 };
  }

  randomPoint(sim: GameSim, rng: () => number): BotNavPoint | null {
    this.ensureGrid(sim);
    const walkable = this.walkable!;
    const heights = this.heights!;
    const first = Math.floor(rng() * GRID_COUNT);
    for (let offset = 0; offset < GRID_COUNT; offset++) {
      const cell = (first + offset * 97) % GRID_COUNT;
      if (walkable[cell]) return cellPoint(cell, heights);
    }
    return null;
  }

  private ensureGrid(sim: GameSim): void {
    if (
      this.walkable &&
      (this.sourceMapSeed !== mapSeed() || this.sourceGeneration !== sim.navGeneration)
    ) {
      this.walkable = null;
      this.heights = null;
      this.blockers = null;
      this.knownDestroyed.clear();
      this.knownBuilt.clear();
    }
    if (!this.walkable) {
      this.buildInitialGrid(sim);
      return;
    }
    if (this.sourceRevision === sim.navRevision) return;
    this.syncTopology(sim);
  }

  private buildInitialGrid(sim: GameSim): void {
    const heights = new Float32Array(GRID_COUNT);
    const walkable = new Uint8Array(GRID_COUNT);
    const blockers = new Uint16Array(GRID_COUNT);
    walkable.fill(1);
    for (let cell = 0; cell < GRID_COUNT; cell++) {
      const { x, z } = cellCenter(cell);
      heights[cell] = heightAt(x, z);
    }
    this.heights = heights;
    this.walkable = walkable;
    this.blockers = blockers;
    this.knownDestroyed.clear();
    this.knownBuilt.clear();

    for (const box of MAP.statics) {
      this.adjustBox(
        box.x - box.w / 2,
        box.x + box.w / 2,
        box.y - box.h / 2,
        box.y + box.h / 2,
        box.z - box.d / 2,
        box.z + box.d / 2,
        1,
      );
    }
    for (const panel of MAP.panels) this.adjustPanel(panel, 1);
    for (const panelId of sim.destroyedPanels) {
      const panel = MAP.panels[panelId - 1];
      if (panel?.id === panelId) this.adjustPanel(panel, -1);
      this.knownDestroyed.add(panelId);
    }
    for (const panel of sim.builtPanels.values()) {
      this.adjustPanel(panel, 1);
      this.knownBuilt.set(panel.id, panel);
    }
    this.sourceRevision = sim.navRevision;
    this.sourceMapSeed = mapSeed();
    this.sourceGeneration = sim.navGeneration;
    this.versionValue++;
  }

  private syncTopology(sim: GameSim): void {
    for (const panelId of sim.destroyedPanels) {
      if (this.knownDestroyed.has(panelId)) continue;
      this.knownDestroyed.add(panelId);
      const panel = MAP.panels[panelId - 1];
      if (panel?.id === panelId) this.adjustPanel(panel, -1);
    }
    for (const [panelId, panel] of this.knownBuilt) {
      if (sim.builtPanels.has(panelId)) continue;
      this.adjustPanel(panel, -1);
      this.knownBuilt.delete(panelId);
    }
    for (const [panelId, panel] of sim.builtPanels) {
      if (this.knownBuilt.has(panelId)) continue;
      this.adjustPanel(panel, 1);
      this.knownBuilt.set(panelId, panel);
    }
    this.sourceRevision = sim.navRevision;
    this.versionValue++;
  }

  private adjustPanel(panel: PanelDef, delta: 1 | -1): void {
    const half = rotatedHorizontalHalfExtents(panel);
    this.adjustBox(
      panel.x - half.x,
      panel.x + half.x,
      panel.y - half.y,
      panel.y + half.y,
      panel.z - half.z,
      panel.z + half.z,
      delta,
    );
  }

  private adjustBox(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    delta: 1 | -1,
  ): void {
    adjustBox(this.blockers!, this.walkable!, this.heights!, x0, x1, y0, y1, z0, z1, delta);
  }

  private canAdvance(x: number, z: number, dirX: number, dirZ: number, length: number): boolean {
    const walkable = this.walkable!;
    const heights = this.heights!;
    const start = pointCell(x, z);
    let previous = start;
    const samples = Math.ceil(length / (CELL * 0.45));
    for (let sample = 1; sample <= samples; sample++) {
      const distance = (length * sample) / samples;
      const px = x + dirX * distance;
      const pz = z + dirZ * distance;
      if (px < GRID_MIN || pz < GRID_MIN || px >= PLAY_HALF || pz >= PLAY_HALF) return false;
      const cell = pointCell(px, pz);
      // A bot can start in a cell newly blocked by built cover; permit motion
      // within that cell so it can escape, but require every entered cell to
      // have capsule clearance.
      if (cell !== start && !walkable[cell]) return false;
      if (cell !== previous && !canStep(heights, previous, cell)) return false;
      previous = cell;
    }
    return true;
  }
}

function pointCell(x: number, z: number): number {
  const cx = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((x - GRID_MIN) / CELL)));
  const cz = Math.max(0, Math.min(GRID_SIZE - 1, Math.floor((z - GRID_MIN) / CELL)));
  return cz * GRID_SIZE + cx;
}

function cellCenter(cell: number): { x: number; z: number } {
  const cx = cell % GRID_SIZE;
  const cz = Math.floor(cell / GRID_SIZE);
  return { x: GRID_MIN + (cx + 0.5) * CELL, z: GRID_MIN + (cz + 0.5) * CELL };
}

function cellPoint(cell: number, heights: Float32Array): BotNavPoint {
  const { x, z } = cellCenter(cell);
  return [x, heights[cell] + 0.15, z];
}

function nearestWalkable(walkable: Uint8Array, origin: number): number {
  if (walkable[origin]) return origin;
  const ox = origin % GRID_SIZE;
  const oz = Math.floor(origin / GRID_SIZE);
  for (let radius = 1; radius <= 8; radius++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
        const x = ox + dx;
        const z = oz + dz;
        if (x < 0 || x >= GRID_SIZE || z < 0 || z >= GRID_SIZE) continue;
        const cell = z * GRID_SIZE + x;
        if (walkable[cell]) return cell;
      }
    }
  }
  return -1;
}

function adjustBox(
  blockers: Uint16Array,
  walkable: Uint8Array,
  heights: Float32Array,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  delta: 1 | -1,
): void {
  const minWorldX = x0 - CLEARANCE;
  const maxWorldX = x1 + CLEARANCE;
  const minWorldZ = z0 - CLEARANCE;
  const maxWorldZ = z1 + CLEARANCE;
  const minX = Math.max(0, Math.floor((minWorldX - GRID_MIN) / CELL));
  const maxX = Math.min(GRID_SIZE - 1, Math.floor((maxWorldX - GRID_MIN) / CELL));
  const minZ = Math.max(0, Math.floor((minWorldZ - GRID_MIN) / CELL));
  const maxZ = Math.min(GRID_SIZE - 1, Math.floor((maxWorldZ - GRID_MIN) / CELL));
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const cell = z * GRID_SIZE + x;
      const ground = heights[cell];
      const centerX = GRID_MIN + (x + 0.5) * CELL;
      const centerZ = GRID_MIN + (z + 0.5) * CELL;
      // Low floor/step boxes and overhead roofs are traversable; walls and
      // other geometry intersecting the character capsule are not.
      if (
        centerX >= minWorldX &&
        centerX <= maxWorldX &&
        centerZ >= minWorldZ &&
        centerZ <= maxWorldZ &&
        y1 > ground + 0.35 &&
        y0 < ground + PLAYER_HEIGHT
      ) {
        const count = blockers[cell];
        blockers[cell] = delta > 0 ? Math.min(0xffff, count + 1) : Math.max(0, count - 1);
        walkable[cell] = blockers[cell] === 0 ? 1 : 0;
      }
    }
  }
}

function rotatedHorizontalHalfExtents(panel: PanelDef): { x: number; y: number; z: number } {
  const hx = panel.ex / 2;
  const hy = panel.ey / 2;
  const hz = panel.ez / 2;
  if (!panel.rot) return { x: hx, y: hy, z: hz };
  const [qx, qy, qz, qw] = panel.rot;
  const xx = qx * qx;
  const yy = qy * qy;
  const zz = qz * qz;
  const xy = qx * qy;
  const xz = qx * qz;
  const yz = qy * qz;
  const wx = qw * qx;
  const wy = qw * qy;
  const wz = qw * qz;
  const m00 = 1 - 2 * (yy + zz);
  const m01 = 2 * (xy - wz);
  const m02 = 2 * (xz + wy);
  const m10 = 2 * (xy + wz);
  const m11 = 1 - 2 * (xx + zz);
  const m12 = 2 * (yz - wx);
  const m20 = 2 * (xz - wy);
  const m21 = 2 * (yz + wx);
  const m22 = 1 - 2 * (xx + yy);
  return {
    x: Math.abs(m00) * hx + Math.abs(m01) * hy + Math.abs(m02) * hz,
    y: Math.abs(m10) * hx + Math.abs(m11) * hy + Math.abs(m12) * hz,
    z: Math.abs(m20) * hx + Math.abs(m21) * hy + Math.abs(m22) * hz,
  };
}

function canStep(heights: Float32Array, from: number, to: number): boolean {
  return Math.abs(heights[to] - heights[from]) <= MAX_TERRAIN_STEP;
}

function heuristic(from: number, to: number): number {
  const dx = (from % GRID_SIZE) - (to % GRID_SIZE);
  const dz = Math.floor(from / GRID_SIZE) - Math.floor(to / GRID_SIZE);
  return Math.hypot(dx, dz);
}

function reconstructPath(
  cameFrom: Int32Array,
  endCell: number,
  heights: Float32Array,
): BotNavPoint[] {
  const cells: number[] = [];
  for (let cell = endCell; cell >= 0; cell = cameFrom[cell]) cells.push(cell);
  cells.reverse();
  const simplified: number[] = [];
  let lastDx = Number.NaN;
  let lastDz = Number.NaN;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const next = cells[i + 1];
    if (next === undefined) {
      simplified.push(cell);
      continue;
    }
    const dx = (next % GRID_SIZE) - (cell % GRID_SIZE);
    const dz = Math.floor(next / GRID_SIZE) - Math.floor(cell / GRID_SIZE);
    if (i === 0 || dx !== lastDx || dz !== lastDz) simplified.push(cell);
    lastDx = dx;
    lastDz = dz;
  }
  return simplified.slice(0, 128).map((cell) => cellPoint(cell, heights));
}

class MinHeap {
  private readonly cells: number[] = [];
  private readonly priorities: number[] = [];

  get size(): number {
    return this.cells.length;
  }

  push(cell: number, priority: number): void {
    let index = this.cells.length;
    this.cells.push(cell);
    this.priorities.push(priority);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.priorities[parent] <= priority) break;
      this.cells[index] = this.cells[parent];
      this.priorities[index] = this.priorities[parent];
      index = parent;
    }
    this.cells[index] = cell;
    this.priorities[index] = priority;
  }

  pop(): number {
    if (this.cells.length === 0) return -1;
    const first = this.cells[0];
    const lastCell = this.cells.pop()!;
    const lastPriority = this.priorities.pop()!;
    if (this.cells.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.cells.length) break;
      const right = left + 1;
      const child =
        right < this.cells.length && this.priorities[right] < this.priorities[left] ? right : left;
      if (this.priorities[child] >= lastPriority) break;
      this.cells[index] = this.cells[child];
      this.priorities[index] = this.priorities[child];
      index = child;
    }
    this.cells[index] = lastCell;
    this.priorities[index] = lastPriority;
    return first;
  }
}
