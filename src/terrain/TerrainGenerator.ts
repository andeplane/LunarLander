import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Color, Vector3, Raycaster } from 'three';
import { MoonMaterial } from '../shaders/MoonMaterial';
import type { ChunkWorkerResult } from './ChunkWorker';
import { computeStitchedIndices } from './EdgeStitcher';
import type { NeighborLods } from './LodUtils';

/**
 * Configuration for terrain generation
 */
export interface TerrainGeneratorConfig {
  chunkWidth: number;
  chunkDepth: number;
  renderDistance: number;  // Maximum chunks to load in each direction
  planetRadius: number;    // Planet radius for curvature calculations
}

/**
 * TerrainGenerator creates terrain meshes from worker data and handles edge stitching.
 * No workers - ChunkManager owns those.
 */
export class TerrainGenerator {
  private material: MoonMaterial;
  private config: TerrainGeneratorConfig;
  private raycaster: Raycaster = new Raycaster();

  // Track original indices for edge stitching restoration
  // Key: "gridKey:lodLevel"
  private originalIndices: Map<string, Uint32Array> = new Map();

  constructor(config: TerrainGeneratorConfig) {
    this.config = config;
    // Single shared material instance for all chunks (critical for performance)
    this.material = new MoonMaterial();
  }

  /**
   * Create a terrain mesh from worker result data
   */
  createTerrainMesh(
    result: ChunkWorkerResult,
    debugMode: boolean,
    gridKey: string
  ): Mesh {
    const { positions, normals, index, biome } = result;

    // Create geometry
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(positions), 3)
    );
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array(normals), 3)
    );
    if (biome) {
      geometry.setAttribute(
        'biome',
        new BufferAttribute(new Float32Array(biome), 3)
      );
    }
    if (index) {
      geometry.setIndex(new BufferAttribute(new Uint32Array(index), 1));
    }

    // Compute bounding sphere for correct frustum culling
    geometry.computeBoundingSphere();

    // Expand bounding sphere to account for vertex shader curvature transformation
    if (!debugMode && this.material.getParam('enableCurvature')) {
      const planetRadius = this.config.planetRadius;

      // Calculate maximum camera distance: render distance * chunk width + original bounding sphere radius
      // This accounts for chunks at the edge of visibility
      const maxCameraDistance = this.config.renderDistance * this.config.chunkWidth 
                              + (geometry.boundingSphere?.radius ?? 50);
      
      // Maximum curvature drop based on maximum possible camera distance
      // Formula: drop = distance² / (2 * planetRadius)
      const maxCurvatureDrop = (maxCameraDistance * maxCameraDistance) / (2 * planetRadius);

      // Expand bounding sphere to encompass transformed geometry
      if (geometry.boundingSphere) {
        geometry.boundingSphere.center.y -= maxCurvatureDrop / 2;
        geometry.boundingSphere.radius += maxCurvatureDrop / 2;
      }
    }

    // Create mesh with appropriate material
    const material = debugMode
      ? this.createDebugMaterial(gridKey)
      : this.material;

    return new Mesh(geometry, material);
  }

  /**
   * Generate a color from a grid key (for debug visualization)
   */
  private generateChunkColor(gridKey: string): Color {
    let hash = 0;
    for (let i = 0; i < gridKey.length; i++) {
      hash = gridKey.charCodeAt(i) + ((hash << 5) - hash);
    }

    const r = ((hash & 0xFF0000) >> 16) % 200 + 55;
    const g = ((hash & 0x00FF00) >> 8) % 200 + 55;
    const b = (hash & 0x0000FF) % 200 + 55;

    return new Color(r / 255, g / 255, b / 255);
  }

  /**
   * Create a debug material for a specific chunk
   */
  private createDebugMaterial(gridKey: string): MeshBasicMaterial {
    const color = this.generateChunkColor(gridKey);
    return new MeshBasicMaterial({
      wireframe: true,
      color: color
    });
  }

  /**
   * Store original indices for a chunk/LOD for edge stitching restoration
   */
  storeOriginalIndices(gridKey: string, lodLevel: number, indices: Uint32Array): void {
    const key = `${gridKey}:${lodLevel}`;
    this.originalIndices.set(key, indices);
  }

  /**
   * Apply edge stitching to a terrain mesh based on neighbor LOD levels
   */
  applyEdgeStitching(
    gridKey: string,
    mesh: Mesh,
    lodLevel: number,
    neighborLods: NeighborLods,
    lodLevels: number[]
  ): void {
    const resolution = lodLevels[lodLevel];
    if (!resolution) return;

    // Check if stitching is needed (any neighbor has lower resolution = higher LOD index)
    const needsStitching =
      neighborLods.north > lodLevel ||
      neighborLods.south > lodLevel ||
      neighborLods.east > lodLevel ||
      neighborLods.west > lodLevel;

    const key = `${gridKey}:${lodLevel}`;

    if (!needsStitching) {
      // Restore original indices if we have them
      const original = this.originalIndices.get(key);
      if (original && mesh.geometry.index) {
        mesh.geometry.setIndex(new BufferAttribute(original.slice(), 1));
      }
      return;
    }

    // Compute stitched indices
    const stitchedIndices = computeStitchedIndices(
      resolution,
      neighborLods,
      lodLevel,
      lodLevels
    );

    // Apply to geometry
    mesh.geometry.setIndex(new BufferAttribute(stitchedIndices, 1));
  }

  /**
   * Clear stitching data for a chunk (called when chunk is disposed)
   */
  clearStitchingData(gridKey: string): void {
    // Remove all LOD level entries for this chunk
    for (const key of this.originalIndices.keys()) {
      if (key.startsWith(`${gridKey}:`)) {
        this.originalIndices.delete(key);
      }
    }
  }

  /**
   * Raycast to find terrain height at a given world position
   */
  raycastHeight(x: number, z: number, mesh: Mesh): number | null {
    // Ensure world matrix is up to date for accurate raycasting
    mesh.updateMatrixWorld(true);

    // Start ray far above terrain
    const rayOrigin = new Vector3(x, 10000, z);
    const rayDirection = new Vector3(0, -1, 0);
    this.raycaster.set(rayOrigin, rayDirection);

    const intersects = this.raycaster.intersectObject(mesh, false);
    if (intersects.length > 0) {
      return intersects[0].point.y;
    }

    return null;
  }

  /**
   * Get the shared material instance (for UI control)
   */
  getMaterial(): MoonMaterial {
    return this.material;
  }

  /**
   * Update sun direction for horizon occlusion calculation
   * Should be called each frame with the current sun direction in world space
   * 
   * @param direction Sun direction vector (normalized, in world space)
   */
  setSunDirection(direction: Vector3): void {
    this.material.setSunDirection(direction);
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.material.dispose();
    this.originalIndices.clear();
  }
}
