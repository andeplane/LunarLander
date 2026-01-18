import { BufferGeometry, InstancedMesh, Matrix4, Vector3 } from 'three';
import { RockBuilder } from './RockBuilder';
import { MoonMaterial } from '../shaders/MoonMaterial';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';
import type { RockPlacement } from '../terrain/ChunkWorker';

/**
 * RockManager pre-generates LOD-based libraries of rock prototype geometries
 * and creates InstancedMesh from worker-computed placement data.
 * 
 * Rock detail is mapped directly to chunk LOD level:
 * - LOD 0-1: detail 5 (20480 triangles) for closest chunks
 * - LOD 2-3: detail 4 (5120 triangles) for medium chunks
 * - LOD 4+: detail 3 (1280 triangles) for distant chunks
 * 
 * No heavy computation on main thread - just assembles meshes from pre-computed data.
 */
export class RockManager {
  // Store prototypes by detail level (3, 4, 5) instead of LOD level
  // This avoids generating duplicate libraries for LODs that share the same detail level
  private prototypesByDetail: Map<number, BufferGeometry[]> = new Map();
  // Store stable axes (principal axes) for each prototype by detail level
  // Each entry is an array of Vector3, one per prototype
  private stableAxesByDetail: Map<number, Vector3[]> = new Map();
  private material: MoonMaterial;
  private librarySize: number;
  private chunkWidth: number;
  private chunkDepth: number;
  private lodLevels: number[];
  private renderDistance: number;
  private planetRadius: number;

  /**
   * Get triangle count for a given detail level.
   * Formula: 20 * (detail + 1)^2
   */
  static getTriangleCount(detail: number): number {
    return 20 * Math.pow(detail + 1, 2);
  }

  /**
   * Find appropriate icosahedron detail level for a given LOD.
   * Uses direct LOD-to-detail mapping prioritizing visual quality.
   * 
   * Note: LOD 0 = highest detail terrain (1024 resolution), LOD 8 = lowest detail (4 resolution)
   * Closest chunks get maximum detail, distant chunks get lower detail for performance.
   * 
   * Triangle count formula: 20 * (detail + 1)^2
   * 
   * Strategy:
   * - LOD 0-1 (closest chunks): detail 15 (~5120 triangles) - maximum quality
   * - LOD 2-3 (medium chunks): detail 10 (~2420 triangles) - high quality
   * - LOD 4+ (distant chunks): detail 7 (~1280 triangles) - lower detail for performance
   */
  static getDetailForLod(
    lodLevel: number,
    _chunkWidth: number,
    _chunkDepth: number,
    _lodLevels: number[],
    _avgRockDiameter: number = 1.0
  ): number {
    // Direct LOD-to-detail mapping prioritizing visual quality
    // Note: LOD 0 = highest detail (1024), LOD 8 = lowest detail (4)
    // Closest chunks get maximum detail, distant chunks get lower detail
    if (lodLevel <= 1) {
      return 15; // LOD 0-1: detail 15 (~5120 triangles) for closest chunks
    } else if (lodLevel <= 3) {
      return 10; // LOD 2-3: detail 10 (~2420 triangles) for medium chunks
    } else {
      return 7; // LOD 4+: detail 7 (~1280 triangles) for distant chunks
    }
  }

  /**
   * Create a RockManager with LOD-based libraries of procedural rock prototypes.
   * 
   * @param librarySize - Number of unique rock shapes to generate per LOD (default: 30)
   * @param chunkWidth - Chunk width in meters (default: 100)
   * @param chunkDepth - Chunk depth in meters (default: 100)
   * @param lodLevels - Terrain LOD resolution levels (default: [1024, 512, 256, 128, 64, 32, 16, 8, 4])
   * @param renderDistance - Maximum chunks to load in each direction (default: 20)
   * @param planetRadius - Planet radius for curvature calculations (default: 5000)
   */
  constructor(
    librarySize: number = 30,
    chunkWidth: number = 100,
    chunkDepth: number = 100,
    lodLevels: number[] = [1024, 512, 256, 128, 64, 32, 16, 8, 4],
    renderDistance: number = 20,
    planetRadius: number = DEFAULT_PLANET_RADIUS
  ) {
    this.librarySize = librarySize;
    this.chunkWidth = chunkWidth;
    this.chunkDepth = chunkDepth;
    this.lodLevels = lodLevels;
    this.renderDistance = renderDistance;
    this.planetRadius = planetRadius;

    // Create shared material for all rocks with curvature support
    // Use MoonMaterial so rocks match terrain appearance
    this.material = new MoonMaterial();
    this.material.setParam('enableColorVariation', true); // Match terrain
    this.material.setParam('enableCurvature', true);
    this.material.setParam('planetRadius', planetRadius);

    // Generate LOD-based prototype libraries at startup
    this.generatePrototypeLibraries();
  }

  /**
   * Generate rock prototype libraries by detail level.
   * Only generates unique libraries (detail 7, 10, 15) to avoid duplicates.
   * Called once at construction.
   * 
   * Triangle counts use formula: 20 * (detail + 1)^2
   * - Detail 7: 1280 triangles
   * - Detail 10: 2420 triangles  
   * - Detail 15: 5120 triangles
   */
  private generatePrototypeLibraries(): void {
    console.log(`Generating ${this.librarySize} rock prototypes per detail level...`);
    const startTime = performance.now();

    // Generate only unique detail levels (7, 10, 15)
    // Multiple LOD levels share the same detail level, so we avoid duplicate generation
    const detailLevels = [7, 10, 15];
    for (const detail of detailLevels) {
      const expectedTriangles = RockManager.getTriangleCount(detail);
      console.log(`  Detail ${detail} (~${expectedTriangles} triangles)`);
      const libraries = RockBuilder.generateLibrary(this.librarySize, { detail });
      this.prototypesByDetail.set(detail, libraries);

      // Calculate and store stable axes for each prototype
      const stableAxes: Vector3[] = [];
      for (const geometry of libraries) {
        const stableAxis = RockBuilder.calculateStableAxis(geometry);
        stableAxes.push(stableAxis);
      }
      this.stableAxesByDetail.set(detail, stableAxes);
    }

    const elapsed = performance.now() - startTime;
    console.log(`Rock prototype libraries generated in ${elapsed.toFixed(1)}ms`);
  }

  /**
   * Get stable axes (principal axes) for prototypes at a given detail level.
   * 
   * @param detailLevel - Detail level (7, 10, or 15)
   * @returns Array of Vector3 representing stable axes, one per prototype
   */
  getStableAxesForDetail(detailLevel: number): Vector3[] | undefined {
    return this.stableAxesByDetail.get(detailLevel);
  }

  /**
   * Create InstancedMesh objects from worker-computed placement data.
   * 
   * @param placements - Array of rock placements from ChunkWorker
   * @param lodLevel - LOD level to use for selecting appropriate detail library
   * @returns Array of InstancedMesh (one per prototype that has placements)
   */
  createRockMeshes(placements: RockPlacement[], lodLevel: number): InstancedMesh[] {
    const meshes: InstancedMesh[] = [];

    // Map LOD level to detail level
    const detail = RockManager.getDetailForLod(lodLevel, this.chunkWidth, this.chunkDepth, this.lodLevels);
    const prototypes = this.prototypesByDetail.get(detail) ?? this.prototypesByDetail.get(7);
    if (!prototypes || prototypes.length === 0) {
      console.warn(`No prototypes available for detail ${detail} (LOD ${lodLevel})`);
      return meshes;
    }

    for (const placement of placements) {
      const { prototypeId, matrices } = placement;

      // Get prototype geometry (wrap around if prototypeId is out of range)
      const geometry = prototypes[prototypeId % prototypes.length];
      if (!geometry) {
        continue;
      }

      // Calculate instance count from matrix array
      // Each Matrix4 is 16 floats
      const instanceCount = matrices.length / 16;
      if (instanceCount === 0) {
        continue;
      }

      // Create instanced mesh
      const mesh = new InstancedMesh(geometry, this.material, instanceCount);

      // Set instance matrices from flat array
      const matrix = new Matrix4();
      for (let i = 0; i < instanceCount; i++) {
        // Extract 16 floats for this instance
        const offset = i * 16;
        matrix.fromArray(matrices, offset);
        mesh.setMatrixAt(i, matrix);
      }

      // Mark instance matrix as needing update
      mesh.instanceMatrix.needsUpdate = true;

      // Compute bounding sphere for frustum culling
      mesh.computeBoundingSphere();

      // Expand bounding sphere to account for vertex shader curvature transformation
      if (this.material.getParam('enableCurvature') && mesh.boundingSphere) {
        // Calculate maximum possible distance from camera to any vertex
        // Worst case: camera at one corner of its chunk, vertex at opposite corner of furthest chunk
        // Chunks are centered at integer multiples, so furthest chunk center is at renderDistance chunks away
        // Camera can be at (-chunkWidth/2, -chunkDepth/2), vertex at (renderDistance*chunkWidth + chunkWidth/2, renderDistance*chunkDepth + chunkDepth/2)
        // Distance = (renderDistance + 1) * chunkWidth in each dimension
        const maxChunkDistance = Math.sqrt(
          Math.pow((this.renderDistance + 1) * this.chunkWidth, 2) +
          Math.pow((this.renderDistance + 1) * this.chunkDepth, 2)
        );
        
        // Maximum curvature drop based on maximum possible camera distance
        // Formula: drop = distance² / (2 * planetRadius)
        const maxCurvatureDrop = (maxChunkDistance * maxChunkDistance) / (2 * this.planetRadius);

        // Expand bounding sphere to encompass transformed geometry
        mesh.boundingSphere.center.y -= maxCurvatureDrop / 2;
        mesh.boundingSphere.radius += maxCurvatureDrop / 2;
      }

      // Enable frustum culling per instance
      mesh.frustumCulled = true;

      meshes.push(mesh);
    }

    return meshes;
  }

  /**
   * Get the number of rock prototypes in the library.
   * Needed by ChunkWorker to assign prototypeIds.
   */
  getLibrarySize(): number {
    return this.librarySize;
  }

  /**
   * Get the shared rock material.
   */
  getMaterial(): MoonMaterial {
    return this.material;
  }

  /**
   * Get a specific prototype geometry by index and LOD level.
   * 
   * @param index - Prototype index (wraps around if > library size)
   * @param lodLevel - LOD level (default: 0)
   */
  getPrototype(index: number, lodLevel: number = 0): BufferGeometry | undefined {
    const detail = RockManager.getDetailForLod(lodLevel, this.chunkWidth, this.chunkDepth, this.lodLevels);
    const prototypes = this.prototypesByDetail.get(detail) ?? this.prototypesByDetail.get(7);
    if (!prototypes) return undefined;
    return prototypes[index % prototypes.length];
  }

  /**
   * Get all prototype geometries for a given detail level.
   * Used by GlobalRockBatcher for instanced rendering.
   * 
   * @param detailLevel - Detail level (7, 10, or 15)
   */
  getPrototypesForDetail(detailLevel: number): BufferGeometry[] | undefined {
    return this.prototypesByDetail.get(detailLevel);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    // Dispose all prototype geometries across all detail levels
    for (const prototypes of this.prototypesByDetail.values()) {
      for (const geometry of prototypes) {
        geometry.dispose();
      }
    }
    this.prototypesByDetail.clear();

    // Dispose material
    this.material.dispose();
  }
}
