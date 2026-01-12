/**
 * Web Worker for chunk mesh generation
 * Generates vertices, normals, and indices for terrain chunks
 * Runs off the main thread to prevent frame stuttering
 */

import { generateChunkMesh } from '../meshGeneration';

// Worker context - cast self to correct type for web worker APIs
const workerSelf = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

// Worker message types - must match types/index.ts
interface NeighborLODs {
  north: number;
  south: number;
  east: number;
  west: number;
}

interface ChunkBuildRequest {
  type: 'build';
  chunkX: number;
  chunkZ: number;
  lodLevel: number;
  size: number;
  requestId: number;
  neighborLODs: NeighborLODs;
}

interface ChunkBuildResult {
  type: 'built';
  chunkX: number;
  chunkZ: number;
  lodLevel: number;
  requestId: number;
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

// Handle incoming messages
workerSelf.onmessage = (event: MessageEvent<ChunkBuildRequest>) => {
  const request = event.data;

  if (request.type === 'build') {
    const { chunkX, chunkZ, lodLevel, size, requestId, neighborLODs } = request;

    // Generate mesh data for the specified LOD level with edge stitching
    const meshData = generateChunkMesh(chunkX, chunkZ, lodLevel, size, neighborLODs);

    // Send result back with transferable arrays for performance
    const result: ChunkBuildResult = {
      type: 'built',
      chunkX,
      chunkZ,
      lodLevel,
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
