/**
 * Pure utility functions for LOD (Level of Detail) calculations
 */

/**
 * Cardinal directions for neighbor chunks
 */
export type CardinalDirection = 'north' | 'south' | 'east' | 'west';

/**
 * Neighbor LOD levels for edge stitching
 */
export interface NeighborLods {
  north: number;
  south: number;
  east: number;
  west: number;
}

/**
 * Get the LOD level index for a given distance from camera.
 * Returns the index into lodLevels array (0 = highest detail).
 * 
 * @param distance - Distance from camera in world units
 * @param lodDistances - Array of distance thresholds, e.g. [0, 100, 200, 400]
 * @returns LOD level index (0 to lodDistances.length - 1)
 */
export function getLodLevelForDistance(
  distance: number,
  lodDistances: readonly number[]
): number {
  if (lodDistances.length === 0) {
    return 0;
  }

  // Find the highest LOD level where distance >= threshold
  for (let i = lodDistances.length - 1; i >= 0; i--) {
    if (distance >= lodDistances[i]) {
      return i;
    }
  }

  return 0;
}

/**
 * Get the resolution for a given LOD level index.
 * 
 * @param lodIndex - Index into lodLevels array
 * @param lodLevels - Array of resolutions, e.g. [512, 256, 128, 64]
 * @returns Resolution value, or highest resolution if index invalid
 */
export function getResolutionForLodLevel(
  lodIndex: number,
  lodLevels: readonly number[]
): number {
  if (lodLevels.length === 0) {
    return 512; // Default fallback
  }

  if (lodIndex < 0) {
    return lodLevels[0];
  }

  if (lodIndex >= lodLevels.length) {
    return lodLevels[lodLevels.length - 1];
  }

  return lodLevels[lodIndex];
}

/**
 * Get grid keys for the four cardinal neighbors of a chunk.
 * 
 * @param gridX - Chunk grid X coordinate
 * @param gridZ - Chunk grid Z coordinate
 * @returns Object with neighbor keys for each direction
 */
export function getNeighborKeys(
  gridX: number,
  gridZ: number
): Record<CardinalDirection, string> {
  return {
    north: `${gridX},${gridZ - 1}`,
    south: `${gridX},${gridZ + 1}`,
    east: `${gridX + 1},${gridZ}`,
    west: `${gridX - 1},${gridZ}`,
  };
}

/**
 * Parse a grid key string into coordinates.
 * 
 * @param gridKey - Grid key in format "x,z"
 * @returns Tuple of [gridX, gridZ]
 */
export function parseGridKey(gridKey: string): [number, number] {
  const [x, z] = gridKey.split(',').map(Number);
  return [x, z];
}

/**
 * Create a grid key from coordinates.
 * 
 * @param gridX - Chunk grid X coordinate
 * @param gridZ - Chunk grid Z coordinate
 * @returns Grid key string
 */
export function createGridKey(gridX: number, gridZ: number): string {
  return `${gridX},${gridZ}`;
}

/**
 * Calculate the world-space center position of a chunk.
 * 
 * @param gridX - Chunk grid X coordinate
 * @param gridZ - Chunk grid Z coordinate
 * @param chunkWidth - Width of each chunk in world units
 * @param chunkDepth - Depth of each chunk in world units
 * @returns Object with x, z world coordinates
 */
export function getChunkWorldCenter(
  gridX: number,
  gridZ: number,
  chunkWidth: number,
  chunkDepth: number
): { x: number; z: number } {
  return {
    x: gridX * chunkWidth + chunkWidth / 2,
    z: gridZ * chunkDepth + chunkDepth / 2,
  };
}

/**
 * Calculate distance from a point to the nearest point on a chunk rectangle.
 * Chunks are assumed to be flat at Y=0.
 * 
 * @param pointX - Point X coordinate
 * @param pointY - Point Y coordinate (height)
 * @param pointZ - Point Z coordinate
 * @param gridX - Chunk grid X coordinate
 * @param gridZ - Chunk grid Z coordinate
 * @param chunkWidth - Width of each chunk
 * @param chunkDepth - Depth of each chunk
 * @returns Distance in world units to nearest point on chunk
 */
export function getDistanceToChunk(
  pointX: number,
  pointY: number,
  pointZ: number,
  gridX: number,
  gridZ: number,
  chunkWidth: number,
  chunkDepth: number
): number {
  // Calculate chunk bounds in world space
  const minX = gridX * chunkWidth;
  const maxX = (gridX + 1) * chunkWidth;
  const minZ = gridZ * chunkDepth;
  const maxZ = (gridZ + 1) * chunkDepth;
  
  // Clamp camera position to chunk bounds to find nearest point on chunk
  const nearestX = Math.max(minX, Math.min(maxX, pointX));
  const nearestZ = Math.max(minZ, Math.min(maxZ, pointZ));
  const nearestY = 0; // Chunks are flat at Y=0
  
  // Calculate 3D distance from camera to nearest point on chunk
  const dx = pointX - nearestX;
  const dy = pointY - nearestY;
  const dz = pointZ - nearestZ;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ============================================================================
// Screen-space LOD selection
// ============================================================================

/**
 * Default terrain tilt angle for screen-space projection (15 degrees in radians)
 */
const DEFAULT_TERRAIN_TILT_RADIANS = Math.PI / 12;

/**
 * Target screen-space triangle size for LOD selection.
 * Lower values = more detail, higher values = better performance.
 */
export enum LodDetailLevel {
  /** Maximum detail - ~1 pixel triangles */
  Maximum = 1,
  /** High detail - ~2 pixel triangles */
  High = 2,
  /** Balanced detail/performance - ~4 pixel triangles */
  Balanced = 4,
  /** Performance focused - ~8 pixel triangles */
  Performance = 8,
}

/**
 * Calculate triangle edge length for a given LOD resolution.
 * For a grid with `resolution` vertices over `chunkWidth`, each triangle
 * edge spans chunkWidth / (resolution - 1).
 * 
 * @param resolution - Number of vertices per edge (e.g., 512, 256, 128, 64)
 * @param chunkWidth - Width of the chunk in world units
 * @returns Triangle edge length in world units
 */
export function getTriangleEdgeLength(
  resolution: number,
  chunkWidth: number
): number {
  if (resolution <= 1) {
    return chunkWidth;
  }
  return chunkWidth / (resolution - 1);
}

/**
 * Calculate screen-space size of a world-space length at a given distance.
 * Uses perspective projection with optional terrain tilt factor.
 * 
 * @param worldSize - Size in world units
 * @param distance - Distance from camera in world units
 * @param fovRadians - Camera field of view in radians
 * @param screenHeight - Screen height in pixels
 * @param tiltAngleRadians - Terrain tilt angle (default 15°)
 * @returns Size in screen pixels
 */
export function projectToScreenSpace(
  worldSize: number,
  distance: number,
  fovRadians: number,
  screenHeight: number,
  tiltAngleRadians: number = DEFAULT_TERRAIN_TILT_RADIANS
): number {
  if (distance <= 0) {
    return screenHeight; // Very close = full screen
  }
  const tanHalfFov = Math.tan(fovRadians / 2);
  return (worldSize * screenHeight * Math.cos(tiltAngleRadians)) /
         (2 * distance * tanHalfFov);
}

/**
 * Get LOD level based on screen-space triangle size.
 * Traditional LOD: finest detail when close, coarser when far.
 * Uses screen-space calculation to determine when triangles are "good enough".
 * 
 * @param distance - Distance from camera in world units
 * @param lodLevels - Array of resolutions (highest to lowest, e.g., [512, 256, 128, 64])
 * @param chunkWidth - Width of chunk in world units
 * @param fovRadians - Camera FOV in radians
 * @param screenHeight - Screen height in pixels
 * @param targetPixels - Target minimum triangle size (from LodDetailLevel)
 * @returns LOD level index (0 = highest detail)
 */
export function getLodLevelForScreenSize(
  distance: number,
  lodLevels: readonly number[],
  chunkWidth: number,
  fovRadians: number,
  screenHeight: number,
  targetPixels: LodDetailLevel
): number {
  if (lodLevels.length === 0) {
    return 0;
  }

  // Traditional LOD: use finest detail when close, coarser when far
  // Iterate from finest (0) to coarsest, return finest where triangles >= target
  for (let i = 0; i < lodLevels.length; i++) {
    const edgeLength = getTriangleEdgeLength(lodLevels[i], chunkWidth);
    const screenSize = projectToScreenSpace(edgeLength, distance, fovRadians, screenHeight);
    if (screenSize >= targetPixels) {
      return i;
    }
  }

  // At far distances, no LOD meets target - use coarsest (saves triangles)
  return lodLevels.length - 1;
}
