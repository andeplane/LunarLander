/**
 * Pure mesh generation functions
 * Used by ChunkMeshWorker - kept separate so they can be unit tested
 */

import { createNoise2D } from 'simplex-noise';

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
 * Skirt depth in meters - how far down the skirt walls drop
 */
const SKIRT_DEPTH = 50;

/**
 * Calculate vertex count for a resolution (surface only)
 */
export function calculateVertexCount(resolution: number): number {
  return resolution * resolution;
}

/**
 * Calculate skirt vertex count - 4 edges, each with resolution vertices
 */
export function calculateSkirtVertexCount(resolution: number): number {
  return 4 * resolution;
}

/**
 * Calculate index count for a resolution (surface only)
 */
export function calculateIndexCount(resolution: number): number {
  const quadCount = (resolution - 1) * (resolution - 1);
  return quadCount * 6;
}

/**
 * Calculate skirt index count - 4 edges, each with (resolution-1) segments, 2 triangles each
 */
export function calculateSkirtIndexCount(resolution: number): number {
  return 4 * (resolution - 1) * 6;
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

/**
 * Neighbor LOD information for edge stitching
 */
export interface NeighborLODs {
  north: number;  // +Z direction
  south: number;  // -Z direction
  east: number;   // +X direction
  west: number;   // -X direction
}

/**
 * Snap an edge vertex to align with neighbor's edge (works both directions)
 * Interpolates height on neighbor's grid to ensure vertices lie on neighbor's surface
 */
function getStitchedEdgeHeight(
  edgePosition: number,  // Position along edge [0, size]
  size: number,
  neighborLOD: number,
  thisLOD: number,
  edgeWorldCoord: number,  // Fixed coordinate (X for north/south edges, Z for east/west)
  isXEdge: boolean,  // true for north/south (varying X), false for east/west (varying Z)
  chunkWorldOffsetX: number,
  chunkWorldOffsetZ: number
): number {
  // If neighbor has same LOD, no stitching needed - sample at original position
  if (neighborLOD === thisLOD) {
    const worldX = isXEdge ? (chunkWorldOffsetX + edgePosition) : edgeWorldCoord;
    const worldZ = isXEdge ? edgeWorldCoord : (chunkWorldOffsetZ + edgePosition);
    return getTerrainHeight(worldX, worldZ, thisLOD);
  }

  // Neighbor has different LOD - interpolate on neighbor's grid
  // This works for both lower LOD (coarser) and higher LOD (finer) neighbors
  const neighborRes = getResolutionForLOD(neighborLOD);
  const neighborStep = size / (neighborRes - 1);

  // Find which segment of the neighbor's edge this vertex falls into
  const segmentIndex = Math.floor(edgePosition / neighborStep);
  const segmentStart = segmentIndex * neighborStep;
  const segmentEnd = Math.min((segmentIndex + 1) * neighborStep, size);

  // Calculate interpolation factor within the segment
  const t = (edgePosition - segmentStart) / (segmentEnd - segmentStart);

  // Get heights at segment endpoints (using neighbor's LOD for consistency)
  // This ensures our vertex lies on the neighbor's surface
  let h0: number, h1: number;
  if (isXEdge) {
    h0 = getTerrainHeight(chunkWorldOffsetX + segmentStart, edgeWorldCoord, neighborLOD);
    h1 = getTerrainHeight(chunkWorldOffsetX + segmentEnd, edgeWorldCoord, neighborLOD);
  } else {
    h0 = getTerrainHeight(edgeWorldCoord, chunkWorldOffsetZ + segmentStart, neighborLOD);
    h1 = getTerrainHeight(edgeWorldCoord, chunkWorldOffsetZ + segmentEnd, neighborLOD);
  }

  // Linear interpolation to match neighbor's edge
  return h0 + t * (h1 - h0);
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
  const surfaceVertexCount = calculateVertexCount(resolution);
  const skirtVertexCount = calculateSkirtVertexCount(resolution);
  const totalVertexCount = surfaceVertexCount + skirtVertexCount;
  
  const surfaceIndexCount = calculateIndexCount(resolution);
  const skirtIndexCount = calculateSkirtIndexCount(resolution);
  const totalIndexCount = surfaceIndexCount + skirtIndexCount;

  const vertices = new Float32Array(totalVertexCount * 3);
  const normals = new Float32Array(totalVertexCount * 3);
  const indices = new Uint32Array(totalIndexCount);

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
    west: lodLevel
  };

  // Generate vertices with height
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
      
      // Check if this is a corner vertex
      const isCorner = (isWestEdge || isEastEdge) && (isSouthEdge || isNorthEdge);

      let height: number;

      if (isCorner) {
        // Corner vertices: sample at minimum LOD of adjacent edges to ensure consistency
        // Southwest corner (0, 0): min of west and south neighbors
        // Southeast corner (max, 0): min of east and south neighbors
        // Northwest corner (0, max): min of west and north neighbors
        // Northeast corner (max, max): min of east and north neighbors
        let cornerLOD = lodLevel;
        if (isWestEdge) cornerLOD = Math.min(cornerLOD, neighbors.west);
        if (isEastEdge) cornerLOD = Math.min(cornerLOD, neighbors.east);
        if (isSouthEdge) cornerLOD = Math.min(cornerLOD, neighbors.south);
        if (isNorthEdge) cornerLOD = Math.min(cornerLOD, neighbors.north);
        
        height = getTerrainHeight(worldX, worldZ, cornerLOD);
      } else if (isWestEdge && neighbors.west !== lodLevel) {
        // West edge (non-corner) - stitch to neighbor's LOD (works both directions)
        height = getStitchedEdgeHeight(
          localZ, size, neighbors.west, lodLevel,
          worldX, false, worldOffsetX, worldOffsetZ
        );
      } else if (isEastEdge && neighbors.east !== lodLevel) {
        // East edge (non-corner) - stitch to neighbor's LOD (works both directions)
        height = getStitchedEdgeHeight(
          localZ, size, neighbors.east, lodLevel,
          worldX, false, worldOffsetX, worldOffsetZ
        );
      } else if (isSouthEdge && neighbors.south !== lodLevel) {
        // South edge (non-corner) - stitch to neighbor's LOD (works both directions)
        height = getStitchedEdgeHeight(
          localX, size, neighbors.south, lodLevel,
          worldZ, true, worldOffsetX, worldOffsetZ
        );
      } else if (isNorthEdge && neighbors.north !== lodLevel) {
        // North edge (non-corner) - stitch to neighbor's LOD (works both directions)
        height = getStitchedEdgeHeight(
          localX, size, neighbors.north, lodLevel,
          worldZ, true, worldOffsetX, worldOffsetZ
        );
      } else {
        // Interior vertex or edge with same LOD neighbor
        height = getTerrainHeight(worldX, worldZ, lodLevel);
      }
      
      // Determine LOD for normal computation (use minimum of relevant neighbors)
      let normalLOD = lodLevel;
      if (isWestEdge) normalLOD = Math.min(normalLOD, neighbors.west);
      if (isEastEdge) normalLOD = Math.min(normalLOD, neighbors.east);
      if (isSouthEdge) normalLOD = Math.min(normalLOD, neighbors.south);
      if (isNorthEdge) normalLOD = Math.min(normalLOD, neighbors.north);
      
      // Position
      vertices[vertexIndex * 3] = worldX;
      vertices[vertexIndex * 3 + 1] = height;
      vertices[vertexIndex * 3 + 2] = worldZ;

      // Compute normal from height field
      const [nx, ny, nz] = computeNormal(worldX, worldZ, normalLOD, normalSampleDist);
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

  // ==========================================
  // Generate skirt geometry
  // ==========================================
  
  // Skirt vertices start after surface vertices
  let skirtVertexIndex = surfaceVertexCount;
  
  // Helper to add a skirt vertex (dropped version of surface vertex)
  const addSkirtVertex = (surfaceIdx: number) => {
    const sx = vertices[surfaceIdx * 3];
    const sy = vertices[surfaceIdx * 3 + 1] - SKIRT_DEPTH;
    const sz = vertices[surfaceIdx * 3 + 2];
    
    vertices[skirtVertexIndex * 3] = sx;
    vertices[skirtVertexIndex * 3 + 1] = sy;
    vertices[skirtVertexIndex * 3 + 2] = sz;
    
    // Skirt normals point outward from chunk (will be set per-edge)
    normals[skirtVertexIndex * 3] = 0;
    normals[skirtVertexIndex * 3 + 1] = 0;
    normals[skirtVertexIndex * 3 + 2] = 0;
    
    return skirtVertexIndex++;
  };
  
  // Track skirt vertex indices for each edge
  const southSkirtStart = skirtVertexIndex;
  // South edge (z = 0): vertices from x=0 to x=resolution-1
  for (let x = 0; x < resolution; x++) {
    const surfaceIdx = x; // z=0 row
    addSkirtVertex(surfaceIdx);
    // Normal points -Z (south, outward)
    normals[(skirtVertexIndex - 1) * 3 + 2] = -1;
  }
  
  const northSkirtStart = skirtVertexIndex;
  // North edge (z = resolution-1): vertices from x=0 to x=resolution-1
  for (let x = 0; x < resolution; x++) {
    const surfaceIdx = (resolution - 1) * resolution + x;
    addSkirtVertex(surfaceIdx);
    // Normal points +Z (north, outward)
    normals[(skirtVertexIndex - 1) * 3 + 2] = 1;
  }
  
  const westSkirtStart = skirtVertexIndex;
  // West edge (x = 0): vertices from z=0 to z=resolution-1
  for (let z = 0; z < resolution; z++) {
    const surfaceIdx = z * resolution;
    addSkirtVertex(surfaceIdx);
    // Normal points -X (west, outward)
    normals[(skirtVertexIndex - 1) * 3] = -1;
  }
  
  const eastSkirtStart = skirtVertexIndex;
  // East edge (x = resolution-1): vertices from z=0 to z=resolution-1
  for (let z = 0; z < resolution; z++) {
    const surfaceIdx = z * resolution + (resolution - 1);
    addSkirtVertex(surfaceIdx);
    // Normal points +X (east, outward)
    normals[(skirtVertexIndex - 1) * 3] = 1;
  }

  // ==========================================
  // Generate skirt indices (triangles)
  // ==========================================
  
  // Helper to add skirt triangles for an edge
  // surfaceStart: first surface vertex index for this edge
  // skirtStart: first skirt vertex index for this edge
  // count: number of vertices along edge
  // flip: whether to flip triangle winding (for consistent face orientation)
  const addSkirtIndices = (
    surfaceStart: number,
    skirtStart: number,
    count: number,
    surfaceStride: number,
    flip: boolean
  ) => {
    for (let i = 0; i < count - 1; i++) {
      const s0 = surfaceStart + i * surfaceStride;      // surface vertex i
      const s1 = surfaceStart + (i + 1) * surfaceStride; // surface vertex i+1
      const k0 = skirtStart + i;                         // skirt vertex i
      const k1 = skirtStart + i + 1;                     // skirt vertex i+1
      
      if (flip) {
        // Triangle 1: s0, k0, s1
        indices[indexIndex++] = s0;
        indices[indexIndex++] = k0;
        indices[indexIndex++] = s1;
        // Triangle 2: s1, k0, k1
        indices[indexIndex++] = s1;
        indices[indexIndex++] = k0;
        indices[indexIndex++] = k1;
      } else {
        // Triangle 1: s0, s1, k0
        indices[indexIndex++] = s0;
        indices[indexIndex++] = s1;
        indices[indexIndex++] = k0;
        // Triangle 2: s1, k1, k0
        indices[indexIndex++] = s1;
        indices[indexIndex++] = k1;
        indices[indexIndex++] = k0;
      }
    }
  };
  
  // South edge: surface vertices at z=0 (indices 0 to resolution-1), stride 1
  addSkirtIndices(0, southSkirtStart, resolution, 1, true);
  
  // North edge: surface vertices at z=resolution-1 (indices (res-1)*res to res*res-1), stride 1
  addSkirtIndices((resolution - 1) * resolution, northSkirtStart, resolution, 1, false);
  
  // West edge: surface vertices at x=0 (indices 0, res, 2*res, ...), stride resolution
  addSkirtIndices(0, westSkirtStart, resolution, resolution, false);
  
  // East edge: surface vertices at x=resolution-1 (indices res-1, 2*res-1, ...), stride resolution
  addSkirtIndices(resolution - 1, eastSkirtStart, resolution, resolution, true);

  return { vertices, normals, indices };
}
