import { BufferGeometry, InstancedMesh, Matrix4 } from 'three';
import { RockBuilder } from './RockBuilder';
import { RockMaterial } from '../shaders/RockMaterial';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';
import type { RockPlacement } from '../terrain/ChunkWorker';

/**
 * RockManager pre-generates LOD-based libraries of rock prototype geometries
 * and creates InstancedMesh from worker-computed placement data.
 * 
 * Rock detail matches terrain LOD triangle area (2x-4x larger triangles on rocks).
 * No heavy computation on main thread - just assembles meshes from pre-computed data.
 */
export class RockManager {
  private prototypesByLod: BufferGeometry[][] = [];
  private material: RockMaterial;
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
   */
  private static getRockTriangleArea(detail: number, rockDiameter: number): number {
    const triangleCounts = [20, 80, 320, 1280, 5120]; // detail 0-4
    const triangles = triangleCounts[detail] ?? 20;
    const surfaceArea = Math.PI * Math.pow(rockDiameter / 2, 2);
    return surfaceArea / triangles;
  }

  /**
   * Find appropriate icosahedron detail level for a given LOD.
   * Returns detail level that gives 2x-4x larger triangles than terrain.
   * 
   * Strategy:
   * - For high LOD (close-up, high-res terrain): Use higher detail (detail=2-3)
   * - For low LOD (distant, low-res terrain): Use lower detail (detail=1-2)
   * - Never use detail=0 (too low poly, causes holes with scraping algorithm)
   * - Minimum detail=1 to ensure rocks look decent
   */
  private static getDetailForLod(
    lodLevel: number,
    chunkWidth: number,
    chunkDepth: number,
    lodLevels: number[],
    avgRockDiameter: number = 1.0
  ): number {
    const terrainArea = RockManager.getTerrainTriangleArea(lodLevel, chunkWidth, chunkDepth, lodLevels);
    const targetRockAreaMin = terrainArea * 2.0; // Minimum: 2x terrain
    const targetRockAreaMax = terrainArea * 4.0; // Maximum: 4x terrain
    
    const MIN_DETAIL = 3; // Never use detail < 3 (too low poly, creates ugly flat facets)
    const MAX_DETAIL = 3; // Cap at detail=3 for performance
    
    // Try each detail level from highest to lowest (within bounds)
    // We want the highest detail that still gives triangles 2x-4x larger than terrain
    for (let detail = MAX_DETAIL; detail >= MIN_DETAIL; detail--) {
      const rockArea = RockManager.getRockTriangleArea(detail, avgRockDiameter);
      
      // If this detail level gives triangles within the 2x-4x range, use it
      if (rockArea >= targetRockAreaMin && rockArea <= targetRockAreaMax) {
        return detail; // Perfect match
      }
      
      // If this detail gives triangles >= min, it's acceptable (prefer higher detail)
      if (rockArea >= targetRockAreaMin) {
        return detail;
      }
    }
    
    // If no detail level meets the minimum (low LOD with huge terrain triangles),
    // use the highest detail that's still reasonable (detail=1 minimum)
    // This ensures rocks look decent even at distance
    return MIN_DETAIL;
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
    this.material = new RockMaterial();
    this.material.setParam('enableCurvature', true);
    this.material.setParam('planetRadius', DEFAULT_PLANET_RADIUS);

    // Generate LOD-based prototype libraries at startup
    this.generatePrototypeLibraries();
  }

  /**
   * Generate LOD-based libraries of rock prototype geometries.
   * Each LOD level gets a library with appropriate detail to match terrain triangle area.
   * Called once at construction.
   */
  private generatePrototypeLibraries(): void {
    console.log(`Generating ${this.librarySize} rock prototypes per LOD level...`);
    const startTime = performance.now();

    const lodCount = this.lodLevels.length;
    for (let lod = 0; lod < lodCount; lod++) {
      const detail = RockManager.getDetailForLod(lod, this.chunkWidth, this.chunkDepth, this.lodLevels);
      console.log(`  LOD ${lod} (res=${this.lodLevels[lod]}): detail=${detail}`);
      this.prototypesByLod[lod] = RockBuilder.generateLibrary(this.librarySize, { detail });
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

    // Get prototypes for this LOD level (fallback to LOD 0 if out of range)
    const lodIndex = Math.min(lodLevel, this.prototypesByLod.length - 1);
    const prototypes = this.prototypesByLod[lodIndex] ?? this.prototypesByLod[0];
    if (!prototypes || prototypes.length === 0) {
      console.warn(`No prototypes available for LOD ${lodLevel}, using LOD 0`);
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
  getMaterial(): RockMaterial {
    return this.material;
  }

  /**
   * Get a specific prototype geometry by index and LOD level.
   * 
   * @param index - Prototype index (wraps around if > library size)
   * @param lodLevel - LOD level (default: 0)
   */
  getPrototype(index: number, lodLevel: number = 0): BufferGeometry | undefined {
    const lodIndex = Math.min(lodLevel, this.prototypesByLod.length - 1);
    const prototypes = this.prototypesByLod[lodIndex] ?? this.prototypesByLod[0];
    if (!prototypes) return undefined;
    return prototypes[index % prototypes.length];
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    // Dispose all prototype geometries across all LOD levels
    for (const prototypes of this.prototypesByLod) {
      for (const geometry of prototypes) {
        geometry.dispose();
      }
    }
    this.prototypesByLod = [];

    // Dispose material
    this.material.dispose();
  }
}
