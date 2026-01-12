/**
 * Web Worker for chunk mesh generation
 * Generates vertices, normals, and indices for terrain chunks
 * Runs off the main thread to prevent frame stuttering
 */

// Worker context - cast self to correct type for web worker APIs
const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

// Worker message types (duplicated here since workers can't import from main thread)
interface ChunkBuildRequest {
  type: 'build';
  chunkX: number;
  chunkZ: number;
  resolution: number;
  size: number;
  requestId: number;
}

interface ChunkBuildResult {
  type: 'built';
  chunkX: number;
  chunkZ: number;
  requestId: number;
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Generate mesh data for a chunk
 * Creates a flat plane subdivided into triangles
 */
function generateChunkMesh(
  chunkX: number,
  chunkZ: number,
  resolution: number,
  size: number
): { vertices: Float32Array; normals: Float32Array; indices: Uint32Array } {
  // Number of vertices = resolution x resolution
  const vertexCount = resolution * resolution;
  // Number of quads = (resolution-1) x (resolution-1)
  // Each quad = 2 triangles = 6 indices
  const quadCount = (resolution - 1) * (resolution - 1);
  const indexCount = quadCount * 6;

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

// Handle incoming messages
workerSelf.onmessage = (event: MessageEvent<ChunkBuildRequest>) => {
  const request = event.data;

  if (request.type === 'build') {
    const { chunkX, chunkZ, resolution, size, requestId } = request;

    // Generate mesh data
    const meshData = generateChunkMesh(chunkX, chunkZ, resolution, size);

    // Send result back with transferable arrays for performance
    const result: ChunkBuildResult = {
      type: 'built',
      chunkX,
      chunkZ,
      requestId,
      vertices: meshData.vertices,
      normals: meshData.normals,
      indices: meshData.indices
    };

    // Transfer ownership of typed arrays to main thread (zero-copy)
    workerSelf.postMessage(result, [
      result.vertices.buffer,
      result.normals.buffer,
      result.indices.buffer
    ]);
  }
};

// Signal that worker is ready
workerSelf.postMessage({ type: 'ready' });
