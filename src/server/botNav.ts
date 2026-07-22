import { heightAt, MAP, PLAY_HALF } from "../shared/map.js";
import { mergeSlabBoxes, PLAYER_HEIGHT, PLAYER_RADIUS } from "../shared/physics.js";
import { type GameSim } from "../shared/sim.js";

export type BotNavPoint = [number, number, number];

// Recast produced good paths, but its multi-megabyte WASM runtime and full
// tiled-navmesh build sat directly on the server's cold-start path. This
// coarse deterministic grid captures what these bots need (route around
// buildings and steep terrain) without delaying the first player welcome.
const CELL = 6;
const GRID_MIN = -PLAY_HALF;
const GRID_SIZE = Math.ceil((PLAY_HALF * 2) / CELL);
const GRID_COUNT = GRID_SIZE * GRID_SIZE;
const MAX_TERRAIN_STEP = 1.5;
const SEARCH_LIMIT = Math.min(GRID_COUNT, 1024);
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
  private versionValue = 0;

  get version(): number {
    return this.versionValue;
  }

  warm(sim: GameSim): void {
    this.ensureGrid(sim);
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
        // Do not squeeze diagonally through two blocked corners.
        if (dx !== 0 && dz !== 0) {
          if (!walkable[cz * GRID_SIZE + nx] || !walkable[nz * GRID_SIZE + cx]) continue;
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
    if (this.walkable) return;
    const heights = new Float32Array(GRID_COUNT);
    const walkable = new Uint8Array(GRID_COUNT);
    walkable.fill(1);
    for (let cell = 0; cell < GRID_COUNT; cell++) {
      const { x, z } = cellCenter(cell);
      heights[cell] = heightAt(x, z);
    }

    // Reject terrain cells with a cliff-height edge. The character controller
    // can handle ordinary hills and the bot brain already jumps small ledges.
    for (let cell = 0; cell < GRID_COUNT; cell++) {
      const cx = cell % GRID_SIZE;
      const cz = Math.floor(cell / GRID_SIZE);
      for (const [dx, dz] of CARDINALS) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= GRID_SIZE || nz < 0 || nz >= GRID_SIZE) continue;
        const next = nz * GRID_SIZE + nx;
        if (Math.abs(heights[next] - heights[cell]) > MAX_TERRAIN_STEP) {
          walkable[cell] = 0;
          break;
        }
      }
    }

    for (const box of MAP.statics) {
      blockBox(
        walkable,
        heights,
        box.x - box.w / 2,
        box.x + box.w / 2,
        box.y - box.h / 2,
        box.y + box.h / 2,
        box.z - box.d / 2,
        box.z + box.d / 2,
      );
    }
    const alive = (pieceId: number): boolean => !sim.destroyedPanels.has(pieceId);
    for (const slab of MAP.slabs) {
      const pieces = MAP.panels.slice(slab.first - 1, slab.last);
      for (const box of mergeSlabBoxes(pieces, alive)) {
        blockBox(walkable, heights, box.x0, box.x1, box.y0, box.y1, box.z0, box.z1);
      }
    }
    for (const panel of sim.builtPanels.values()) {
      blockBox(
        walkable,
        heights,
        panel.x - panel.ex / 2,
        panel.x + panel.ex / 2,
        panel.y - panel.ey / 2,
        panel.y + panel.ey / 2,
        panel.z - panel.ez / 2,
        panel.z + panel.ez / 2,
      );
    }

    this.heights = heights;
    this.walkable = walkable;
    this.versionValue++;
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

function blockBox(
  walkable: Uint8Array,
  heights: Float32Array,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
): void {
  const padding = PLAYER_RADIUS + 0.25;
  const minX = Math.max(0, Math.floor((x0 - padding - GRID_MIN) / CELL));
  const maxX = Math.min(GRID_SIZE - 1, Math.floor((x1 + padding - GRID_MIN) / CELL));
  const minZ = Math.max(0, Math.floor((z0 - padding - GRID_MIN) / CELL));
  const maxZ = Math.min(GRID_SIZE - 1, Math.floor((z1 + padding - GRID_MIN) / CELL));
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      const cell = z * GRID_SIZE + x;
      const ground = heights[cell];
      // Low floor/step boxes and overhead roofs are traversable; walls and
      // other geometry intersecting the character capsule are not.
      if (y1 > ground + 0.35 && y0 < ground + PLAYER_HEIGHT) walkable[cell] = 0;
    }
  }
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
