import * as THREE from 'three';
import type { ChunkCoord, ChunkConfig, NeighborLODs } from '../types';
import { getTargetLODForScreenSize, LOD_LEVELS } from '../types';
import { Chunk } from './Chunk';
import { ChunkBuilder } from './ChunkBuilder';
import { generateChunkMesh } from './meshGeneration';

/**
 * LOD upgrade request in the queue
 */
interface LODUpgradeRequest {
  coord: ChunkCoord;
  targetLOD: number;
  priority: number;
}

/**
 * ChunkManager responsible for:
 * - Chunk lifecycle management (create, update, dispose)
 * - Progressive LOD generation (start low, upgrade as needed)
 * - Frustum culling for visible chunks only
 * - Screen-space based LOD selection
 * - Altitude-aware view distance scaling
 */
export class ChunkManager {
  private config: ChunkConfig;
  private scene: THREE.Scene;
  private activeChunks: Map<string, Chunk> = new Map();
  private buildQueue: ChunkCoord[] = [];
  private lodUpgradeQueue: LODUpgradeRequest[] = [];
  private chunkBuilder: ChunkBuilder;
  // Current LOD map - tracks what each chunk is ACTUALLY rendering
  // This is the single source of truth for neighbor LOD lookups
  private currentLODMap: Map<string, number> = new Map();

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
    if (this.config.lodUpgradeBudget === undefined) {
      this.config.lodUpgradeBudget = 2;
    }
  }

  // DEBUG: Set to true to only load 2 chunks for edge debugging (LOD still dynamic)
  private debugTwoChunksMode = false;
  private debugChunkCoords: ChunkCoord[] = [{ x: 0, z: 0 }, { x: 1, z: 0 }];

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
    // DEBUG: Override to only load 2 specific chunks
    const chunksToLoad = this.debugTwoChunksMode 
      ? this.debugChunkCoords 
      : this.getChunksToLoad(currentChunk, effectiveViewDistance);

    // Queue new chunks for building (at LOD 0)
    this.queueNewChunks(chunksToLoad, cameraPosition, camera);

    // Update LOD levels for active chunks and queue upgrades
    this.updateChunkLODs(cameraPosition, camera);

    // Sort build queue by priority (screen-space + direction-aware)
    this.sortBuildQueue(cameraPosition, camera);

    // Process build queue (new chunks at LOD 0) - atomic updates
    this.processBuildQueue();

    // Process LOD upgrade queue - atomic updates
    this.processLODUpgradeQueue();

    // Unload distant chunks (using effective view distance)
    // DEBUG: Don't unload chunks in debug mode
    if (!this.debugTwoChunksMode) {
      this.unloadDistantChunks(currentChunk, effectiveViewDistance);
    }
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
   * Calculate priority for LOD upgrades (simpler: pure distance-based)
   * Lower value = higher priority (processed first)
   */
  private calculateLODUpgradePriority(coord: ChunkCoord, cameraPosition: THREE.Vector3): number {
    const dx = (coord.x + 0.5) * this.config.size - cameraPosition.x;
    const dz = (coord.z + 0.5) * this.config.size - cameraPosition.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Queue new chunks that aren't already active
   * New chunks always start at LOD 0 (lowest detail)
   */
  private queueNewChunks(chunksToLoad: ChunkCoord[], cameraPosition: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    for (const coord of chunksToLoad) {
      const key = this.getChunkKey(coord);

      // Skip if already active
      if (this.activeChunks.has(key)) {
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
   * Update LOD levels for all active chunks based on screen-space size
   * Queue LOD upgrades for chunks that need higher detail
   */
  private updateChunkLODs(cameraPosition: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
    for (const [_key, chunk] of this.activeChunks) {
      if (chunk.state !== 'active') continue;

      // Calculate screen-space size
      const screenSize = this.calculateScreenSpaceSize(chunk.coord, cameraPosition, camera);

      // Determine target LOD based on screen size
      const targetLOD = getTargetLODForScreenSize(screenSize);

      // Check if we need to generate a higher LOD
      // Use progressive upgrades: go one level at a time (0→1→2→3→4)
      const highestGenerated = chunk.getHighestGeneratedLOD();
      if (targetLOD > highestGenerated) {
        // Next LOD to build (one level up from what we have)
        const nextLOD = highestGenerated + 1;
        const maxLOD = LOD_LEVELS.length - 1;
        
        if (nextLOD <= maxLOD) {
          // Check if already in queue
          const alreadyQueued = this.lodUpgradeQueue.some(
            req => req.coord.x === chunk.coord.x && 
                   req.coord.z === chunk.coord.z && 
                   req.targetLOD === nextLOD
          );
          
          if (!alreadyQueued) {
            const priority = this.calculateLODUpgradePriority(chunk.coord, cameraPosition);
            this.lodUpgradeQueue.push({
              coord: chunk.coord,
              targetLOD: nextLOD,
              priority
            });
          }
        }
      }
    }

    // Sort LOD upgrade queue by priority
    this.lodUpgradeQueue.sort((a, b) => a.priority - b.priority);
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
   * Process build queue for new chunks atomically:
   * 1. Collect new chunks to build (within budget)
   * 2. Create chunk objects and update LODMap for ALL
   * 3. Build all meshes using consistent map
   * 4. Add to scene
   */
  private processBuildQueue(): void {
    const budget = this.config.buildBudget;
    
    // Step 1: Collect new chunks to build (within budget)
    const newChunks: Array<{coord: ChunkCoord, chunk: Chunk, key: string}> = [];
    
    while (this.buildQueue.length > 0 && newChunks.length < budget) {
      const coord = this.buildQueue.shift()!;
      const key = this.getChunkKey(coord);
      
      // Skip if already exists
      if (this.activeChunks.has(key)) continue;
      
      // Create chunk object
      const chunk = new Chunk(coord);
      chunk.state = 'building';
      this.activeChunks.set(key, chunk);
      
      newChunks.push({ coord, chunk, key });
    }
    
    if (newChunks.length === 0) return;
    
    // Step 2: Update currentLODMap for ALL new chunks FIRST (all start at LOD 0)
    for (const { key } of newChunks) {
      this.currentLODMap.set(key, 0);
    }
    
    // Step 3: Collect all affected chunks (new chunks + their existing neighbors)
    const affectedChunks = new Set<string>();
    for (const { coord, key } of newChunks) {
      affectedChunks.add(key);
      // Add existing neighbors that need edge updates
      const neighbors = [
        { x: coord.x - 1, z: coord.z },
        { x: coord.x + 1, z: coord.z },
        { x: coord.x, z: coord.z - 1 },
        { x: coord.x, z: coord.z + 1 },
      ];
      for (const nc of neighbors) {
        const nkey = this.getChunkKey(nc);
        if (this.activeChunks.has(nkey) && this.activeChunks.get(nkey)!.state === 'active') {
          affectedChunks.add(nkey);
        }
      }
    }
    
    // Step 4: Build all affected chunks synchronously
    for (const key of affectedChunks) {
      const chunk = this.activeChunks.get(key);
      if (!chunk) continue;
      
      const lod = this.currentLODMap.get(key);
      if (lod === undefined || lod < 0) continue;
      
      const neighborLODs = this.getNeighborLODs(chunk.coord, lod);
      const meshData = generateChunkMesh(
        chunk.coord.x, chunk.coord.z, lod, this.config.size, neighborLODs
      );
      
      const isNewChunk = chunk.state === 'building';
      
      if (isNewChunk) {
        // New chunk - add LOD data and add to scene
        chunk.addLODFromData(lod, meshData.vertices, meshData.normals, meshData.indices, this.config.debugMeshes);
        chunk.addToScene(this.scene);
      } else {
        // Existing neighbor - replace mesh
        chunk.replaceLODMesh(lod, meshData.vertices, meshData.normals, meshData.indices, this.config.debugMeshes);
      }
    }
  }

  /**
   * Process LOD upgrades atomically:
   * 1. Collect all LOD changes for this frame
   * 2. Update currentLODMap for ALL of them upfront
   * 3. Build all affected meshes using consistent map
   */
  private processLODUpgradeQueue(): void {
    const budget = this.config.lodUpgradeBudget || 2;
    
    // Step 1: Collect LOD changes from queue (within budget)
    const lodChanges: Array<{coord: ChunkCoord, chunk: Chunk, newLOD: number}> = [];
    
    while (this.lodUpgradeQueue.length > 0 && lodChanges.length < budget) {
      const request = this.lodUpgradeQueue.shift()!;
      const key = this.getChunkKey(request.coord);
      const chunk = this.activeChunks.get(key);
      
      if (!chunk || chunk.state !== 'active') continue;
      if (chunk.hasLOD(request.targetLOD)) continue;
      
      lodChanges.push({ coord: request.coord, chunk, newLOD: request.targetLOD });
    }
    
    if (lodChanges.length === 0) return;
    
    // Step 2: Update currentLODMap for ALL changes FIRST
    for (const { coord, newLOD } of lodChanges) {
      this.currentLODMap.set(this.getChunkKey(coord), newLOD);
    }
    
    // Step 3: Collect all affected chunks (changed chunks + their neighbors)
    const affectedChunks = new Set<string>();
    for (const { coord } of lodChanges) {
      affectedChunks.add(this.getChunkKey(coord));
      // Add all 4 neighbors
      affectedChunks.add(this.getChunkKey({ x: coord.x - 1, z: coord.z }));
      affectedChunks.add(this.getChunkKey({ x: coord.x + 1, z: coord.z }));
      affectedChunks.add(this.getChunkKey({ x: coord.x, z: coord.z - 1 }));
      affectedChunks.add(this.getChunkKey({ x: coord.x, z: coord.z + 1 }));
    }
    
    // Step 4: Build/rebuild all affected chunks synchronously using consistent map
    for (const key of affectedChunks) {
      const chunk = this.activeChunks.get(key);
      if (!chunk || chunk.state !== 'active') continue;
      
      const lod = this.currentLODMap.get(key);
      if (lod === undefined || lod < 0) continue;
      
      // Generate mesh with consistent neighbor LODs
      const neighborLODs = this.getNeighborLODs(chunk.coord, lod);
      const meshData = generateChunkMesh(
        chunk.coord.x, chunk.coord.z, lod, this.config.size, neighborLODs
      );
      
      // Add or replace the LOD mesh
      if (chunk.hasLOD(lod)) {
        chunk.replaceLODMesh(lod, meshData.vertices, meshData.normals, meshData.indices, this.config.debugMeshes);
      } else {
        chunk.addLODFromData(lod, meshData.vertices, meshData.normals, meshData.indices, this.config.debugMeshes);
      }
    }
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
        
        // Remove from currentLODMap
        this.currentLODMap.delete(key);
        
        // Remove from LOD upgrade queue
        this.lodUpgradeQueue = this.lodUpgradeQueue.filter(
          req => req.coord.x !== chunk.coord.x || req.coord.z !== chunk.coord.z
        );
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
   * Get LOD levels of neighboring chunks for edge stitching
   * Uses currentLODMap - the single source of truth for what's actually rendered
   */
  public getNeighborLODs(coord: ChunkCoord, ownLOD: number): NeighborLODs {
    const getNeighborLOD = (nx: number, nz: number): number => {
      const neighborKey = this.getChunkKey({ x: nx, z: nz });
      const lod = this.currentLODMap.get(neighborKey);
      // If neighbor doesn't exist in map, use own LOD (no stitching needed)
      return lod ?? ownLOD;
    };

    return {
      north: getNeighborLOD(coord.x, coord.z + 1),  // +Z
      south: getNeighborLOD(coord.x, coord.z - 1),  // -Z
      east: getNeighborLOD(coord.x + 1, coord.z),   // +X
      west: getNeighborLOD(coord.x - 1, coord.z),   // -X
    };
  }

  /**
   * Get active chunk count
   */
  getActiveChunkCount(): number {
    return this.activeChunks.size;
  }

  /**
   * Get pending build count (items in build queue)
   */
  getPendingBuildCount(): number {
    return this.buildQueue.length;
  }

  /**
   * Get build queue length
   */
  getBuildQueueLength(): number {
    return this.buildQueue.length;
  }

  /**
   * Get LOD upgrade queue length
   */
  getLODUpgradeQueueLength(): number {
    return this.lodUpgradeQueue.length;
  }

  /**
   * Toggle debug mesh mode for all active chunks
   */
  toggleDebugMeshes(): void {
    this.config.debugMeshes = !this.config.debugMeshes;
    
    // Recreate meshes for all active chunks
    for (const chunk of this.activeChunks.values()) {
      if (chunk.state === 'active') {
        chunk.recreateMeshesWithDebugMode(this.config.debugMeshes);
      }
    }

    console.log(`Debug meshes ${this.config.debugMeshes ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get current debug mesh state
   */
  getDebugMeshesEnabled(): boolean {
    return this.config.debugMeshes || false;
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
    this.currentLODMap.clear();
    this.buildQueue = [];
    this.lodUpgradeQueue = [];
    this.chunkBuilder.dispose();
  }
}
