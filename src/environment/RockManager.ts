import { BufferGeometry, InstancedMesh, Matrix4 } from 'three';
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
  private material: MoonMaterial;
  private librarySize: number;
  private chunkWidth: number;
  private chunkDepth: number;
  private lodLevels: number[];

  /**
   * Calculate terrain triangle area for a given LOD level.
   */
  private static getTerrainTriangleArea(
    lodLevel: number,
    chunkWidth: number,
    chunkDepth: number,
    lodLevels: number[]
  ): number {
    const resolution = lodLevels[lodLevel] ?? lodLevels[lodLevels.length - 1];
    const trianglesPerChunk = 2 * resolution * resolution;
    return (chunkWidth * chunkDepth) / trianglesPerChunk;
  }

  /**
   * Calculate rock triangle area for icosahedron detail level.
   * 
   * Note: The actual triangle count formula is 20*(detail+1)^2, NOT 20*4^detail.
   * This is because the geometry uses a quadratic subdivision pattern.
   */
  private static getRockTriangleArea(detail: number, rockDiameter: number): number {
    // Actual formula: 20 * (detail + 1)^2
    const triangles = 20 * Math.pow(detail + 1, 2);
    const surfaceArea = Math.PI * Math.pow(rockDiameter / 2, 2);
    return surfaceArea / triangles;
  }

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
   */
  constructor(
    librarySize: number = 30,
    chunkWidth: number = 100,
    chunkDepth: number = 100,
    lodLevels: number[] = [1024, 512, 256, 128, 64, 32, 16, 8, 4]
  ) {
    this.librarySize = librarySize;
    this.chunkWidth = chunkWidth;
    this.chunkDepth = chunkDepth;
    this.lodLevels = lodLevels;

    // Create shared material for all rocks with curvature support
    // Use MoonMaterial so rocks match terrain appearance
    this.material = new MoonMaterial();
    this.material.setParam('enableColorVariation', true); // Match terrain
    this.material.setParam('enableCurvature', true);
    this.material.setParam('planetRadius', DEFAULT_PLANET_RADIUS);

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
    }

    const elapsed = performance.now() - startTime;
    console.log(`Rock prototype libraries generated in ${elapsed.toFixed(1)}ms`);
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
