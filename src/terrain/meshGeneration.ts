/**
 * Pure mesh generation functions
 * Used by ChunkMeshWorker - kept separate so they can be unit tested
 */

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

/**
 * Generate mesh data for a chunk at a specific LOD level
 * Creates a flat plane subdivided into triangles
 */
export function generateChunkMesh(
  chunkX: number,
  chunkZ: number,
  lodLevel: number,
  size: number
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

  // Generate vertices
  let vertexIndex = 0;
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      // Position
      vertices[vertexIndex * 3] = worldOffsetX + x * step;
      vertices[vertexIndex * 3 + 1] = 0; // Y = 0 for flat plane (height added later)
      vertices[vertexIndex * 3 + 2] = worldOffsetZ + z * step;

      // Normal pointing up (flat plane)
      normals[vertexIndex * 3] = 0;
      normals[vertexIndex * 3 + 1] = 1;
      normals[vertexIndex * 3 + 2] = 0;

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
