import { InstancedMesh, Matrix4, type Scene, type Vector3, type BufferGeometry } from 'three';
import { RockManager } from './RockManager';
import type { MoonMaterial } from '../shaders/MoonMaterial';
import { projectToScreenSpace, LodDetailLevel, parseGridKey } from '../terrain/LodUtils';
import type { RockPlacement } from '../terrain/ChunkWorker';

/**
 * Tracks instance allocation for a chunk
 */
interface ChunkInstanceAllocation {
  meshKey: string; // "prototypeId:detailLevel"
  startIndex: number;
  count: number;
}

/**
 * Global rock batcher that maintains one InstancedMesh per (prototypeId, detailLevel) combination.
 * Dramatically reduces draw calls by batching all rock instances across all chunks.
 */
export class GlobalRockBatcher {
  private rockManager: RockManager;
  private meshes: Map<string, InstancedMesh> = new Map(); // Key: "prototypeId:detailLevel"
  private chunkAllocations: Map<string, ChunkInstanceAllocation[]> = new Map(); // Key: chunkKey
  private nextFreeIndex: Map<string, number> = new Map(); // Key: meshKey -> next free instance slot
  private maxInstancesPerMesh: number;
  private material: MoonMaterial;
  private chunkWidth: number;
  private chunkDepth: number;
  private lodLevels: number[];
  private scene: Scene | null = null; // Scene reference for adding meshes dynamically

  /**
   * Create a GlobalRockBatcher
   * 
   * @param rockManager - RockManager instance for accessing prototype geometries
   * @param maxInstancesPerMesh - Maximum instances per mesh (default: 100000)
   */
  constructor(
    rockManager: RockManager,
    maxInstancesPerMesh: number = 100000
  ) {
    this.rockManager = rockManager;
    this.maxInstancesPerMesh = maxInstancesPerMesh;
    this.material = rockManager.getMaterial();
    
    // Default config - update via setConfig() with actual values
    this.chunkWidth = 100;
    this.chunkDepth = 100;
    this.lodLevels = [1024, 512, 256, 128, 64, 32, 16, 8, 4];
  }

  /**
   * Set configuration for chunk world position calculations
   */
  setConfig(
    _renderDistance: number, // Kept for API compatibility
    chunkWidth: number,
    chunkDepth: number,
    _planetRadius: number, // Kept for API compatibility
    lodLevels: number[]
  ): void {
    this.chunkWidth = chunkWidth;
    this.chunkDepth = chunkDepth;
    this.lodLevels = lodLevels;
  }

  /**
   * Get or create a global InstancedMesh for a given prototype and detail level
   */
  private getOrCreateMesh(prototypeId: number, detailLevel: number): InstancedMesh {
    const meshKey = `${prototypeId}:${detailLevel}`;
    
    let mesh = this.meshes.get(meshKey);
    if (!mesh) {
      // Get prototype geometry from RockManager
      const prototypes = this.getPrototypesForDetail(detailLevel);
      if (!prototypes || prototypes.length === 0) {
        throw new Error(`No prototypes available for detail level ${detailLevel}`);
      }
      
      const geometry = prototypes[prototypeId % prototypes.length];
      if (!geometry) {
        throw new Error(`Prototype ${prototypeId} not found for detail level ${detailLevel}`);
      }

      // Create InstancedMesh with max capacity
      mesh = new InstancedMesh(geometry, this.material, this.maxInstancesPerMesh);
      mesh.count = 0; // Start with 0 active instances
      
      // Disable frustum culling - instances are spread across the entire terrain
      // so the base geometry bounding sphere doesn't represent actual instance positions.
      // GPU will still do per-triangle culling.
      mesh.frustumCulled = false;
      
      // Initialize free index tracker
      this.nextFreeIndex.set(meshKey, 0);
      
      this.meshes.set(meshKey, mesh);
      
      // Add to scene if we have a scene reference
      if (this.scene) {
        this.scene.add(mesh);
      }
    }
    
    return mesh;
  }

  /**
   * Get prototypes for a given detail level
   */
  private getPrototypesForDetail(detailLevel: number): BufferGeometry[] | undefined {
    return this.rockManager.getPrototypesForDetail(detailLevel);
  }

  /**
   * Add rock instances from a chunk
   */
  addChunkInstances(chunkKey: string, placements: RockPlacement[], lodLevel: number): void {
    // Remove any existing allocations for this chunk first (in case of LOD update)
    this.removeChunkInstances(chunkKey);
    
    // Parse chunk key to get world position offset
    const [gridX, gridZ] = parseGridKey(chunkKey);
    const worldOffsetX = gridX * this.chunkWidth;
    const worldOffsetZ = gridZ * this.chunkDepth;
    
    const detailLevel = RockManager.getDetailForLod(
      lodLevel,
      this.chunkWidth,
      this.chunkDepth,
      this.lodLevels
    );
    
    const allocations: ChunkInstanceAllocation[] = [];
    
    for (const placement of placements) {
      const { prototypeId, matrices } = placement;
      const instanceCount = matrices.length / 16;
      if (instanceCount === 0) {
        continue;
      }
      
      const meshKey = `${prototypeId}:${detailLevel}`;
      const mesh = this.getOrCreateMesh(prototypeId, detailLevel);
      
      // Get next free index
      const startIndex = this.nextFreeIndex.get(meshKey) ?? 0;
      
      // Check if we have enough space
      if (startIndex + instanceCount > this.maxInstancesPerMesh) {
        console.warn(`GlobalRockBatcher: Out of instance slots for ${meshKey}. Consider increasing maxInstancesPerMesh.`);
        continue;
      }
      
      // Copy matrices into instance buffer, transforming from local chunk space to world space
      const matrix = new Matrix4();
      const chunkOffsetMatrix = new Matrix4().makeTranslation(worldOffsetX, 0, worldOffsetZ);
      for (let i = 0; i < instanceCount; i++) {
        const offset = i * 16;
        matrix.fromArray(matrices, offset);
        // Transform local chunk position to world position
        matrix.premultiply(chunkOffsetMatrix);
        mesh.setMatrixAt(startIndex + i, matrix);
      }
      
      // Update active instance count
      mesh.count = Math.max(mesh.count, startIndex + instanceCount);
      
      // Mark instance matrix as needing update
      mesh.instanceMatrix.needsUpdate = true;
      
      // Track allocation
      allocations.push({
        meshKey,
        startIndex,
        count: instanceCount,
      });
      
      // Update next free index
      this.nextFreeIndex.set(meshKey, startIndex + instanceCount);
    }
    
    // Store allocations for this chunk
    if (allocations.length > 0) {
      this.chunkAllocations.set(chunkKey, allocations);
    }
  }

  /**
   * Remove all instances for a chunk
   * Note: Currently uses simple approach - just reduces count, doesn't compact.
   * This leaves "holes" in the buffer but is simpler and correct.
   * Can be optimized later with compaction if memory becomes an issue.
   */
  removeChunkInstances(chunkKey: string): void {
    const allocations = this.chunkAllocations.get(chunkKey);
    if (!allocations || allocations.length === 0) {
      return;
    }
    
    // For now, we'll just reduce the count if these are the last instances
    // This is simpler than compaction and works correctly
    // TODO: Implement proper compaction with allocation tracking if needed
    for (const allocation of allocations) {
      const mesh = this.meshes.get(allocation.meshKey);
      if (!mesh) {
        continue;
      }
      
      const freedStart = allocation.startIndex;
      const freedEnd = freedStart + allocation.count;
      const currentCount = mesh.count;
      
      // If these are the last instances, reduce count
      if (freedEnd >= currentCount) {
        mesh.count = freedStart;
        // Update next free index to allow reuse of these slots
        const currentNextFree = this.nextFreeIndex.get(allocation.meshKey) ?? 0;
        this.nextFreeIndex.set(allocation.meshKey, Math.min(currentNextFree, freedStart));
        mesh.instanceMatrix.needsUpdate = true;
      }
      // Otherwise, leave holes (instances will still render correctly)
    }
    
    // Remove allocations
    this.chunkAllocations.delete(chunkKey);
  }

  /**
   * Update visibility for all rock meshes based on screen space size
   */
  updateVisibility(
    cameraPosition: Vector3,
    fovRadians: number,
    screenHeight: number,
    minScreenSize: number = LodDetailLevel.Balanced
  ): void {
    for (const mesh of this.meshes.values()) {
      if (mesh.count === 0) {
        mesh.visible = false;
        continue;
      }
      
      // Ensure bounding sphere is computed
      if (!mesh.boundingSphere) {
        mesh.computeBoundingSphere();
      }
      
      if (!mesh.boundingSphere) {
        mesh.visible = false;
        continue;
      }
      
      // Transform bounding sphere center to world space
      const sphereCenterLocal = mesh.boundingSphere.center;
      const worldCenter = sphereCenterLocal.clone().applyMatrix4(mesh.matrixWorld);
      
      // Calculate distance from camera to bounding sphere center
      const dx = cameraPosition.x - worldCenter.x;
      const dy = cameraPosition.y - worldCenter.y;
      const dz = cameraPosition.z - worldCenter.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      
      // Calculate screen space size of bounding sphere diameter
      const diameter = mesh.boundingSphere.radius * 2;
      const screenSize = projectToScreenSpace(diameter, distance, fovRadians, screenHeight);
      
      // Show mesh if bounding sphere diameter is >= threshold
      mesh.visible = screenSize >= minScreenSize;
    }
  }

  /**
   * Get all global meshes for adding to scene
   */
  getMeshes(): InstancedMesh[] {
    return Array.from(this.meshes.values());
  }

  /**
   * Add all meshes to scene and store scene reference for future meshes
   */
  addToScene(scene: Scene): void {
    this.scene = scene;
    // Add any existing meshes (though typically called before meshes are created)
    for (const mesh of this.meshes.values()) {
      scene.add(mesh);
    }
  }

  /**
   * Remove all meshes from scene and clear scene reference
   */
  removeFromScene(scene: Scene): void {
    for (const mesh of this.meshes.values()) {
      scene.remove(mesh);
    }
    this.scene = null;
  }

  /**
   * Get the shared material
   */
  getMaterial(): MoonMaterial {
    return this.material;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    // Dispose all meshes
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      // Note: material is shared with RockManager, don't dispose here
    }
    this.meshes.clear();
    this.chunkAllocations.clear();
    this.nextFreeIndex.clear();
  }
}
