/**
 * Pure mesh generation functions
 * Used by ChunkMeshWorker - kept separate so they can be unit tested
 */

import { createNoise2D } from 'simplex-noise';
import type { NeighborLODs } from '../types';

// LOD level resolutions - must match LOD_LEVELS in types/index.ts
export const LOD_RESOLUTIONS = [2, 4, 7, 9, 17];

/**
 * Get resolution for a given LOD level
 */
export function getResolutionForLOD(lodLevel: number): number {
  return LOD_RESOLUTIONS[lodLevel] ?? LOD_RESOLUTIONS[0];
}

/**
 * Generated mesh data
 */
export interface MeshData {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Calculate vertex count for a resolution
 */
export function calculateVertexCount(resolution: number): number {
  return resolution * resolution;
}

/**
 * Calculate index count for a resolution
 */
export function calculateIndexCount(resolution: number): number {
  const quadCount = (resolution - 1) * (resolution - 1);
  return quadCount * 6;
}

/**
 * Calculate triangle count for a resolution
 */
export function calculateTriangleCount(resolution: number): number {
  const quadCount = (resolution - 1) * (resolution - 1);
  return quadCount * 2;
}

// ============================================
// Noise-based terrain generation
// ============================================

// Terrain seed - deterministic for consistent terrain
const TERRAIN_SEED = 12345;

// Create seeded PRNG for noise initialization
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

// Initialize noise function with seed
const noise2D = createNoise2D(seededRandom(TERRAIN_SEED));

/**
 * Terrain layer configuration
 * Each layer adds detail at different scales
 */
interface TerrainLayer {
  amplitude: number;    // Height contribution in meters
  wavelength: number;   // Horizontal scale in meters
  minLOD: number;       // Minimum LOD level to include this layer
}

/**
 * Terrain layers from large-scale to fine detail
 * Realistic lunar scales for a 64m chunk system
 */
const TERRAIN_LAYERS: TerrainLayer[] = [
  // Large-scale: highlands/maria variation
  { amplitude: 800, wavelength: 15000, minLOD: 0 },
  { amplitude: 400, wavelength: 8000, minLOD: 0 },
  
  // Medium-scale: hills and ridges
  { amplitude: 60, wavelength: 1500, minLOD: 0 },
  { amplitude: 30, wavelength: 600, minLOD: 1 },
  
  // Small-scale: rocks and surface roughness  
  { amplitude: 8, wavelength: 80, minLOD: 2 },
  { amplitude: 4, wavelength: 30, minLOD: 3 },
  
  // Fine detail: regolith texture (high LOD only)
  { amplitude: 0.3, wavelength: 4, minLOD: 4 },
  { amplitude: 0.1, wavelength: 1, minLOD: 4 },
];

/**
 * Get terrain height at world position with LOD-aware detail
 * @param x World X coordinate (meters)
 * @param z World Z coordinate (meters)
 * @param lodLevel LOD level (0-4), higher = more detail
 * @returns Height in meters
 */
export function getTerrainHeight(x: number, z: number, lodLevel: number): number {
  let height = 0;
  
  for (const layer of TERRAIN_LAYERS) {
    // Skip layers that require higher LOD than we have
    if (lodLevel < layer.minLOD) {
      continue;
    }
    
    // Sample noise at this layer's scale
    const nx = x / layer.wavelength;
    const nz = z / layer.wavelength;
    const noiseValue = noise2D(nx, nz); // Returns [-1, 1]
    
    height += noiseValue * layer.amplitude;
  }
  
  return height;
}

/**
 * Compute normal at a world position using central differences
 * Samples neighboring heights to determine surface slope
 */
function computeNormal(
  worldX: number,
  worldZ: number,
  lodLevel: number,
  sampleDistance: number
): [number, number, number] {
  // Sample heights at neighboring points
  const hL = getTerrainHeight(worldX - sampleDistance, worldZ, lodLevel);
  const hR = getTerrainHeight(worldX + sampleDistance, worldZ, lodLevel);
  const hD = getTerrainHeight(worldX, worldZ - sampleDistance, lodLevel);
  const hU = getTerrainHeight(worldX, worldZ + sampleDistance, lodLevel);
  
  // Compute tangent vectors
  // Tangent in X direction: (2*sampleDistance, hR - hL, 0)
  // Tangent in Z direction: (0, hU - hD, 2*sampleDistance)
  // Normal = cross product of these tangents
  
  const dx = hR - hL;
  const dz = hU - hD;
  const scale = 2 * sampleDistance;
  
  // Cross product: (scale, dx, 0) x (0, dz, scale)
  // = (dx * scale - 0, 0 - scale * scale, scale * dz - 0)
  // Simplified: (-dx * scale, scale * scale, -dz * scale)
  // Which simplifies to: (-dx, scale, -dz) after dividing by scale
  
  let nx = -dx;
  let ny = scale;
  let nz = -dz;
  
  // Normalize
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    nx /= len;
    ny /= len;
    nz /= len;
  } else {
    // Fallback to up vector
    nx = 0;
    ny = 1;
    nz = 0;
  }
  
  return [nx, ny, nz];
}

// NeighborLODs interface is imported from types/index.ts
// Re-export for convenience
export type { NeighborLODs } from '../types';

/**
 * Determines the direction of a neighbor relative to a chunk
 */
export type EdgeDirection = 'north' | 'south' | 'east' | 'west';

/**
 * Determine which edge is shared between two adjacent chunks
 * Returns the edge direction from the perspective of the first chunk
 */
export function getSharedEdge(
  chunkX: number, chunkZ: number,
  neighborX: number, neighborZ: number
): EdgeDirection | null {
  const dx = neighborX - chunkX;
  const dz = neighborZ - chunkZ;
  
  // Must be exactly adjacent (not diagonal, not same)
  if (Math.abs(dx) + Math.abs(dz) !== 1) {
    return null;
  }
  
  if (dx === 1) return 'east';
  if (dx === -1) return 'west';
  if (dz === 1) return 'north';
  if (dz === -1) return 'south';
  
  return null;
}

/**
 * Compute the shared edge heights between two adjacent chunks.
 * Both chunks MUST use these exact heights for their shared edge to avoid gaps.
 * 
 * The lower-LOD chunk defines the grid points; the higher-LOD chunk
 * interpolates its additional vertices onto that grid.
 * 
 * @param chunkX, chunkZ - Coordinates of the chunk requesting edge heights
 * @param neighborX, neighborZ - Coordinates of the adjacent neighbor chunk
 * @param chunkLOD - LOD level of the requesting chunk
 * @param neighborLOD - LOD level of the neighbor chunk
 * @param size - Chunk size in world units
 * @returns Array of heights for each vertex on the requesting chunk's edge,
 *          or null if chunks are not adjacent
 */
export function getSharedEdgeHeights(
  chunkX: number, chunkZ: number,
  neighborX: number, neighborZ: number,
  chunkLOD: number, neighborLOD: number,
  size: number
): number[] | null {
  const edge = getSharedEdge(chunkX, chunkZ, neighborX, neighborZ);
  if (!edge) return null;
  
  const chunkRes = getResolutionForLOD(chunkLOD);
  const chunkStep = size / (chunkRes - 1);
  
  // World position offset for this chunk
  const worldOffsetX = chunkX * size;
  const worldOffsetZ = chunkZ * size;
  
  // Determine the LOD to use for height sampling
  // Use the LOWER LOD (coarser grid) - the higher LOD chunk interpolates onto it
  const sampleLOD = Math.min(chunkLOD, neighborLOD);
  const sampleRes = getResolutionForLOD(sampleLOD);
  const sampleStep = size / (sampleRes - 1);
  
  const heights: number[] = [];
  
  // For each vertex on the chunk's edge
  for (let i = 0; i < chunkRes; i++) {
    const localPos = i * chunkStep;  // Position along edge [0, size]
    
    let worldX: number, worldZ: number;
    
    // Determine world coordinates based on which edge
    switch (edge) {
      case 'north':
        worldX = worldOffsetX + localPos;
        worldZ = worldOffsetZ + size;
        break;
      case 'south':
        worldX = worldOffsetX + localPos;
        worldZ = worldOffsetZ;
        break;
      case 'east':
        worldX = worldOffsetX + size;
        worldZ = worldOffsetZ + localPos;
        break;
      case 'west':
        worldX = worldOffsetX;
        worldZ = worldOffsetZ + localPos;
        break;
    }
    
    // If chunk has lower or equal LOD, sample directly at this LOD
    if (chunkLOD <= neighborLOD) {
      heights.push(getTerrainHeight(worldX, worldZ, chunkLOD));
    } else {
      // Chunk has higher LOD - must interpolate onto neighbor's coarser grid
      // Find which segment of the coarser grid this vertex falls into
      const segmentIndex = Math.floor(localPos / sampleStep);
      const segmentStart = segmentIndex * sampleStep;
      const segmentEnd = Math.min(segmentStart + sampleStep, size);
      
      // Interpolation factor within segment
      const segmentLength = segmentEnd - segmentStart;
      const t = segmentLength > 0 ? (localPos - segmentStart) / segmentLength : 0;
      
      // Sample heights at the coarser grid points
      let h0: number, h1: number;
      
      if (edge === 'north' || edge === 'south') {
        // Edge varies along X axis
        const x0 = worldOffsetX + segmentStart;
        const x1 = worldOffsetX + segmentEnd;
        h0 = getTerrainHeight(x0, worldZ, sampleLOD);
        h1 = getTerrainHeight(x1, worldZ, sampleLOD);
      } else {
        // Edge varies along Z axis
        const z0 = worldOffsetZ + segmentStart;
        const z1 = worldOffsetZ + segmentEnd;
        h0 = getTerrainHeight(worldX, z0, sampleLOD);
        h1 = getTerrainHeight(worldX, z1, sampleLOD);
      }
      
      // Linear interpolation
      heights.push(h0 + t * (h1 - h0));
    }
  }
  
  return heights;
}

/**
 * Generate mesh data for a chunk at a specific LOD level
 * Creates terrain with height from procedural noise
 * Supports edge stitching for seamless LOD transitions
 */
export function generateChunkMesh(
  chunkX: number,
  chunkZ: number,
  lodLevel: number,
  size: number,
  neighborLODs?: NeighborLODs
): MeshData {
  const resolution = getResolutionForLOD(lodLevel);
  const vertexCount = calculateVertexCount(resolution);
  const indexCount = calculateIndexCount(resolution);

  const vertices = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);

  // World position offset for this chunk
  const worldOffsetX = chunkX * size;
  const worldOffsetZ = chunkZ * size;

  // Step size between vertices
  const step = size / (resolution - 1);
  
  // Sample distance for normal computation (use vertex spacing)
  const normalSampleDist = step * 0.5;

  // Default neighbor LODs (same as this chunk = no stitching)
  const neighbors: NeighborLODs = neighborLODs ?? {
    north: lodLevel,
    south: lodLevel,
    east: lodLevel,
    west: lodLevel,
    northeast: lodLevel,
    northwest: lodLevel,
    southeast: lodLevel,
    southwest: lodLevel,
  };

  // Pre-compute edge heights using getSharedEdgeHeights for consistency
  // Only compute if neighbor has lower LOD (this chunk adapts to neighbor)
  const northEdgeHeights = neighbors.north < lodLevel
    ? getSharedEdgeHeights(chunkX, chunkZ, chunkX, chunkZ + 1, lodLevel, neighbors.north, size)
    : null;
  const southEdgeHeights = neighbors.south < lodLevel
    ? getSharedEdgeHeights(chunkX, chunkZ, chunkX, chunkZ - 1, lodLevel, neighbors.south, size)
    : null;
  const eastEdgeHeights = neighbors.east < lodLevel
    ? getSharedEdgeHeights(chunkX, chunkZ, chunkX + 1, chunkZ, lodLevel, neighbors.east, size)
    : null;
  const westEdgeHeights = neighbors.west < lodLevel
    ? getSharedEdgeHeights(chunkX, chunkZ, chunkX - 1, chunkZ, lodLevel, neighbors.west, size)
    : null;

  // Generate vertices with height
  // Key insight: vertex X/Z positions NEVER change, only height is interpolated for stitching
  let vertexIndex = 0;
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const localX = x * step;  // Position within chunk [0, size]
      const localZ = z * step;
      const worldX = worldOffsetX + localX;
      const worldZ = worldOffsetZ + localZ;
      
      // Determine if this vertex is on an edge
      const isWestEdge = x === 0;
      const isEastEdge = x === resolution - 1;
      const isSouthEdge = z === 0;
      const isNorthEdge = z === resolution - 1;
      const isCorner = (isWestEdge || isEastEdge) && (isSouthEdge || isNorthEdge);
      
      let height: number;
      let nx: number, ny: number, nz: number;
      
      // For corners: use minimum LOD of all adjacent neighbors (corners always align)
      // For edges: use pre-computed heights from getSharedEdgeHeights
      // For interior: use this chunk's LOD
      
      if (isCorner) {
        // Corner vertices are shared by 4 chunks (this + 2 edge neighbors + 1 diagonal)
        // Use minimum LOD of ALL 4 to ensure all chunks agree on corner heights
        let cornerLOD = lodLevel;
        
        // Include edge neighbors
        if (isWestEdge) cornerLOD = Math.min(cornerLOD, neighbors.west);
        if (isEastEdge) cornerLOD = Math.min(cornerLOD, neighbors.east);
        if (isSouthEdge) cornerLOD = Math.min(cornerLOD, neighbors.south);
        if (isNorthEdge) cornerLOD = Math.min(cornerLOD, neighbors.north);
        
        // Include diagonal neighbor for this corner
        if (isWestEdge && isSouthEdge) cornerLOD = Math.min(cornerLOD, neighbors.southwest);
        if (isWestEdge && isNorthEdge) cornerLOD = Math.min(cornerLOD, neighbors.northwest);
        if (isEastEdge && isSouthEdge) cornerLOD = Math.min(cornerLOD, neighbors.southeast);
        if (isEastEdge && isNorthEdge) cornerLOD = Math.min(cornerLOD, neighbors.northeast);
        
        height = getTerrainHeight(worldX, worldZ, cornerLOD);
        [nx, ny, nz] = computeNormal(worldX, worldZ, cornerLOD, normalSampleDist);
      } else if (isWestEdge && westEdgeHeights) {
        // West edge - use pre-computed heights (indexed by z)
        height = westEdgeHeights[z];
        [nx, ny, nz] = computeNormal(worldX, worldZ, neighbors.west, normalSampleDist);
      } else if (isEastEdge && eastEdgeHeights) {
        // East edge - use pre-computed heights (indexed by z)
        height = eastEdgeHeights[z];
        [nx, ny, nz] = computeNormal(worldX, worldZ, neighbors.east, normalSampleDist);
      } else if (isSouthEdge && southEdgeHeights) {
        // South edge - use pre-computed heights (indexed by x)
        height = southEdgeHeights[x];
        [nx, ny, nz] = computeNormal(worldX, worldZ, neighbors.south, normalSampleDist);
      } else if (isNorthEdge && northEdgeHeights) {
        // North edge - use pre-computed heights (indexed by x)
        height = northEdgeHeights[x];
        [nx, ny, nz] = computeNormal(worldX, worldZ, neighbors.north, normalSampleDist);
      } else {
        // Interior vertex or edge with same/higher LOD neighbor - sample normally
        height = getTerrainHeight(worldX, worldZ, lodLevel);
        [nx, ny, nz] = computeNormal(worldX, worldZ, lodLevel, normalSampleDist);
      }
      
      // Position - X and Z are ALWAYS at original grid positions, only Y (height) varies
      vertices[vertexIndex * 3] = worldX;
      vertices[vertexIndex * 3 + 1] = height;
      vertices[vertexIndex * 3 + 2] = worldZ;

      // Normal
      normals[vertexIndex * 3] = nx;
      normals[vertexIndex * 3 + 1] = ny;
      normals[vertexIndex * 3 + 2] = nz;

      vertexIndex++;
    }
  }

  // Generate indices for triangles
  let indexIndex = 0;
  for (let z = 0; z < resolution - 1; z++) {
    for (let x = 0; x < resolution - 1; x++) {
      // Calculate vertex indices for this quad
      const topLeft = z * resolution + x;
      const topRight = topLeft + 1;
      const bottomLeft = (z + 1) * resolution + x;
      const bottomRight = bottomLeft + 1;

      // First triangle (top-left, bottom-left, top-right)
      indices[indexIndex++] = topLeft;
      indices[indexIndex++] = bottomLeft;
      indices[indexIndex++] = topRight;

      // Second triangle (top-right, bottom-left, bottom-right)
      indices[indexIndex++] = topRight;
      indices[indexIndex++] = bottomLeft;
      indices[indexIndex++] = bottomRight;
    }
  }

  return { vertices, normals, indices };
}
