import * as THREE from 'three';
import type { ChunkCoord, ChunkConfig } from '../types';
import { Chunk } from './Chunk';
import { ChunkBuilder } from './ChunkBuilder';

/**
 * ChunkManager responsible for:
 * - Chunk lifecycle management (create, update, dispose)
 * - Frustum culling for visible chunks only
 * - Screen-space based priority (larger on screen = higher priority)
 * - Altitude-aware view distance scaling
 * - Direction-based priority (chunks in front load first)
 */
export class ChunkManager {
  private config: ChunkConfig;
  private scene: THREE.Scene;
  private activeChunks: Map<string, Chunk> = new Map();
  private buildQueue: ChunkCoord[] = [];
  private chunkBuilder: ChunkBuilder;
  private pendingBuilds: Set<string> = new Set();

  // Frustum culling
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();

  // Reusable vectors and boxes to avoid allocations
  private readonly tempVec3 = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3();
  private readonly chunkBox = new THREE.Box3();
  private readonly chunkCenter = new THREE.Vector3();

  // Screen-space calculation cache
  private screenHeight: number = 1;

  constructor(config: ChunkConfig, scene: THREE.Scene) {
    this.config = config;
    this.scene = scene;
    this.chunkBuilder = new ChunkBuilder();

    // Set defaults for optional config values
    if (this.config.minScreenSize === undefined) {
      this.config.minScreenSize = 10;
    }
    if (this.config.altitudeScale === undefined) {
      this.config.altitudeScale = 0.01;
    }
    if (this.config.frustumMargin === undefined) {
      this.config.frustumMargin = 1.2;
    }
  }

  /**
   * Update chunks based on camera position, direction, and frustum
   */
  update(camera: THREE.PerspectiveCamera): void {
    // Update screen dimensions for screen-space calculations
    this.screenHeight = window.innerHeight;

    // Get current chunk coordinate
    const cameraPosition = camera.position;
    const currentChunk = this.worldToChunkCoord(cameraPosition.x, cameraPosition.z);

    // Store camera forward for priority calculations
    camera.getWorldDirection(this.cameraForward);
    this.cameraForward.setY(0).normalize();

    // Update frustum for culling
    this.updateFrustum(camera);

    // Calculate effective view distance based on altitude
    const effectiveViewDistance = this.calculateEffectiveViewDistance(cameraPosition.y);

    // Determine which chunks should be loaded (frustum culled + altitude scaled)
    const chunksToLoad = this.getChunksToLoad(currentChunk, effectiveViewDistance);

    // Queue new chunks for building
    this.queueNewChunks(chunksToLoad, cameraPosition, camera);

    // Sort build queue by priority (screen-space + direction-aware)
    this.sortBuildQueue(cameraPosition, camera);

    // Process build queue (respect budget)
    this.processBuildQueue();

    // Unload distant chunks (using effective view distance)
    this.unloadDistantChunks(currentChunk, effectiveViewDistance);
  }

  /**
   * Update frustum from camera for culling
   */
  private updateFrustum(camera: THREE.PerspectiveCamera): void {
    // Combine camera projection and world matrix
    this.frustumMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
  }

  /**
   * Calculate effective view distance based on altitude
   * Higher altitude = can see further = load more chunks
   */
  private calculateEffectiveViewDistance(altitude: number): number {
    const baseViewDistance = this.config.viewDistance;
    const altitudeMultiplier = Math.max(1, altitude * (this.config.altitudeScale || 0.01));
    return baseViewDistance * altitudeMultiplier;
  }

  /**
   * Get list of chunks that should be loaded
   * Uses frustum culling and altitude-scaled view distance
   */
  private getChunksToLoad(
    centerChunk: ChunkCoord,
    effectiveViewDistance: number
  ): ChunkCoord[] {
    const chunks: ChunkCoord[] = [];
    const viewDist = Math.ceil(effectiveViewDistance);

    // Generate potential chunks in spiral pattern
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

    // Filter chunks by frustum culling
    const visibleChunks = chunks.filter(coord => this.isChunkInFrustum(coord));

    return visibleChunks;
  }

  /**
   * Check if a chunk is visible in the camera frustum
   */
  private isChunkInFrustum(coord: ChunkCoord): boolean {
    // Create bounding box for chunk
    const chunkMinX = coord.x * this.config.size;
    const chunkMaxX = (coord.x + 1) * this.config.size;
    const chunkMinZ = coord.z * this.config.size;
    const chunkMaxZ = (coord.z + 1) * this.config.size;

    // Use a small height range for the bounding box (chunks are flat)
    const height = 10; // Small height for frustum test
    this.chunkBox.set(
      new THREE.Vector3(chunkMinX, -height, chunkMinZ),
      new THREE.Vector3(chunkMaxX, height, chunkMaxZ)
    );

    // Expand box slightly for margin
    const margin = this.config.frustumMargin || 1.2;
    this.chunkBox.expandByScalar(this.config.size * (margin - 1));

    // Test against frustum
    return this.frustum.intersectsBox(this.chunkBox);
  }

  /**
   * Calculate screen-space size of a chunk in pixels
   */
  private calculateScreenSpaceSize(coord: ChunkCoord, cameraPosition: THREE.Vector3, camera: THREE.PerspectiveCamera): number {
    // Get chunk center
    this.chunkCenter.set(
      (coord.x + 0.5) * this.config.size,
      0, // Chunks are at Y=0
      (coord.z + 0.5) * this.config.size
    );

    // Calculate distance from camera to chunk center
    this.tempVec3.copy(this.chunkCenter).sub(cameraPosition);
    const distance = this.tempVec3.length();

    if (distance < 0.1) {
      return Infinity; // Very close chunks get highest priority
    }

    // Calculate screen-space size
    // Formula: screenSize = (worldSize / distance) * screenHeight * fovFactor
    const worldSize = this.config.size;
    const fovRadians = (camera.fov * Math.PI) / 180;
    const fovFactor = 1 / Math.tan(fovRadians / 2);
    
    const screenSize = (worldSize / distance) * this.screenHeight * fovFactor;

    return screenSize;
  }

  /**
   * Calculate priority for a chunk (lower = higher priority)
   * Combines screen-space size, direction, and distance
   */
  private calculatePriority(coord: ChunkCoord, cameraPosition: THREE.Vector3, camera: THREE.PerspectiveCamera): number {
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

    // Calculate screen-space size
    const screenSize = this.calculateScreenSpaceSize(coord, cameraPosition, camera);

    // Filter out chunks that are too small on screen
    if (screenSize < (this.config.minScreenSize || 10)) {
      return Infinity; // Don't load chunks that are too small
    }

    // Priority calculation:
    // - Base distance (closer = higher priority)
    // - Screen size bonus (larger on screen = higher priority)
    // - Direction bonus (in front = higher priority)
    const screenSizeWeight = 0.1; // Weight for screen size
    const directionBonus = dot * this.config.size * 2;
    const screenSizeBonus = screenSize * screenSizeWeight;

    // Lower priority = build first
    return distance - screenSizeBonus - directionBonus;
  }

  /**
   * Queue new chunks that aren't already active or building
   */
  private queueNewChunks(chunksToLoad: ChunkCoord[], cameraPosition: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
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

      // Check screen-space size - don't queue chunks that are too small
      const screenSize = this.calculateScreenSpaceSize(coord, cameraPosition, camera);
      const minSize = this.config.minScreenSize || 10;
      if (screenSize < minSize) {
        continue;
      }

      // Add to queue
      this.buildQueue.push(coord);
    }
  }

  /**
   * Sort build queue by priority (screen-space + direction-aware)
   */
  private sortBuildQueue(cameraPosition: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    this.buildQueue.sort((a, b) => {
      const priorityA = this.calculatePriority(a, cameraPosition, camera);
      const priorityB = this.calculatePriority(b, cameraPosition, camera);
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
   * Unload chunks that are too far from camera (using effective view distance)
   */
  private unloadDistantChunks(currentChunk: ChunkCoord, effectiveViewDistance: number): void {
    const maxDist = effectiveViewDistance + this.config.disposeBuffer;

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
