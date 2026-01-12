import type { ChunkCoord, ChunkBuildRequest, ChunkBuildResult } from '../types';

/**
 * Callback when a chunk mesh is built
 */
export type ChunkBuiltCallback = (
  coord: ChunkCoord,
  vertices: Float32Array,
  normals: Float32Array,
  indices: Uint32Array
) => void;

/**
 * ChunkBuilder manages web worker communication for async mesh generation
 * Handles request/response tracking and callback dispatch
 */
export class ChunkBuilder {
  private worker: Worker;
  private nextRequestId: number = 0;
  private pendingRequests: Map<number, { coord: ChunkCoord; callback: ChunkBuiltCallback }> = new Map();
  private isReady: boolean = false;
  private queuedRequests: Array<{ coord: ChunkCoord; resolution: number; size: number; callback: ChunkBuiltCallback }> = [];

  constructor() {
    // Create worker from the worker file
    // Vite handles the worker bundling with this syntax
    this.worker = new Worker(
      new URL('./workers/ChunkMeshWorker.ts', import.meta.url),
      { type: 'module' }
    );

    // Handle messages from worker
    this.worker.onmessage = (event: MessageEvent) => {
      const data = event.data;

      if (data.type === 'ready') {
        this.isReady = true;
        // Process any queued requests
        this.processQueuedRequests();
      } else if (data.type === 'built') {
        this.handleBuildResult(data as ChunkBuildResult);
      }
    };

    this.worker.onerror = (error) => {
      console.error('ChunkBuilder worker error:', error);
    };
  }

  /**
   * Request a chunk mesh to be built
   */
  buildChunk(
    coord: ChunkCoord,
    resolution: number,
    size: number,
    callback: ChunkBuiltCallback
  ): void {
    if (!this.isReady) {
      // Queue request until worker is ready
      this.queuedRequests.push({ coord, resolution, size, callback });
      return;
    }

    const requestId = this.nextRequestId++;

    // Store callback for when result arrives
    this.pendingRequests.set(requestId, { coord, callback });

    // Send request to worker
    const request: ChunkBuildRequest = {
      type: 'build',
      chunkX: coord.x,
      chunkZ: coord.z,
      resolution,
      size,
      requestId
    };

    this.worker.postMessage(request);
  }

  /**
   * Process queued requests after worker is ready
   */
  private processQueuedRequests(): void {
    for (const req of this.queuedRequests) {
      this.buildChunk(req.coord, req.resolution, req.size, req.callback);
    }
    this.queuedRequests = [];
  }

  /**
   * Handle build result from worker
   */
  private handleBuildResult(result: ChunkBuildResult): void {
    const pending = this.pendingRequests.get(result.requestId);

    if (pending) {
      this.pendingRequests.delete(result.requestId);

      // Invoke callback with mesh data
      pending.callback(
        pending.coord,
        result.vertices,
        result.normals,
        result.indices
      );
    }
  }

  /**
   * Get number of pending build requests
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Check if builder is ready
   */
  isWorkerReady(): boolean {
    return this.isReady;
  }

  /**
   * Cleanup worker
   */
  dispose(): void {
    this.worker.terminate();
    this.pendingRequests.clear();
    this.queuedRequests = [];
  }
}
