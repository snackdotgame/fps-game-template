declare module "@recast-navigation/core" {
  export type Vector3 = {
    x: number;
    y: number;
    z: number;
  };

  export type OffMeshConnectionParams = {
    startPosition: Vector3;
    endPosition: Vector3;
    radius: number;
    bidirectional: boolean;
    area?: number;
    flags?: number;
    userId?: number;
  };

  export class NavMesh {
    destroy(): void;
  }

  export class NavMeshQuery {
    constructor(navMesh: NavMesh, params?: { maxNodes?: number });
    computePath(
      start: Vector3,
      end: Vector3,
      options?: {
        halfExtents?: Vector3;
        maxPathPolys?: number;
        maxStraightPathPoints?: number;
      },
    ): { success: boolean; path: Vector3[]; error?: { name: string; status?: number } };
    findRandomPoint(): { success: boolean; randomPoint: Vector3 };
    destroy(): void;
  }

  export function init(): Promise<void>;
  export function setRandomSeed(seed: number): void;
}

declare module "@recast-navigation/generators" {
  import type { NavMesh, OffMeshConnectionParams } from "@recast-navigation/core";

  export type TiledNavMeshGeneratorConfig = {
    cs: number;
    ch: number;
    tileSize: number;
    walkableRadius: number;
    walkableHeight: number;
    walkableClimb: number;
    walkableSlopeAngle: number;
    borderSize: number;
    minRegionArea: number;
    mergeRegionArea: number;
    maxSimplificationError: number;
    maxEdgeLen: number;
    maxVertsPerPoly: number;
    detailSampleDist: number;
    detailSampleMaxError: number;
    offMeshConnections?: OffMeshConnectionParams[];
  };

  export function generateTiledNavMesh(
    positions: ArrayLike<number>,
    indices: ArrayLike<number>,
    config?: Partial<TiledNavMeshGeneratorConfig>,
    keepIntermediates?: boolean,
  ):
    | { success: true; navMesh: NavMesh; intermediates: unknown }
    | { success: false; navMesh: undefined; error: string; intermediates: unknown };
}
