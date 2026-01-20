/**
 * TerrainColliderManager - Manages Rapier heightfield colliders for terrain chunks
 * 
 * Handles:
 * - Creating heightfield colliders from visible LOD meshes
 * - Tracking which chunks have active colliders
 * - Updating colliders when chunks enter/leave physics range or LOD changes
 * - Proper height extraction from mesh geometry (handles negative heights in craters)
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { Vector3, Mesh as ThreeMesh } from 'three';
import type { ChunkManager } from '../terrain/ChunkManager';
import { parseGridKey } from '../terrain/LodUtils';
import type { Chunk } from '../terrain/Chunk';

/**
 * Configuration for terrain collider management
 */
export interface TerrainColliderConfig {
  /** Number of chunks around camera to create colliders for (default: 2) */
  physicsRange?: number;
}

/**
 * Tracks a collider for a chunk
 */
interface ChunkCollider {
  collider: RAPIER.Collider;
  gridKey: string;
  lodLevel: number;
  minHeight: number;
  maxHeight: number;
}

export class TerrainColliderManager {
  private world: RAPIER.World;
  private chunkManager: ChunkManager;
  private config: Required<TerrainColliderConfig>;
  private colliders: Map<string, ChunkCollider> = new Map(); // key: gridKey
  private chunkWidth: number;
  private chunkDepth: number;
  private lodLevels: number[];

  constructor(
    world: RAPIER.World,
    chunkManager: ChunkManager,
    chunkWidth: number,
    chunkDepth: number,
    lodLevels: number[],
    config?: TerrainColliderConfig
  ) {
    this.world = world;
    this.chunkManager = chunkManager;
    this.chunkWidth = chunkWidth;
    this.chunkDepth = chunkDepth;
    this.lodLevels = lodLevels;
    this.config = {
      physicsRange: config?.physicsRange ?? 2,
    };
  }

  /**
   * Update colliders based on camera position.
   * Should be called every frame.
   */
  update(cameraPosition: Vector3): void {
    // Determine which chunks are within physics range
    const nearbyChunks = this.getNearbyChunks(cameraPosition);

    // Create/update colliders for nearby chunks
    for (const chunk of nearbyChunks) {
      const mesh = chunk.getTerrainMesh(chunk.currentLodLevel);
      if (!mesh) {
        continue; // Chunk not ready yet
      }

      const existing = this.colliders.get(chunk.gridKey);
      // Rebuild if collider doesn't exist OR if LOD changed (to match visual mesh)
      const needsRebuild = !existing || existing.lodLevel !== chunk.currentLodLevel;

      if (needsRebuild) {
        // Remove old collider if exists
        if (existing) {
          this.world.removeCollider(existing.collider, true);
          this.colliders.delete(chunk.gridKey);
        }

        const collider = this.createHeightfieldCollider(chunk, mesh);
        if (collider) {
          this.colliders.set(chunk.gridKey, collider);
        }
      }
    }

    // Remove colliders for chunks that left physics range
    const nearbyKeys = new Set(nearbyChunks.map(c => c.gridKey));
    for (const [gridKey, colliderData] of this.colliders.entries()) {
      if (!nearbyKeys.has(gridKey)) {
        this.world.removeCollider(colliderData.collider, true);
        this.colliders.delete(gridKey);
      }
    }
  }

  /**
   * Get chunks within physics range of camera
   */
  private getNearbyChunks(cameraPosition: Vector3): Chunk[] {
    const range = this.config.physicsRange;
    const camGridX = Math.round(cameraPosition.x / this.chunkWidth);
    const camGridZ = Math.round(cameraPosition.z / this.chunkDepth);

    const chunks: Chunk[] = [];

    // Get all chunks from ChunkManager and filter by distance
    // Note: We need to access chunks from ChunkManager - this requires exposing them
    // For now, we'll use a helper method we'll add to ChunkManager
    for (let dx = -range; dx <= range; dx++) {
      for (let dz = -range; dz <= range; dz++) {
        const gridX = camGridX + dx;
        const gridZ = camGridZ + dz;
        const gridKey = `${gridX},${gridZ}`;
        
        const chunk = this.chunkManager.getChunk(gridKey);
        if (chunk) {
          chunks.push(chunk);
        }
      }
    }

    return chunks;
  }

  /**
   * Create a Rapier heightfield collider from a terrain mesh.
   * Returns null if mesh is not ready or geometry is invalid.
   */
  private createHeightfieldCollider(
    chunk: Chunk,
    mesh: ThreeMesh
  ): ChunkCollider | null {
    const geometry = mesh.geometry;
    const positions = geometry.attributes.position;

    if (!positions) {
      return null;
    }

    // Get mesh resolution from chunk's LOD level
    const lodLevel = chunk.currentLodLevel;
    const meshResolution = this.lodLevels[lodLevel] ?? this.lodLevels[0];
    const meshVertexCount = meshResolution + 1;
    const meshTotalVertices = meshVertexCount * meshVertexCount;

    if (positions.count !== meshTotalVertices) {
      console.warn(
        `[TerrainCollider] Mesh vertex count (${positions.count}) doesn't match expected (${meshTotalVertices}) for resolution ${meshResolution}`
      );
      return null;
    }

    // Use FIXED physics resolution (128 cells max) - Rapier can't handle 1M+ heights
    // We'll sample from the visual mesh at appropriate intervals
    const PHYSICS_RESOLUTION = 128; // 129x129 vertices = 16,641 heights (manageable)
    const numCells = Math.min(meshResolution, PHYSICS_RESOLUTION);
    const numVertices = numCells + 1;
    
    // Rapier expects heights as Float32Array
    const heights = new Float32Array(numVertices * numVertices);
    
    // Calculate sampling step if mesh is higher res than physics
    const sampleStep = meshResolution / numCells; // e.g., 1024/64 = 16
    let minHeight = Infinity;
    let maxHeight = -Infinity;

    // First, find the actual mesh bounds to understand coordinate system
    let meshMinX = Infinity, meshMaxX = -Infinity;
    let meshMinZ = Infinity, meshMaxZ = -Infinity;
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      meshMinX = Math.min(meshMinX, x);
      meshMaxX = Math.max(meshMaxX, x);
      meshMinZ = Math.min(meshMinZ, z);
      meshMaxZ = Math.max(meshMaxZ, z);
    }

    // Copy heights using X-major storage for Rapier (matching demo-rapier-three)
    // Sample from mesh at sampleStep intervals when mesh is higher res than physics
    // PlaneGeometry: col=X, row=Z (vertex index = row * meshVertexCount + col)
    // Rapier heightfield: index = X * stride + Z = col * numVertices + row
    for (let row = 0; row < numVertices; row++) {
      for (let col = 0; col < numVertices; col++) {
        // Sample from mesh at appropriate position (rounded to nearest vertex)
        const meshRow = Math.min(Math.round(row * sampleStep), meshVertexCount - 1);
        const meshCol = Math.min(Math.round(col * sampleStep), meshVertexCount - 1);
        const meshVertexIndex = meshRow * meshVertexCount + meshCol;
        
        const y = positions.getY(meshVertexIndex);
        const x = positions.getX(meshVertexIndex);
        const z = positions.getZ(meshVertexIndex);
        
        // Storage: index = X * stride + Z (matching demo-rapier-three)
        // col = X index, row = Z index
        const heightIndex = col * numVertices + row;
        heights[heightIndex] = y;
        minHeight = Math.min(minHeight, y);
        maxHeight = Math.max(maxHeight, y);
      }
    }

    // Validate heights array
    if (heights.length === 0) {
      console.error(`[TerrainCollider] Empty heights array for chunk ${chunk.gridKey}`);
      return null;
    }
    
    // Check for NaN or Infinity values
    let hasInvalidValues = false;
    for (let i = 0; i < heights.length; i++) {
      if (!Number.isFinite(heights[i])) {
        console.error(`[TerrainCollider] Invalid height value at index ${i}: ${heights[i]}`);
        hasInvalidValues = true;
        break;
      }
    }
    if (hasInvalidValues) {
      return null;
    }
    
    console.log(`[TerrainCollider] Using visual mesh resolution: ${numVertices}x${numVertices} vertices, ${numCells}x${numCells} cells, range: [${minHeight.toFixed(2)}, ${maxHeight.toFixed(2)}]`);

    // Create heightfield collider
    if (!RAPIER || !RAPIER.ColliderDesc) {
      console.error('[TerrainCollider] RAPIER not initialized');
      return null;
    }

    // Create scale as plain object (Rapier accepts {x, y, z} format)
    const scale = { x: this.chunkWidth, y: 1, z: this.chunkDepth };

    console.log(`[TerrainCollider] Creating heightfield: ${numCells}x${numCells} cells (${numVertices}x${numVertices} vertices), scale:`, scale);

    // Rapier heightfield API: ColliderDesc.heightfield(nrows, ncols, heights: Float32Array, scale: Vector)
    // IMPORTANT: nrows/ncols = number of CELLS, heights.length = (nrows+1)*(ncols+1) VERTICES
    let colliderDesc: RAPIER.ColliderDesc | null = null;
    try {
      colliderDesc = RAPIER.ColliderDesc.heightfield(numCells, numCells, heights, scale);
    } catch (e) {
      console.error(`[TerrainCollider] Exception creating heightfield for chunk ${chunk.gridKey}:`, e);
      return null;
    }
    
    if (!colliderDesc) {
      console.error(`[TerrainCollider] Failed to create heightfield collider for chunk ${chunk.gridKey}`);
      return null;
    }
    
    console.log(`[TerrainCollider] Heightfield collider created successfully for chunk ${chunk.gridKey}`);

    // Create static rigid body for the terrain
    if (!this.world) {
      console.error('[TerrainCollider] Physics world not available');
      return null;
    }

    // Position collider at chunk's world position
    const [gridX, gridZ] = parseGridKey(chunk.gridKey);
    const worldX = gridX * this.chunkWidth;
    const worldZ = gridZ * this.chunkDepth;
    
    // Rapier heightfield is CENTERED on rigid body position (see demo-rapier-three)
    // Mesh vertices are in local space, centered at origin (range: [-width/2, width/2])
    // Chunk center in world = (worldX, worldZ), so rigid body goes at center
    const offsetX = worldX;  // Center of chunk
    const offsetZ = worldZ;  // Center of chunk

    // Create rigid body at the correct position (like BallManager does)
    const rigidBodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(offsetX, 0, offsetZ);
    const rigidBody = this.world.createRigidBody(rigidBodyDesc);
    
    if (!rigidBody) {
      console.error(`[TerrainCollider] Failed to create rigid body for chunk ${chunk.gridKey}`);
      return null;
    }

    const collider = this.world.createCollider(colliderDesc, rigidBody);
    
    if (!collider) {
      console.error(`[TerrainCollider] Failed to create collider for chunk ${chunk.gridKey}`);
      this.world.removeRigidBody(rigidBody);
      return null;
    }

    // Log for debugging
    console.log(
      `[Physics] Chunk ${chunk.gridKey}: heights range [${minHeight.toFixed(2)}, ${maxHeight.toFixed(2)}], collider at (${offsetX.toFixed(1)}, 0, ${offsetZ.toFixed(1)})`
    );

    return {
      collider,
      gridKey: chunk.gridKey,
      lodLevel,
      minHeight,
      maxHeight,
    };
  }

  /**
   * Get number of active colliders
   */
  getActiveColliderCount(): number {
    return this.colliders.size;
  }

  /**
   * Clean up all colliders
   */
  dispose(): void {
    for (const colliderData of this.colliders.values()) {
      this.world.removeCollider(colliderData.collider, true);
    }
    this.colliders.clear();
  }
}
