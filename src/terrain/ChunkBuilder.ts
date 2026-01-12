import type { ChunkCoord, ChunkBuildRequest, ChunkBuildResult, NeighborLODs } from '../types';

/**
 * Callback when a chunk mesh is built
 */
export type ChunkBuiltCallback = (
  coord: ChunkCoord,
  lodLevel: number,
  vertices: Float32Array,
  normals: Float32Array,
  indices: Uint32Array
) => void;

/**
 * ChunkBuilder manages a pool of web workers for parallel mesh generation
 * Handles request/response tracking and callback dispatch
 */
export class ChunkBuilder {
  private workers: Worker[] = [];
  private workerBusy: boolean[] = [];
  private nextRequestId: number = 0;
  private pendingRequests: Map<number, { coord: ChunkCoord; lodLevel: number; callback: ChunkBuiltCallback }> = new Map();
  private readyWorkers: number = 0;
  private queuedRequests: Array<{ coord: ChunkCoord; lodLevel: number; size: number; neighborLODs: NeighborLODs; callback: ChunkBuiltCallback }> = [];

  // Track generation per chunk to detect stale results
  private chunkGenerations: Map<string, number> = new Map();
  private requestGenerations: Map<number, number> = new Map();

  constructor() {
    // Create worker pool based on available cores
    const workerCount = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
    
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(
        new URL('./workers/ChunkMeshWorker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (event: MessageEvent) => {
        const data = event.data;

        if (data.type === 'ready') {
          this.readyWorkers++;
          this.workerBusy[i] = false;
          if (this.readyWorkers === this.workers.length) {
            this.processQueuedRequests();
          }
        } else if (data.type === 'built') {
          this.workerBusy[i] = false;
          this.handleBuildResult(data as ChunkBuildResult);
          // Process any queued requests now that a worker is free
          this.processQueuedRequests();
        }
      };

      worker.onerror = (error) => {
        console.error('ChunkBuilder worker error:', error);
        this.workerBusy[i] = false;
      };

      this.workers.push(worker);
      this.workerBusy.push(true); // Start as busy until ready
    }
  }

  /**
   * Request a chunk mesh to be built at a specific LOD level
   * Returns the generation number for this request (to detect staleness)
   */
  buildChunk(
    coord: ChunkCoord,
    lodLevel: number,
    size: number,
    neighborLODs: NeighborLODs,
    callback: ChunkBuiltCallback
  ): number {
    const key = `${coord.x},${coord.z}`;
    
    // Increment generation for this chunk
    const generation = (this.chunkGenerations.get(key) ?? 0) + 1;
    this.chunkGenerations.set(key, generation);

    if (this.readyWorkers < this.workers.length) {
      // Workers not ready yet, queue
      this.queuedRequests.push({ coord, lodLevel, size, neighborLODs, callback });
      return generation;
    }

    // Find a free worker
    const workerIndex = this.workerBusy.findIndex(busy => !busy);
    if (workerIndex === -1) {
      // All workers busy, queue
      this.queuedRequests.push({ coord, lodLevel, size, neighborLODs, callback });
      return generation;
    }

    this.dispatchToWorker(workerIndex, coord, lodLevel, size, neighborLODs, callback, generation);
    return generation;
  }

  private dispatchToWorker(
    workerIndex: number,
    coord: ChunkCoord,
    lodLevel: number,
    size: number,
    neighborLODs: NeighborLODs,
    callback: ChunkBuiltCallback,
    generation: number
  ): void {
    const requestId = this.nextRequestId++;
    
    this.workerBusy[workerIndex] = true;
    this.pendingRequests.set(requestId, { coord, lodLevel, callback });
    this.requestGenerations.set(requestId, generation);

    const request: ChunkBuildRequest = {
      type: 'build',
      chunkX: coord.x,
      chunkZ: coord.z,
      lodLevel,
      size,
      requestId,
      neighborLODs
    };

    this.workers[workerIndex].postMessage(request);
  }

  /**
   * Process queued requests when workers become available
   */
  private processQueuedRequests(): void {
    while (this.queuedRequests.length > 0) {
      const workerIndex = this.workerBusy.findIndex(busy => !busy);
      if (workerIndex === -1) break; // All workers busy

      const req = this.queuedRequests.shift()!;
      const key = `${req.coord.x},${req.coord.z}`;
      const generation = this.chunkGenerations.get(key) ?? 1;
      
      this.dispatchToWorker(workerIndex, req.coord, req.lodLevel, req.size, req.neighborLODs, req.callback, generation);
    }
  }

  /**
   * Handle build result from worker
   */
  private handleBuildResult(result: ChunkBuildResult): void {
    const pending = this.pendingRequests.get(result.requestId);
    const generation = this.requestGenerations.get(result.requestId);

    if (pending) {
      this.pendingRequests.delete(result.requestId);
      this.requestGenerations.delete(result.requestId);

      // Check if this result is stale (newer request was made for this chunk)
      const key = `${pending.coord.x},${pending.coord.z}`;
      const currentGeneration = this.chunkGenerations.get(key);
      
      if (generation !== currentGeneration) {
        // Stale result - a newer request was made, discard this one
        return;
      }

      // Invoke callback with mesh data
      pending.callback(
        pending.coord,
        result.lodLevel,
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
    return this.pendingRequests.size + this.queuedRequests.length;
  }

  /**
   * Check if builder is ready
   */
  isWorkerReady(): boolean {
    return this.readyWorkers === this.workers.length;
  }

  /**
   * Cleanup workers
   */
  dispose(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.workerBusy = [];
    this.pendingRequests.clear();
    this.queuedRequests = [];
    this.chunkGenerations.clear();
    this.requestGenerations.clear();
  }
}
