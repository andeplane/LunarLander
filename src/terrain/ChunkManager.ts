import * as THREE from 'three';
import type { ChunkCoord, ChunkConfig } from '../types';
import { Chunk } from './Chunk';
import { ChunkBuilder } from './ChunkBuilder';

/**
 * ChunkManager responsible for:
 * - Chunk lifecycle management (create, update, dispose)
 * - Spiral loading pattern around camera (Minecraft-style)
 * - Direction-based priority (chunks in front load first)
 * - Distance-based unloading
 */
export class ChunkManager {
  private config: ChunkConfig;
  private scene: THREE.Scene;
  private activeChunks: Map<string, Chunk> = new Map();
  private buildQueue: ChunkCoord[] = [];
  private chunkBuilder: ChunkBuilder;
  private pendingBuilds: Set<string> = new Set();

  // Reusable vectors to avoid allocations
  private readonly tempVec3 = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();

  constructor(config: ChunkConfig, scene: THREE.Scene) {
    this.config = config;
    this.scene = scene;
    this.chunkBuilder = new ChunkBuilder();
  }

  /**
   * Update chunks based on camera position and direction
   */
  update(cameraPosition: THREE.Vector3, cameraDirection: THREE.Vector3): void {
    // Get current chunk coordinate
    const currentChunk = this.worldToChunkCoord(cameraPosition.x, cameraPosition.z);

    // Store camera forward for priority calculations
    this.cameraForward.copy(cameraDirection).setY(0).normalize();

    // Determine which chunks should be loaded
    const chunksToLoad = this.getChunksToLoad(currentChunk, cameraPosition);

    // Queue new chunks for building
    this.queueNewChunks(chunksToLoad, cameraPosition);

    // Sort build queue by priority (direction-aware)
    this.sortBuildQueue(cameraPosition);

    // Process build queue (respect budget)
    this.processBuildQueue();

    // Unload distant chunks
    this.unloadDistantChunks(currentChunk);
  }

  /**
   * Get list of chunks that should be loaded using spiral pattern
   * Minecraft-style: expand outward from camera position
   */
  private getChunksToLoad(centerChunk: ChunkCoord, cameraPosition: THREE.Vector3): ChunkCoord[] {
    const chunks: ChunkCoord[] = [];
    const viewDist = this.config.viewDistance;

    // Spiral loading: start from center and expand outward
    // This ensures closer chunks are added first
    for (let ring = 0; ring <= viewDist; ring++) {
      if (ring === 0) {
        // Center chunk
        chunks.push({ x: centerChunk.x, z: centerChunk.z });
      } else {
        // Walk around the ring
        // Top edge (left to right)
        for (let x = -ring; x <= ring; x++) {
          chunks.push({ x: centerChunk.x + x, z: centerChunk.z - ring });
        }
        // Right edge (top to bottom, excluding corners)
        for (let z = -ring + 1; z <= ring - 1; z++) {
          chunks.push({ x: centerChunk.x + ring, z: centerChunk.z + z });
        }
        // Bottom edge (right to left)
        for (let x = ring; x >= -ring; x--) {
          chunks.push({ x: centerChunk.x + x, z: centerChunk.z + ring });
        }
        // Left edge (bottom to top, excluding corners)
        for (let z = ring - 1; z >= -ring + 1; z--) {
          chunks.push({ x: centerChunk.x - ring, z: centerChunk.z + z });
        }
      }
    }

    // Sort by priority (distance + direction bias)
    chunks.sort((a, b) => {
      const priorityA = this.calculatePriority(a, cameraPosition);
      const priorityB = this.calculatePriority(b, cameraPosition);
      return priorityA - priorityB;
    });

    return chunks;
  }

  /**
   * Calculate priority for a chunk (lower = higher priority)
   * Chunks in front of camera get bonus priority
   */
  private calculatePriority(coord: ChunkCoord, cameraPosition: THREE.Vector3): number {
    // Get chunk center in world space
    const chunkCenterX = (coord.x + 0.5) * this.config.size;
    const chunkCenterZ = (coord.z + 0.5) * this.config.size;

    // Direction from camera to chunk
    this.tempVec3.set(
      chunkCenterX - cameraPosition.x,
      0,
      chunkCenterZ - cameraPosition.z
    );

    const distance = this.tempVec3.length();
    this.tempVec3.normalize();

    // Dot product with camera forward (1 = in front, -1 = behind)
    const dot = this.tempVec3.dot(this.cameraForward);

    // Priority: base distance minus direction bonus
    // Chunks in front (dot > 0) get lower priority (loaded first)
    const directionBonus = dot * this.config.size * 2;
    return distance - directionBonus;
  }

  /**
   * Queue new chunks that aren't already active or building
   */
  private queueNewChunks(chunksToLoad: ChunkCoord[], _cameraPosition: THREE.Vector3): void {
    for (const coord of chunksToLoad) {
      const key = this.getChunkKey(coord);

      // Skip if already active or pending
      if (this.activeChunks.has(key) || this.pendingBuilds.has(key)) {
        continue;
      }

      // Skip if already in queue
      if (this.buildQueue.some(c => c.x === coord.x && c.z === coord.z)) {
        continue;
      }

      // Add to queue
      this.buildQueue.push(coord);
    }
  }

  /**
   * Sort build queue by priority
   */
  private sortBuildQueue(cameraPosition: THREE.Vector3): void {
    this.buildQueue.sort((a, b) => {
      const priorityA = this.calculatePriority(a, cameraPosition);
      const priorityB = this.calculatePriority(b, cameraPosition);
      return priorityA - priorityB;
    });
  }

  /**
   * Process build queue, respecting build budget
   */
  private processBuildQueue(): void {
    const budget = this.config.buildBudget;
    let built = 0;

    while (this.buildQueue.length > 0 && built < budget) {
      const coord = this.buildQueue.shift()!;
      const key = this.getChunkKey(coord);

      // Double-check not already building
      if (this.pendingBuilds.has(key)) {
        continue;
      }

      // Create chunk and mark as building
      const chunk = new Chunk(coord);
      chunk.state = 'building';
      this.activeChunks.set(key, chunk);
      this.pendingBuilds.add(key);

      // Request mesh from worker
      this.chunkBuilder.buildChunk(
        coord,
        this.config.resolution,
        this.config.size,
        (resultCoord, vertices, normals, indices) => {
          this.onChunkBuilt(resultCoord, vertices, normals, indices);
        }
      );

      built++;
    }
  }

  /**
   * Callback when chunk mesh is built by worker
   */
  private onChunkBuilt(
    coord: ChunkCoord,
    vertices: Float32Array,
    normals: Float32Array,
    indices: Uint32Array
  ): void {
    const key = this.getChunkKey(coord);
    const chunk = this.activeChunks.get(key);

    if (!chunk) {
      // Chunk was unloaded while building
      this.pendingBuilds.delete(key);
      return;
    }

    // Create mesh from worker data
    chunk.createMeshFromData(vertices, normals, indices, this.config.debugMeshes);
    chunk.addToScene(this.scene);

    this.pendingBuilds.delete(key);
  }

  /**
   * Unload chunks that are too far from camera
   */
  private unloadDistantChunks(currentChunk: ChunkCoord): void {
    const maxDist = this.config.viewDistance + this.config.disposeBuffer;

    for (const [key, chunk] of this.activeChunks) {
      const dx = Math.abs(chunk.coord.x - currentChunk.x);
      const dz = Math.abs(chunk.coord.z - currentChunk.z);

      if (dx > maxDist || dz > maxDist) {
        // Remove from scene
        chunk.removeFromScene(this.scene);
        chunk.dispose();
        this.activeChunks.delete(key);
        this.pendingBuilds.delete(key);
      }
    }
  }

  /**
   * Get height at world position
   */
  getHeightAt(_worldX: number, _worldZ: number): number {
    // Implementation will be added in future tickets
    return 0;
  }

  /**
   * Get chunk coordinate from world position
   */
  worldToChunkCoord(worldX: number, worldZ: number): ChunkCoord {
    return {
      x: Math.floor(worldX / this.config.size),
      z: Math.floor(worldZ / this.config.size)
    };
  }

  /**
   * Get chunk key string from coordinates
   */
  public getChunkKey(coord: ChunkCoord): string {
    return `${coord.x},${coord.z}`;
  }

  /**
   * Get active chunk count
   */
  getActiveChunkCount(): number {
    return this.activeChunks.size;
  }

  /**
   * Get pending build count
   */
  getPendingBuildCount(): number {
    return this.pendingBuilds.size;
  }

  /**
   * Get build queue length
   */
  getBuildQueueLength(): number {
    return this.buildQueue.length;
  }

  /**
   * Cleanup and dispose all chunks
   */
  dispose(): void {
    for (const chunk of this.activeChunks.values()) {
      chunk.removeFromScene(this.scene);
      chunk.dispose();
    }
    this.activeChunks.clear();
    this.buildQueue = [];
    this.pendingBuilds.clear();
    this.chunkBuilder.dispose();
  }
}
