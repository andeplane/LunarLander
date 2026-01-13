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
  const indices: number[] = [];

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

      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  // Generate stitched edge triangles
  if (stepRatios.north > 1) {
    generateStitchedEdge(indices, resolution, 'north', stepRatios.north, stepRatios);
  }
  if (stepRatios.south > 1) {
    generateStitchedEdge(indices, resolution, 'south', stepRatios.south, stepRatios);
  }
  if (stepRatios.west > 1) {
    generateStitchedEdge(indices, resolution, 'west', stepRatios.west, stepRatios);
  }
  if (stepRatios.east > 1) {
    generateStitchedEdge(indices, resolution, 'east', stepRatios.east, stepRatios);
  }

  return new Uint32Array(indices);
}

/**
 * Generate stitched triangles for one edge.
 * Creates fan triangles connecting interior row to snapped edge vertices.
 */
function generateStitchedEdge(
  indices: number[],
  resolution: number,
  edge: CardinalDirection,
  stepRatio: number,
  allStepRatios: Record<CardinalDirection, number>
): void {
  // For each "snapped" segment on the edge
  for (let i = 0; i < resolution; i += stepRatio) {
    const nextI = Math.min(i + stepRatio, resolution);
    
    switch (edge) {
      case 'north':
        generateNorthEdgeFan(indices, resolution, i, nextI, stepRatio, allStepRatios);
        break;
      case 'south':
        generateSouthEdgeFan(indices, resolution, i, nextI, stepRatio, allStepRatios);
        break;
      case 'west':
        generateWestEdgeFan(indices, resolution, i, nextI, stepRatio, allStepRatios);
        break;
      case 'east':
        generateEastEdgeFan(indices, resolution, i, nextI, stepRatio, allStepRatios);
        break;
    }
  }
}

/**
 * Generate fan triangles for north edge (z=0)
 * Connects edge vertices at z=0 to interior vertices at z=1
 */
function generateNorthEdgeFan(
  indices: number[],
  resolution: number,
  startX: number,
  endX: number,
  _stepRatio: number,
  _allStepRatios: Record<CardinalDirection, number>
): void {
  // Edge vertices (at z=0): startX and endX are the "snapped" vertices
  const edgeLeft = getVertexIndex(startX, 0, resolution);
  const edgeRight = getVertexIndex(endX, 0, resolution);
  
  // Create fan from interior row (z=1) to the two edge vertices
  for (let x = startX; x < endX; x++) {
    const interiorLeft = getVertexIndex(x, 1, resolution);
    const interiorRight = getVertexIndex(x + 1, 1, resolution);
    
    if (x === startX) {
      // First triangle connects to left edge vertex
      indices.push(edgeLeft, interiorLeft, interiorRight);
    }
    
    if (x === endX - 1) {
      // Last triangle connects to right edge vertex
      indices.push(interiorLeft, interiorRight, edgeRight);
      // Also need triangle from left to right edge through last interior
      if (endX - startX > 1) {
        indices.push(edgeLeft, interiorRight, edgeRight);
      }
    } else if (x > startX) {
      // Middle triangles connect interior vertices to left edge
      indices.push(edgeLeft, interiorLeft, interiorRight);
    }
  }
  
  // If step is exactly 1 cell, simpler case
  if (endX - startX === 1) {
    // Already handled above, but need to add the quad completion
    const interiorRight = getVertexIndex(endX, 1, resolution);
    indices.push(edgeLeft, interiorRight, edgeRight);
  }
}

/**
 * Generate fan triangles for south edge (z=resolution)
 */
function generateSouthEdgeFan(
  indices: number[],
  resolution: number,
  startX: number,
  endX: number,
  _stepRatio: number,
  _allStepRatios: Record<CardinalDirection, number>
): void {
  const edgeLeft = getVertexIndex(startX, resolution, resolution);
  const edgeRight = getVertexIndex(endX, resolution, resolution);
  
  for (let x = startX; x < endX; x++) {
    const interiorLeft = getVertexIndex(x, resolution - 1, resolution);
    const interiorRight = getVertexIndex(x + 1, resolution - 1, resolution);
    
    if (x === startX) {
      indices.push(interiorLeft, edgeLeft, interiorRight);
    }
    
    if (x === endX - 1) {
      indices.push(interiorRight, edgeLeft, edgeRight);
      if (endX - startX > 1) {
        indices.push(interiorLeft, edgeRight, interiorRight);
      }
    } else if (x > startX) {
      indices.push(interiorLeft, edgeLeft, interiorRight);
    }
  }
  
  if (endX - startX === 1) {
    const interiorRight = getVertexIndex(endX, resolution - 1, resolution);
    indices.push(interiorRight, edgeLeft, edgeRight);
  }
}

/**
 * Generate fan triangles for west edge (x=0)
 */
function generateWestEdgeFan(
  indices: number[],
  resolution: number,
  startZ: number,
  endZ: number,
  _stepRatio: number,
  _allStepRatios: Record<CardinalDirection, number>
): void {
  const edgeTop = getVertexIndex(0, startZ, resolution);
  const edgeBottom = getVertexIndex(0, endZ, resolution);
  
  for (let z = startZ; z < endZ; z++) {
    const interiorTop = getVertexIndex(1, z, resolution);
    const interiorBottom = getVertexIndex(1, z + 1, resolution);
    
    if (z === startZ) {
      indices.push(edgeTop, interiorBottom, interiorTop);
    }
    
    if (z === endZ - 1) {
      indices.push(edgeTop, edgeBottom, interiorBottom);
      if (endZ - startZ > 1) {
        indices.push(interiorTop, interiorBottom, edgeBottom);
      }
    } else if (z > startZ) {
      indices.push(edgeTop, interiorBottom, interiorTop);
    }
  }
  
  if (endZ - startZ === 1) {
    const interiorBottom = getVertexIndex(1, endZ, resolution);
    indices.push(edgeTop, edgeBottom, interiorBottom);
  }
}

/**
 * Generate fan triangles for east edge (x=resolution)
 */
function generateEastEdgeFan(
  indices: number[],
  resolution: number,
  startZ: number,
  endZ: number,
  _stepRatio: number,
  _allStepRatios: Record<CardinalDirection, number>
): void {
  const edgeTop = getVertexIndex(resolution, startZ, resolution);
  const edgeBottom = getVertexIndex(resolution, endZ, resolution);
  
  for (let z = startZ; z < endZ; z++) {
    const interiorTop = getVertexIndex(resolution - 1, z, resolution);
    const interiorBottom = getVertexIndex(resolution - 1, z + 1, resolution);
    
    if (z === startZ) {
      indices.push(edgeTop, interiorTop, interiorBottom);
    }
    
    if (z === endZ - 1) {
      indices.push(edgeTop, interiorBottom, edgeBottom);
      if (endZ - startZ > 1) {
        indices.push(interiorTop, edgeBottom, interiorBottom);
      }
    } else if (z > startZ) {
      indices.push(edgeTop, interiorTop, interiorBottom);
    }
  }
  
  if (endZ - startZ === 1) {
    const interiorBottom = getVertexIndex(resolution - 1, endZ, resolution);
    indices.push(edgeTop, interiorBottom, edgeBottom);
  }
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
