import { BufferGeometry, InstancedMesh, MeshStandardMaterial, Matrix4, Color } from 'three';
import { RockBuilder } from './RockBuilder';
import type { RockPlacement } from '../terrain/ChunkWorker';

/**
 * RockManager pre-generates a library of rock prototype geometries
 * and creates InstancedMesh from worker-computed placement data.
 * 
 * No heavy computation on main thread - just assembles meshes from pre-computed data.
 */
export class RockManager {
  private prototypes: BufferGeometry[] = [];
  private material: MeshStandardMaterial;
  private librarySize: number;

  /**
   * Create a RockManager with a library of procedural rock prototypes.
   * 
   * @param librarySize - Number of unique rock shapes to generate (default: 30)
   */
  constructor(librarySize: number = 30) {
    this.librarySize = librarySize;

    // Create shared material for all rocks
    // flatShading: true gives that low-poly chiseled look
    this.material = new MeshStandardMaterial({
      color: new Color(0xcccccc),  // Lighter gray for visibility
      roughness: 0.85,             // Moon rocks are dusty/rough
      metalness: 0.1,
      flatShading: true,           // Chiseled appearance
    });

    // Generate prototype library at startup
    this.generatePrototypeLibrary();
  }

  /**
   * Generate the library of rock prototype geometries.
   * Called once at construction.
   */
  private generatePrototypeLibrary(): void {
    console.log(`Generating ${this.librarySize} rock prototypes...`);
    const startTime = performance.now();

    this.prototypes = RockBuilder.generateLibrary(this.librarySize, 2);

    const elapsed = performance.now() - startTime;
    console.log(`Rock prototypes generated in ${elapsed.toFixed(1)}ms`);
  }

  /**
   * Create InstancedMesh objects from worker-computed placement data.
   * 
   * @param placements - Array of rock placements from ChunkWorker
   * @returns Array of InstancedMesh (one per prototype that has placements)
   */
  createRockMeshes(placements: RockPlacement[]): InstancedMesh[] {
    const meshes: InstancedMesh[] = [];

    for (const placement of placements) {
      const { prototypeId, matrices } = placement;

      // Get prototype geometry (wrap around if prototypeId is out of range)
      const geometry = this.prototypes[prototypeId % this.prototypes.length];
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
  getMaterial(): MeshStandardMaterial {
    return this.material;
  }

  /**
   * Get a specific prototype geometry by index.
   * 
   * @param index - Prototype index (wraps around if > library size)
   */
  getPrototype(index: number): BufferGeometry | undefined {
    return this.prototypes[index % this.prototypes.length];
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    // Dispose all prototype geometries
    for (const geometry of this.prototypes) {
      geometry.dispose();
    }
    this.prototypes = [];

    // Dispose material
    this.material.dispose();
  }
}
