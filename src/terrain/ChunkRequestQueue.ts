import { Vector3 } from 'three';
import type { TerrainArgs } from './terrain';
import { parseGridKey, getChunkWorldCenter } from './LodUtils';

/**
 * A queued chunk generation request
 */
export interface QueuedRequest {
  gridKey: string;
  lodLevel: number;
  terrainArgs: TerrainArgs;
}

/**
 * Configuration for chunk dimensions (needed for priority calculation)
 */
export interface ChunkConfig {
  chunkWidth: number;
  chunkDepth: number;
}

/**
 * Dependencies for ChunkRequestQueue (for testability)
 */
export interface ChunkRequestQueueDependencies {
  calculatePriority: (
    gridKey: string,
    cameraPos: Vector3,
    cameraForward: Vector3,
    chunkConfig: ChunkConfig,
    nearestChunkKeys: Set<string>,
    lodLevel?: number,
    maxLodLevel?: number
  ) => number;
}

/**
 * Calculate priority for a chunk based on distance and camera direction.
 * Lower values = higher priority.
 * 
 * @param gridKey - The chunk's grid key (e.g., "1,2")
 * @param cameraPos - Camera world position
 * @param cameraForward - Camera forward direction (normalized)
 * @param chunkConfig - Chunk dimensions
 * @param nearestChunkKeys - Set of nearest 10 chunk keys (by distance)
 * @returns Priority value (lower = higher priority)
 */
export function defaultPriorityCalculator(
  gridKey: string,
  cameraPos: Vector3,
  cameraForward: Vector3,
  chunkConfig: ChunkConfig,
  nearestChunkKeys: Set<string>,
  lodLevel?: number,
  maxLodLevel?: number
): number {
  // Calculate distance and direction FIRST (used by all tiers)
  const [gridX, gridZ] = parseGridKey(gridKey);
  const chunkCenter = getChunkWorldCenter(
    gridX,
    gridZ,
    chunkConfig.chunkWidth,
    chunkConfig.chunkDepth
  );

  // Calculate distance from camera to chunk center (2D, ignoring Y)
  const dx = chunkCenter.x - cameraPos.x;
  const dz = chunkCenter.z - cameraPos.z;
  const distance = Math.sqrt(dx * dx + dz * dz);

  // Calculate direction to chunk (normalized, 2D)
  const dirLength = distance > 0.001 ? distance : 1;
  const dirX = dx / dirLength;
  const dirZ = dz / dirLength;

  // Dot product with camera forward (2D, ignoring Y)
  const dot = dirX * cameraForward.x + dirZ * cameraForward.z;

  // Direction factor: chunks in front get bonus (lower value)
  // Scale appropriately for each tier
  const directionFactor = -dot * 500;

  const isCoarsest = lodLevel !== undefined && maxLodLevel !== undefined && lodLevel === maxLodLevel;
  const isNearest = nearestChunkKeys.has(gridKey);

  // Tier 1: Nearest 25 chunks (Top Priority)
  if (isNearest) {
    // lodPriority ensures coarsest of near chunks build first
    // Subtract lodLevel from maxLodLevel so highest lodLevel (lowest detail) has SMALLEST value
    const lodPriority = (lodLevel !== undefined && maxLodLevel !== undefined)
      ? (maxLodLevel - lodLevel) * 10000
      : 0;
    return -20000000 + distance + directionFactor + lodPriority;
  }

  // Tier 2: Horizon Fill (Coarsest LOD for all others)
  if (isCoarsest) {
    return -10000000 + distance + directionFactor;
  }

  // Tier 3: Standard progressive detail
  const lodPriority = (lodLevel !== undefined && maxLodLevel !== undefined)
    ? (maxLodLevel - lodLevel) * 1000000
    : 0;

  // When LOD levels are equal, distance should dominate
  // Scale directionFactor to be smaller than distance differences
  // Use a smaller multiplier so distance is the primary factor
  const scaledDirectionFactor = directionFactor * 0.1;

  return distance + scaledDirectionFactor + lodPriority;
}

const defaultDependencies: ChunkRequestQueueDependencies = {
  calculatePriority: defaultPriorityCalculator,
};

/**
 * Priority queue for chunk generation requests.
 * Supports re-sorting based on camera position and pruning stale requests.
 */
export class ChunkRequestQueue {
  private queue: QueuedRequest[] = [];
  private queuedSet: Set<string> = new Set(); // O(1) lookup: "gridKey:lodLevel"
  private dependencies: ChunkRequestQueueDependencies;
  private chunkConfig: ChunkConfig;

  constructor(
    chunkConfig: ChunkConfig,
    dependencyOverrides?: Partial<ChunkRequestQueueDependencies>
  ) {
    this.chunkConfig = chunkConfig;
    this.dependencies = { ...defaultDependencies, ...dependencyOverrides };
  }

  /**
   * Generate a unique key for a chunk+LOD combination
   */
  private getRequestKey(gridKey: string, lodLevel: number): string {
    return `${gridKey}:${lodLevel}`;
  }

  /**
   * Add a request to the queue if not already present.
   * @returns true if added, false if duplicate
   */
  add(request: QueuedRequest): boolean {
    const key = this.getRequestKey(request.gridKey, request.lodLevel);
    if (this.queuedSet.has(key)) {
      return false;
    }
    this.queue.push(request);
    this.queuedSet.add(key);
    return true;
  }

  /**
   * Check if a request for the given chunk and LOD level is already queued.
   */
  has(gridKey: string, lodLevel: number): boolean {
    const key = this.getRequestKey(gridKey, lodLevel);
    return this.queuedSet.has(key);
  }

  /**
   * Remove requests for chunks not in the valid set.
   * Call this to prune chunks that are no longer in render distance.
   */
  pruneStale(validKeys: Set<string>): void {
    this.queue = this.queue.filter((req) => {
      const isValid = validKeys.has(req.gridKey);
      if (!isValid) {
        const key = this.getRequestKey(req.gridKey, req.lodLevel);
        this.queuedSet.delete(key);
      }
      return isValid;
    });
  }

  /**
   * Sort the queue by priority (lowest priority value first).
   * Should be called each frame after camera moves.
   * 
   * @param cameraPos - Camera world position
   * @param cameraForward - Camera forward direction (normalized)
   * @param nearestChunkKeys - Set of nearest 10 chunk keys (by distance)
   */
  sort(
    cameraPos: Vector3,
    cameraForward: Vector3,
    nearestChunkKeys: Set<string>,
    maxLodLevel?: number
  ): void {
    this.queue.sort((a, b) => {
      const priorityA = this.dependencies.calculatePriority(
        a.gridKey,
        cameraPos,
        cameraForward,
        this.chunkConfig,
        nearestChunkKeys,
        a.lodLevel,
        maxLodLevel
      );
      const priorityB = this.dependencies.calculatePriority(
        b.gridKey,
        cameraPos,
        cameraForward,
        this.chunkConfig,
        nearestChunkKeys,
        b.lodLevel,
        maxLodLevel
      );
      return priorityA - priorityB;
    });
  }

  /**
   * Remove and return the first request matching any of the priority keys,
   * skipping those already in flight.
   */
  shiftMatching(priorityKeys: Set<string>, inFlight: Set<string>): QueuedRequest | undefined {
    const index = this.queue.findIndex((req) => {
      const key = this.getRequestKey(req.gridKey, req.lodLevel);
      return priorityKeys.has(req.gridKey) && !inFlight.has(key);
    });

    if (index !== -1) {
      const request = this.queue.splice(index, 1)[0];
      const key = this.getRequestKey(request.gridKey, request.lodLevel);
      this.queuedSet.delete(key);
      return request;
    }
    return undefined;
  }

  /**
   * Remove and return the first request that is not already in flight.
   */
  shiftAny(inFlight: Set<string>): QueuedRequest | undefined {
    const index = this.queue.findIndex((req) => {
      const key = this.getRequestKey(req.gridKey, req.lodLevel);
      return !inFlight.has(key);
    });

    if (index !== -1) {
      const request = this.queue.splice(index, 1)[0];
      const key = this.getRequestKey(request.gridKey, request.lodLevel);
      this.queuedSet.delete(key);
      return request;
    }
    return undefined;
  }

  /**
   * Remove and return the highest priority request (first in queue).
   */
  shift(): QueuedRequest | undefined {
    const request = this.queue.shift();
    if (request) {
      const key = this.getRequestKey(request.gridKey, request.lodLevel);
      this.queuedSet.delete(key);
    }
    return request;
  }

  /**
   * Get the current queue length.
   */
  get length(): number {
    return this.queue.length;
  }

  /**
   * Clear all requests from the queue.
   */
  clear(): void {
    this.queue = [];
    this.queuedSet.clear();
  }
}
