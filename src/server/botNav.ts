import {
  NavMeshQuery,
  init as initRecast,
  setRandomSeed,
  type NavMesh,
  type OffMeshConnectionParams,
  type Vector3,
} from "@recast-navigation/core";
import { generateTiledNavMesh } from "@recast-navigation/generators";
import { heightAt, MAP, type PanelDef, TERRAIN_CHUNKS, terrainChunkMesh } from "../shared/map.js";
import { mergeSlabBoxes, PLAYER_HEIGHT, PLAYER_RADIUS, STEP_MAX } from "../shared/physics.js";
import { type GameSim } from "../shared/sim.js";

export type BotNavPoint = [number, number, number];

interface MeshBuilder {
  positions: number[];
  indices: number[];
}

const CELL_SIZE = 0.45;
const CELL_HEIGHT = 0.2;
const TILE_SIZE_VOXELS = 64;
const WALKABLE_RADIUS_VOXELS = Math.ceil(PLAYER_RADIUS / CELL_SIZE);
const WALKABLE_HEIGHT_VOXELS = Math.ceil(PLAYER_HEIGHT / CELL_HEIGHT);
const WALKABLE_CLIMB_VOXELS = Math.ceil(STEP_MAX / CELL_HEIGHT);
const BOT_HALF_EXTENTS: Vector3 = { x: 1.6, y: 3.0, z: 1.6 };
const NAV_CONFIG = {
  cs: CELL_SIZE,
  ch: CELL_HEIGHT,
  tileSize: TILE_SIZE_VOXELS,
  walkableRadius: WALKABLE_RADIUS_VOXELS,
  walkableHeight: WALKABLE_HEIGHT_VOXELS,
  walkableClimb: WALKABLE_CLIMB_VOXELS,
  walkableSlopeAngle: 50,
  borderSize: WALKABLE_RADIUS_VOXELS + 3,
  minRegionArea: 8,
  mergeRegionArea: 20,
  maxSimplificationError: 1.3,
  maxEdgeLen: 24,
  maxVertsPerPoly: 6,
  detailSampleDist: CELL_SIZE * 6,
  detailSampleMaxError: CELL_HEIGHT,
};

export async function initBotNav(): Promise<void> {
  await initRecast();
}

export class BotNav {
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;
  private versionValue = 0;

  get version(): number {
    return this.versionValue;
  }

  warm(sim: GameSim): void {
    this.currentQuery(sim);
  }

  findRoute(
    sim: GameSim,
    start: readonly [number, number, number],
    end: readonly [number, number, number],
  ): BotNavPoint[] | null {
    const query = this.currentQuery(sim);
    if (!query) return null;
    const result = query.computePath(asVector3(start), asVector3(end), {
      halfExtents: BOT_HALF_EXTENTS,
      maxPathPolys: 512,
      maxStraightPathPoints: 128,
    });
    if (!result.success || result.path.length === 0) return null;
    return result.path.map((point) => [point.x, point.y, point.z]);
  }

  randomPoint(sim: GameSim, rng: () => number): BotNavPoint | null {
    const query = this.currentQuery(sim);
    if (!query) return null;
    setRandomSeed(Math.max(1, Math.floor(rng() * 0x7fffffff)));
    const result = query.findRandomPoint();
    if (!result.success) return null;
    const point = result.randomPoint;
    return [point.x, point.y, point.z];
  }

  private currentQuery(sim: GameSim): NavMeshQuery | null {
    if (!this.query) this.rebuild(sim);
    return this.query;
  }

  private rebuild(sim: GameSim): void {
    const mesh = buildNavMeshGeometry(sim);
    const result = generateTiledNavMesh(
      mesh.positions,
      mesh.indices,
      {
        ...NAV_CONFIG,
        offMeshConnections: ladderConnections(),
      },
      false,
    );
    if (!result.success) {
      throw new Error(`failed to build bot navmesh: ${result.error}`);
    }
    this.navMesh = result.navMesh;
    this.query = new NavMeshQuery(result.navMesh, { maxNodes: 4096 });
    this.versionValue++;
  }
}

function ladderConnections(): OffMeshConnectionParams[] {
  return MAP.ladders.map((ladder, index) => ({
    startPosition: {
      x: ladder.x + ladder.nx * 0.45,
      y: heightAt(ladder.x, ladder.z) + 0.15,
      z: ladder.z + ladder.nz * 0.45,
    },
    endPosition: {
      x: ladder.x + ladder.nx * 0.45,
      y: ladder.y1,
      z: ladder.z + ladder.nz * 0.45,
    },
    radius: 0.85,
    bidirectional: true,
    flags: 1,
    area: 0,
    userId: index + 1,
  }));
}

function buildNavMeshGeometry(sim: GameSim): {
  positions: Float32Array;
  indices: Int32Array;
} {
  const builder: MeshBuilder = { positions: [], indices: [] };
  for (let ci = 0; ci < TERRAIN_CHUNKS; ci++) {
    for (let cj = 0; cj < TERRAIN_CHUNKS; cj++) {
      const mesh = terrainChunkMesh(ci, cj);
      addMesh(builder, mesh.vertices, mesh.indices);
    }
  }
  for (const s of MAP.statics) {
    addBox(builder, s.x, s.y, s.z, s.w, s.h, s.d);
  }
  const alive = (pieceId: number): boolean => !sim.destroyedPanels.has(pieceId);
  for (const slab of MAP.slabs) {
    const pieces = MAP.panels.slice(slab.first - 1, slab.last);
    for (const box of mergeSlabBoxes(pieces, alive)) {
      addBox(
        builder,
        (box.x0 + box.x1) / 2,
        (box.y0 + box.y1) / 2,
        (box.z0 + box.z1) / 2,
        box.x1 - box.x0,
        box.y1 - box.y0,
        box.z1 - box.z0,
      );
    }
  }
  for (const panel of sim.builtPanels.values()) {
    addPanelBox(builder, panel);
  }
  return {
    positions: new Float32Array(builder.positions),
    indices: new Int32Array(builder.indices),
  };
}

function addMesh(
  builder: MeshBuilder,
  positions: readonly number[],
  indices: readonly number[],
): void {
  const base = builder.positions.length / 3;
  for (const value of positions) builder.positions.push(value);
  for (const index of indices) builder.indices.push(base + index);
}

function addPanelBox(builder: MeshBuilder, panel: PanelDef): void {
  addBox(builder, panel.x, panel.y, panel.z, panel.ex, panel.ey, panel.ez, panel.rot);
}

function addBox(
  builder: MeshBuilder,
  x: number,
  y: number,
  z: number,
  ex: number,
  ey: number,
  ez: number,
  rotation?: readonly [number, number, number, number],
): void {
  const hx = ex / 2;
  const hy = ey / 2;
  const hz = ez / 2;
  const base = builder.positions.length / 3;
  const corners: Array<[number, number, number]> = [
    [-hx, -hy, -hz],
    [hx, -hy, -hz],
    [hx, -hy, hz],
    [-hx, -hy, hz],
    [-hx, hy, -hz],
    [hx, hy, -hz],
    [hx, hy, hz],
    [-hx, hy, hz],
  ];
  for (const corner of corners) {
    const p = rotation ? rotate(corner, rotation) : corner;
    builder.positions.push(x + p[0], y + p[1], z + p[2]);
  }
  const faces = [
    4, 7, 6, 4, 6, 5, 0, 1, 2, 0, 2, 3, 3, 2, 6, 3, 6, 7, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 0, 3,
    7, 0, 7, 4,
  ];
  for (const index of faces) builder.indices.push(base + index);
}

function rotate(
  point: readonly [number, number, number],
  q: readonly [number, number, number, number],
): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * point[2] - qz * point[1]);
  const ty = 2 * (qz * point[0] - qx * point[2]);
  const tz = 2 * (qx * point[1] - qy * point[0]);
  return [
    point[0] + qw * tx + qy * tz - qz * ty,
    point[1] + qw * ty + qz * tx - qx * tz,
    point[2] + qw * tz + qx * ty - qy * tx,
  ];
}

function asVector3(value: readonly [number, number, number]): Vector3 {
  return { x: value[0], y: value[1], z: value[2] };
}
