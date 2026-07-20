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
import { effectivePhysicsResolution, sampleHeightfield } from './HeightfieldUtils';

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
  /** Fixed rigid body the collider is attached to (must be removed with it) */
  rigidBody: RAPIER.RigidBody;
  gridKey: string;
  lodLevel: number;
  /** Effective heightfield resolution (cells) used for this collider */
  physicsResolution: number;
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
      // The collider downsamples the mesh to a capped physics resolution, so a
      // LOD change only requires a rebuild if the effective resolution differs
      // (e.g. 1024 <-> 512 flips both sample the same 128-cell heightfield).
      const meshResolution =
        this.lodLevels[chunk.currentLodLevel] ?? this.lodLevels[0];
      const physicsResolution = effectivePhysicsResolution(meshResolution);
      const needsRebuild =
        !existing || existing.physicsResolution !== physicsResolution;

      if (needsRebuild) {
        // Build-then-swap: only replace the old collider once the new one is
        // valid, so a failed rebuild never leaves the chunk colliderless
        const collider = this.createHeightfieldCollider(chunk, mesh);
        if (collider) {
          if (existing) {
            this.removeChunkCollider(existing);
          }
          this.colliders.set(chunk.gridKey, collider);
        }
        // On failure the previous collider (if any) is kept so balls don't
        // fall through; the rebuild retries once the mesh becomes valid.
      } else if (existing.lodLevel !== chunk.currentLodLevel) {
        // Same effective heightfield, just track the new LOD level
        existing.lodLevel = chunk.currentLodLevel;
      }
    }

    // Remove colliders for chunks that left physics range
    const nearbyKeys = new Set(nearbyChunks.map(c => c.gridKey));
    for (const [gridKey, colliderData] of this.colliders.entries()) {
      if (!nearbyKeys.has(gridKey)) {
        this.removeChunkCollider(colliderData);
        this.colliders.delete(gridKey);
      }
    }
  }

  /**
   * Remove a chunk collider AND its fixed rigid body from the physics world.
   * Removing the rigid body also removes its attached collider, so this frees
   * both WASM-side objects (previously the body was leaked on every rebuild).
   */
  private removeChunkCollider(colliderData: ChunkCollider): void {
    this.world.removeRigidBody(colliderData.rigidBody);
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

    // Sample the visual mesh down to the capped physics resolution
    // (Rapier can't handle 1M+ heights; 129x129 vertices is manageable)
    const numCells = effectivePhysicsResolution(meshResolution);
    const sample = sampleHeightfield(
      (i) => positions.getY(i),
      meshResolution,
      numCells
    );

    if (!sample) {
      console.error(
        `[TerrainCollider] Mesh for chunk ${chunk.gridKey} contains non-finite heights`
      );
      return null;
    }

    const { heights, minHeight, maxHeight } = sample;

    // Create heightfield collider
    if (!RAPIER || !RAPIER.ColliderDesc) {
      console.error('[TerrainCollider] RAPIER not initialized');
      return null;
    }

    // Create scale as plain object (Rapier accepts {x, y, z} format)
    const scale = { x: this.chunkWidth, y: 1, z: this.chunkDepth };

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

    return {
      collider,
      rigidBody,
      gridKey: chunk.gridKey,
      lodLevel,
      physicsResolution: numCells,
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
      this.removeChunkCollider(colliderData);
    }
    this.colliders.clear();
  }
}
