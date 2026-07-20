/**
 * Edge stitching utility for LOD terrain
 * 
 * When adjacent chunks have different LOD levels, gaps can appear at the edges.
 * This module modifies the index buffer of higher-resolution chunks to "drop" 
 * vertices along edges to match the lower-resolution neighbor.
 * 
 * Example: If chunk A (512 res) borders chunk B (128 res):
 * - A has vertices every (width/512) units
 * - B has vertices every (width/128) units = 4x spacing
 * - We modify A's triangles along that edge to skip 3 out of every 4 vertices
 */

import type { NeighborLods, CardinalDirection } from './LodUtils';

// Simple LRU cache for stitched indices
const stitchCache: Map<string, Uint32Array> = new Map();
const MAX_CACHE_SIZE = 256;

/**
 * Generate a cache key for a specific stitching configuration
 */
function getCacheKey(
  resolution: number,
  neighborLods: NeighborLods,
  myLodLevel: number
): string {
  return `${resolution}:${myLodLevel}:${neighborLods.north}:${neighborLods.south}:${neighborLods.east}:${neighborLods.west}`;
}

/**
 * Calculate the step ratio between two LOD levels.
 * Returns how many vertices to skip on the higher-res side.
 * 
 * @param myResolution - Resolution of this chunk
 * @param neighborResolution - Resolution of the neighbor chunk
 * @returns Step ratio (1 = same, 2 = skip every other, 4 = skip 3 of 4, etc.)
 */
export function calculateStepRatio(
  myResolution: number,
  neighborResolution: number
): number {
  if (neighborResolution >= myResolution || neighborResolution <= 0) {
    return 1; // No stitching needed - neighbor is same or higher resolution
  }
  return Math.round(myResolution / neighborResolution);
}

/**
 * Get the resolution for a given LOD level
 */
export function getResolutionForLevel(
  lodLevel: number,
  lodLevels: readonly number[]
): number {
  if (lodLevel < 0 || lodLevel >= lodLevels.length) {
    return lodLevels[0] ?? 512;
  }
  return lodLevels[lodLevel];
}

/**
 * Get vertex index in the grid for position (x, z)
 * PlaneGeometry generates vertices row by row (x varies fastest)
 * 
 * @param x - Column index (0 to resolution)
 * @param z - Row index (0 to resolution)
 * @param resolution - Number of segments (vertices = resolution + 1)
 */
export function getVertexIndex(x: number, z: number, resolution: number): number {
  const verticesPerRow = resolution + 1;
  return z * verticesPerRow + x;
}

/**
 * Generate standard grid indices for a PlaneGeometry
 * This creates two triangles per cell in the grid.
 * 
 * @param resolution - Number of segments per side
 * @returns Uint32Array of triangle indices
 */
export function generateGridIndices(resolution: number): Uint32Array {
  const triangleCount = resolution * resolution * 2;
  const indices = new Uint32Array(triangleCount * 3);
  
  let idx = 0;
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const a = getVertexIndex(x, z, resolution);
      const b = getVertexIndex(x + 1, z, resolution);
      const c = getVertexIndex(x, z + 1, resolution);
      const d = getVertexIndex(x + 1, z + 1, resolution);

      // Two triangles per quad
      // Triangle 1: a, c, b
      indices[idx++] = a;
      indices[idx++] = c;
      indices[idx++] = b;
      
      // Triangle 2: b, c, d
      indices[idx++] = b;
      indices[idx++] = c;
      indices[idx++] = d;
    }
  }

  return indices;
}

/**
 * Check if a vertex is on a specific edge of the grid
 */
export function isOnEdge(
  x: number,
  z: number,
  resolution: number,
  edge: CardinalDirection
): boolean {
  switch (edge) {
    case 'north': return z === 0;
    case 'south': return z === resolution;
    case 'west': return x === 0;
    case 'east': return x === resolution;
  }
}

/**
 * Compute stitched indices for a chunk that needs to match lower-resolution neighbors.
 * 
 * The strategy is:
 * 1. Generate standard grid indices
 * 2. For each edge where neighbor has lower LOD:
 *    - Rebuild triangles along that edge to use fewer vertices
 *    - Creates "fan" triangles from interior to snapped edge vertices
 * 
 * @param resolution - Number of segments per side (e.g., 512)
 * @param neighborLods - LOD levels of cardinal neighbors
 * @param myLodLevel - This chunk's LOD level
 * @param lodLevels - Array mapping LOD level to resolution
 * @returns Uint32Array of stitched triangle indices
 */
export function computeStitchedIndices(
  resolution: number,
  neighborLods: NeighborLods,
  myLodLevel: number,
  lodLevels: readonly number[]
): Uint32Array {
  // Check cache first
  const cacheKey = getCacheKey(resolution, neighborLods, myLodLevel);
  const cached = stitchCache.get(cacheKey);
  if (cached) {
    // Refresh recency so the cache behaves as LRU rather than FIFO
    stitchCache.delete(cacheKey);
    stitchCache.set(cacheKey, cached);
    return cached;
  }

  const myResolution = getResolutionForLevel(myLodLevel, lodLevels);
  
  // Calculate step ratios for each edge
  const stepRatios: Record<CardinalDirection, number> = {
    north: calculateStepRatio(myResolution, getResolutionForLevel(neighborLods.north, lodLevels)),
    south: calculateStepRatio(myResolution, getResolutionForLevel(neighborLods.south, lodLevels)),
    east: calculateStepRatio(myResolution, getResolutionForLevel(neighborLods.east, lodLevels)),
    west: calculateStepRatio(myResolution, getResolutionForLevel(neighborLods.west, lodLevels)),
  };

  // If no stitching needed (all neighbors same or higher res), return standard indices
  if (stepRatios.north === 1 && stepRatios.south === 1 && 
      stepRatios.east === 1 && stepRatios.west === 1) {
    const standardIndices = generateGridIndices(resolution);
    cacheToMap(cacheKey, standardIndices);
    return standardIndices;
  }

  // Build indices with edge stitching
  const indices = buildStitchedIndices(resolution, stepRatios);
  
  // Cache the result
  cacheToMap(cacheKey, indices);
  
  return indices;
}

/**
 * Build index buffer with stitched edges.
 * 
 * For edges that need stitching, we:
 * 1. Skip the edge cells in the standard grid generation
 * 2. Create "fan" triangles that connect interior vertices to snapped edge vertices
 */
function buildStitchedIndices(
  resolution: number,
  stepRatios: Record<CardinalDirection, number>
): Uint32Array {
  // Fill a Uint32Array directly instead of growing a number[] (which is
  // multi-MB at high resolutions). Upper bound: full interior grid plus up to
  // 2 triangles per segment on each of the 4 stitched edges, plus up to
  // 2 corner-gap triangles per stitched edge (one at each end).
  const maxTriangles = resolution * resolution * 2 + (resolution * 2 + 2) * 4;
  const indices = new Uint32Array(maxTriangles * 3);
  let cursor = 0;

  // Generate interior quads (not touching any edge that needs stitching)
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const touchesNorth = z === 0 && stepRatios.north > 1;
      const touchesSouth = z === resolution - 1 && stepRatios.south > 1;
      const touchesWest = x === 0 && stepRatios.west > 1;
      const touchesEast = x === resolution - 1 && stepRatios.east > 1;

      if (touchesNorth || touchesSouth || touchesWest || touchesEast) {
        // Skip - will be handled by edge stitching
        continue;
      }

      // Standard quad (two triangles)
      const a = getVertexIndex(x, z, resolution);
      const b = getVertexIndex(x + 1, z, resolution);
      const c = getVertexIndex(x, z + 1, resolution);
      const d = getVertexIndex(x + 1, z + 1, resolution);

      indices[cursor++] = a;
      indices[cursor++] = c;
      indices[cursor++] = b;
      indices[cursor++] = b;
      indices[cursor++] = c;
      indices[cursor++] = d;
    }
  }

  // Generate stitched edge triangles. Where two stitched edges meet at a
  // corner, each fan excludes its corner segment (see CornerExclusions) so the
  // corner cell is covered exactly once and no unsnapped vertex on the
  // perpendicular boundary is referenced.
  const stitchNorth = stepRatios.north > 1;
  const stitchSouth = stepRatios.south > 1;
  const stitchWest = stepRatios.west > 1;
  const stitchEast = stepRatios.east > 1;

  if (stitchNorth) {
    cursor = generateStitchedEdge(indices, cursor, resolution, 'north', stepRatios.north, {
      excludeStart: stitchWest,
      excludeEnd: stitchEast,
    });
  }
  if (stitchSouth) {
    cursor = generateStitchedEdge(indices, cursor, resolution, 'south', stepRatios.south, {
      excludeStart: stitchWest,
      excludeEnd: stitchEast,
    });
  }
  if (stitchWest) {
    cursor = generateStitchedEdge(indices, cursor, resolution, 'west', stepRatios.west, {
      excludeStart: stitchNorth,
      excludeEnd: stitchSouth,
    });
  }
  if (stitchEast) {
    cursor = generateStitchedEdge(indices, cursor, resolution, 'east', stepRatios.east, {
      excludeStart: stitchNorth,
      excludeEnd: stitchSouth,
    });
  }

  return indices.slice(0, cursor);
}

/**
 * Get the nearest snapped position for a given coordinate.
 * Snaps to the nearest multiple of stepRatio.
 * 
 * @param pos - Position coordinate (0 to resolution)
 * @param stepRatio - Step ratio for snapping
 * @returns Nearest snapped position
 */
function getNearestSnappedPosition(pos: number, stepRatio: number): number {
  return Math.round(pos / stepRatio) * stepRatio;
}

/**
 * Corner-ownership exclusions for an edge fan.
 *
 * When the perpendicular edge at an end of this edge is also stitched, the
 * corner cell must not be triangulated by both fans (that would double-cover
 * it with non-coplanar triangles and pin unsnapped vertices on the
 * perpendicular boundary, creating T-junctions). Instead each fan stops at the
 * corner cell's diagonal (e.g. (0,0)-(1,1) at the north-west corner): it skips
 * its corner segment and, where nearest-neighbor snapping does not already
 * anchor the fan at the corner boundary vertex, emits a dedicated corner
 * triangle using only snapped boundary vertices plus the shared interior
 * corner vertex. The two fans meeting at a corner then tile exactly their
 * halves of the corner cell, sharing the diagonal edge.
 */
interface CornerExclusions {
  /** Perpendicular edge at the fan's start (x=0 or z=0 end) is also stitched */
  excludeStart: boolean;
  /** Perpendicular edge at the fan's end (x=resolution or z=resolution end) is also stitched */
  excludeEnd: boolean;
}

/**
 * Generate stitched triangles for one edge.
 * Creates triangles connecting interior row to nearest snapped edge vertices.
 * Writes into `indices` starting at `cursor` and returns the new cursor.
 */
function generateStitchedEdge(
  indices: Uint32Array,
  cursor: number,
  resolution: number,
  edge: CardinalDirection,
  stepRatio: number,
  corners: CornerExclusions
): number {
  switch (edge) {
    case 'north':
      return generateNorthEdgeNearestNeighbor(indices, cursor, resolution, stepRatio, corners);
    case 'south':
      return generateSouthEdgeNearestNeighbor(indices, cursor, resolution, stepRatio, corners);
    case 'west':
      return generateWestEdgeNearestNeighbor(indices, cursor, resolution, stepRatio, corners);
    case 'east':
      return generateEastEdgeNearestNeighbor(indices, cursor, resolution, stepRatio, corners);
  }
}

/**
 * Generate triangles for north edge (z=0) using nearest-neighbor snapping.
 * Each interior vertex connects to the nearest snapped edge vertex.
 */
function generateNorthEdgeNearestNeighbor(
  indices: Uint32Array,
  startCursor: number,
  resolution: number,
  stepRatio: number,
  corners: CornerExclusions
): number {
  let cursor = startCursor;

  if (corners.excludeStart) {
    // North-west corner: cover the gap between the corner cell diagonal
    // (0,0)-(1,1) and the fan's first snapped anchor, if any (stepRatio 2).
    const snap = getNearestSnappedPosition(1, stepRatio);
    if (snap !== 0) {
      indices[cursor++] = getVertexIndex(0, 0, resolution);
      indices[cursor++] = getVertexIndex(1, 1, resolution);
      indices[cursor++] = getVertexIndex(snap, 0, resolution);
    }
  }
  if (corners.excludeEnd) {
    // North-east corner: cover the gap between the fan's last snapped anchor
    // and the corner cell diagonal (resolution-1,1)-(resolution,0), if any.
    const snap = getNearestSnappedPosition(resolution - 1, stepRatio);
    if (snap !== resolution) {
      indices[cursor++] = getVertexIndex(snap, 0, resolution);
      indices[cursor++] = getVertexIndex(resolution - 1, 1, resolution);
      indices[cursor++] = getVertexIndex(resolution, 0, resolution);
    }
  }

  const startX = corners.excludeStart ? 1 : 0;
  const endX = corners.excludeEnd ? resolution - 1 : resolution;
  // Process each interior edge segment (x, x+1)
  for (let x = startX; x < endX; x++) {
    const interiorLeft = getVertexIndex(x, 1, resolution);
    const interiorRight = getVertexIndex(x + 1, 1, resolution);

    // Find nearest snapped edge vertices
    const snapLeft = getNearestSnappedPosition(x, stepRatio);
    const snapRight = getNearestSnappedPosition(x + 1, stepRatio);

    const edgeLeft = getVertexIndex(snapLeft, 0, resolution);
    const edgeRight = getVertexIndex(snapRight, 0, resolution);

    if (snapLeft === snapRight) {
      // Both interior vertices snap to the same edge vertex - one triangle
      indices[cursor++] = edgeLeft;
      indices[cursor++] = interiorLeft;
      indices[cursor++] = interiorRight;
    } else {
      // Transition point - two triangles
      // Triangle 1: edgeLeft to interiorLeft to interiorRight (CCW)
      indices[cursor++] = edgeLeft;
      indices[cursor++] = interiorLeft;
      indices[cursor++] = interiorRight;
      // Triangle 2: edgeLeft to interiorRight to edgeRight (CCW)
      indices[cursor++] = edgeLeft;
      indices[cursor++] = interiorRight;
      indices[cursor++] = edgeRight;
    }
  }
  return cursor;
}

/**
 * Generate triangles for south edge (z=resolution) using nearest-neighbor snapping.
 * Each interior vertex connects to the nearest snapped edge vertex.
 * South edge needs reversed winding for CCW (interior is above edge).
 */
function generateSouthEdgeNearestNeighbor(
  indices: Uint32Array,
  startCursor: number,
  resolution: number,
  stepRatio: number,
  corners: CornerExclusions
): number {
  let cursor = startCursor;

  if (corners.excludeStart) {
    // South-west corner: cover the gap between the corner cell diagonal
    // (0,resolution)-(1,resolution-1) and the fan's first snapped anchor.
    const snap = getNearestSnappedPosition(1, stepRatio);
    if (snap !== 0) {
      indices[cursor++] = getVertexIndex(1, resolution - 1, resolution);
      indices[cursor++] = getVertexIndex(0, resolution, resolution);
      indices[cursor++] = getVertexIndex(snap, resolution, resolution);
    }
  }
  if (corners.excludeEnd) {
    // South-east corner: cover the gap between the fan's last snapped anchor
    // and the corner cell diagonal (resolution-1,resolution-1)-(resolution,resolution).
    const snap = getNearestSnappedPosition(resolution - 1, stepRatio);
    if (snap !== resolution) {
      indices[cursor++] = getVertexIndex(resolution - 1, resolution - 1, resolution);
      indices[cursor++] = getVertexIndex(snap, resolution, resolution);
      indices[cursor++] = getVertexIndex(resolution, resolution, resolution);
    }
  }

  const startX = corners.excludeStart ? 1 : 0;
  const endX = corners.excludeEnd ? resolution - 1 : resolution;
  // Process each interior edge segment (x, x+1)
  for (let x = startX; x < endX; x++) {
    const interiorLeft = getVertexIndex(x, resolution - 1, resolution);
    const interiorRight = getVertexIndex(x + 1, resolution - 1, resolution);

    // Find nearest snapped edge vertices
    const snapLeft = getNearestSnappedPosition(x, stepRatio);
    const snapRight = getNearestSnappedPosition(x + 1, stepRatio);

    const edgeLeft = getVertexIndex(snapLeft, resolution, resolution);
    const edgeRight = getVertexIndex(snapRight, resolution, resolution);

    if (snapLeft === snapRight) {
      // Both interior vertices snap to the same edge vertex - one triangle (CCW winding)
      indices[cursor++] = interiorLeft;
      indices[cursor++] = edgeLeft;
      indices[cursor++] = interiorRight;
    } else {
      // Transition point - two triangles (CCW winding)
      // Triangle 1: interiorLeft to edgeLeft to interiorRight
      indices[cursor++] = interiorLeft;
      indices[cursor++] = edgeLeft;
      indices[cursor++] = interiorRight;
      // Triangle 2: interiorRight to edgeLeft to edgeRight
      indices[cursor++] = interiorRight;
      indices[cursor++] = edgeLeft;
      indices[cursor++] = edgeRight;
    }
  }
  return cursor;
}

/**
 * Generate triangles for west edge (x=0) using nearest-neighbor snapping.
 * Each interior vertex connects to the nearest snapped edge vertex.
 */
function generateWestEdgeNearestNeighbor(
  indices: Uint32Array,
  startCursor: number,
  resolution: number,
  stepRatio: number,
  corners: CornerExclusions
): number {
  let cursor = startCursor;

  if (corners.excludeStart) {
    // North-west corner: cover the gap between the corner cell diagonal
    // (0,0)-(1,1) and the fan's first snapped anchor, if any (stepRatio 2).
    const snap = getNearestSnappedPosition(1, stepRatio);
    if (snap !== 0) {
      indices[cursor++] = getVertexIndex(0, 0, resolution);
      indices[cursor++] = getVertexIndex(0, snap, resolution);
      indices[cursor++] = getVertexIndex(1, 1, resolution);
    }
  }
  if (corners.excludeEnd) {
    // South-west corner: cover the gap between the fan's last snapped anchor
    // and the corner cell diagonal (1,resolution-1)-(0,resolution), if any.
    const snap = getNearestSnappedPosition(resolution - 1, stepRatio);
    if (snap !== resolution) {
      indices[cursor++] = getVertexIndex(0, snap, resolution);
      indices[cursor++] = getVertexIndex(0, resolution, resolution);
      indices[cursor++] = getVertexIndex(1, resolution - 1, resolution);
    }
  }

  const startZ = corners.excludeStart ? 1 : 0;
  const endZ = corners.excludeEnd ? resolution - 1 : resolution;
  // Process each interior edge segment (z, z+1)
  for (let z = startZ; z < endZ; z++) {
    const interiorTop = getVertexIndex(1, z, resolution);
    const interiorBottom = getVertexIndex(1, z + 1, resolution);

    // Find nearest snapped edge vertices
    const snapTop = getNearestSnappedPosition(z, stepRatio);
    const snapBottom = getNearestSnappedPosition(z + 1, stepRatio);

    const edgeTop = getVertexIndex(0, snapTop, resolution);
    const edgeBottom = getVertexIndex(0, snapBottom, resolution);

    if (snapTop === snapBottom) {
      // Both interior vertices snap to the same edge vertex - one triangle (CCW winding)
      indices[cursor++] = edgeTop;
      indices[cursor++] = interiorBottom;
      indices[cursor++] = interiorTop;
    } else {
      // Transition point - two triangles (CCW winding)
      // Triangle 1: edgeTop to interiorBottom to interiorTop
      indices[cursor++] = edgeTop;
      indices[cursor++] = interiorBottom;
      indices[cursor++] = interiorTop;
      // Triangle 2: edgeTop to edgeBottom to interiorBottom
      indices[cursor++] = edgeTop;
      indices[cursor++] = edgeBottom;
      indices[cursor++] = interiorBottom;
    }
  }
  return cursor;
}

/**
 * Generate triangles for east edge (x=resolution) using nearest-neighbor snapping.
 * Each interior vertex connects to the nearest snapped edge vertex.
 */
function generateEastEdgeNearestNeighbor(
  indices: Uint32Array,
  startCursor: number,
  resolution: number,
  stepRatio: number,
  corners: CornerExclusions
): number {
  let cursor = startCursor;

  if (corners.excludeStart) {
    // North-east corner: cover the gap between the corner cell diagonal
    // (resolution,0)-(resolution-1,1) and the fan's first snapped anchor.
    const snap = getNearestSnappedPosition(1, stepRatio);
    if (snap !== 0) {
      indices[cursor++] = getVertexIndex(resolution, 0, resolution);
      indices[cursor++] = getVertexIndex(resolution - 1, 1, resolution);
      indices[cursor++] = getVertexIndex(resolution, snap, resolution);
    }
  }
  if (corners.excludeEnd) {
    // South-east corner: cover the gap between the fan's last snapped anchor
    // and the corner cell diagonal (resolution-1,resolution-1)-(resolution,resolution).
    const snap = getNearestSnappedPosition(resolution - 1, stepRatio);
    if (snap !== resolution) {
      indices[cursor++] = getVertexIndex(resolution, snap, resolution);
      indices[cursor++] = getVertexIndex(resolution - 1, resolution - 1, resolution);
      indices[cursor++] = getVertexIndex(resolution, resolution, resolution);
    }
  }

  const startZ = corners.excludeStart ? 1 : 0;
  const endZ = corners.excludeEnd ? resolution - 1 : resolution;
  // Process each interior edge segment (z, z+1)
  for (let z = startZ; z < endZ; z++) {
    const interiorTop = getVertexIndex(resolution - 1, z, resolution);
    const interiorBottom = getVertexIndex(resolution - 1, z + 1, resolution);

    // Find nearest snapped edge vertices
    const snapTop = getNearestSnappedPosition(z, stepRatio);
    const snapBottom = getNearestSnappedPosition(z + 1, stepRatio);

    const edgeTop = getVertexIndex(resolution, snapTop, resolution);
    const edgeBottom = getVertexIndex(resolution, snapBottom, resolution);

    if (snapTop === snapBottom) {
      // Both interior vertices snap to the same edge vertex - one triangle (CCW winding)
      indices[cursor++] = edgeTop;
      indices[cursor++] = interiorTop;
      indices[cursor++] = interiorBottom;
    } else {
      // Transition point - two triangles (CCW winding)
      // Triangle 1: edgeTop to interiorTop to interiorBottom
      indices[cursor++] = edgeTop;
      indices[cursor++] = interiorTop;
      indices[cursor++] = interiorBottom;
      // Triangle 2: edgeTop to interiorBottom to edgeBottom
      indices[cursor++] = edgeTop;
      indices[cursor++] = interiorBottom;
      indices[cursor++] = edgeBottom;
    }
  }
  return cursor;
}

/**
 * Add to cache with LRU eviction
 */
function cacheToMap(key: string, indices: Uint32Array): void {
  if (stitchCache.size >= MAX_CACHE_SIZE) {
    // Remove oldest entry (first key in Map)
    const firstKey = stitchCache.keys().next().value;
    if (firstKey) {
      stitchCache.delete(firstKey);
    }
  }
  stitchCache.set(key, indices);
}

/**
 * Clear the stitch cache (useful for testing)
 */
export function clearStitchCache(): void {
  stitchCache.clear();
}

/**
 * Get the current cache size (useful for testing/debugging)
 */
export function getStitchCacheSize(): number {
  return stitchCache.size;
}
