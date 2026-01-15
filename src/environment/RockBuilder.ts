import { BufferGeometry, IcosahedronGeometry, Vector3 } from 'three';
import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import alea from 'alea';

/**
 * RockBuilder generates procedural rock geometries using ridge noise.
 * 
 * Algorithm:
 * 1. Start with IcosahedronGeometry for even vertex distribution
 * 2. Apply ridge noise: pow(1.0 - abs(noise3D(...)), 2.0) for sharp cracks
 * 3. Add secondary fine noise for surface detail
 * 4. Flatten Y-axis for resting appearance
 * 5. Recompute vertex normals
 */
export class RockBuilder {
  /**
   * Generate a single rock geometry with ridge noise displacement.
   * 
   * @param seed - Random seed for this rock
   * @param detail - Icosahedron subdivision level (0=12 verts, 1=42, 2=162, 3=642)
   * @returns BufferGeometry with displaced vertices
   */
  static generate(seed: number, detail: number = 2): BufferGeometry {
    // Create base icosahedron (unit radius)
    const geometry = new IcosahedronGeometry(1, detail);

    // Create seeded noise function
    const prng = alea(seed);
    const noise3D = createNoise3D(prng);

    // Randomize shape parameters based on seed
    const noiseFreq = 1.0 + prng() * 1.5;      // 1.0 - 2.5
    const noiseAmp = 0.2 + prng() * 0.3;       // 0.2 - 0.5
    const flattenY = 0.5 + prng() * 0.5;       // 0.5 - 1.0 (how squashed)
    const ridgeSharpness = 1.5 + prng() * 1.0; // 1.5 - 2.5 (ridge sharpness)

    // Access position attribute
    const positions = geometry.attributes.position;
    const count = positions.count;
    const vertex = new Vector3();

    for (let i = 0; i < count; i++) {
      vertex.fromBufferAttribute(positions, i);

      // Get normalized direction (for displacement along normal)
      const dir = vertex.clone().normalize();

      // 1. Ridge Noise: creates sharp valleys/cracks
      // Formula: pow(1.0 - abs(noise), power) creates sharp ridges
      const ridge = RockBuilder.ridgeNoise(
        noise3D,
        vertex.x * noiseFreq,
        vertex.y * noiseFreq,
        vertex.z * noiseFreq,
        ridgeSharpness
      );

      // 2. Standard simplex noise for overall shape variation
      const blobby = noise3D(
        vertex.x * noiseFreq * 0.5,
        vertex.y * noiseFreq * 0.5,
        vertex.z * noiseFreq * 0.5
      );

      // 3. Fine detail noise for surface texture
      const detail = noise3D(
        vertex.x * noiseFreq * 3.0,
        vertex.y * noiseFreq * 3.0,
        vertex.z * noiseFreq * 3.0
      );

      // Combine: ridge for chiseled look, blobby for macro form, detail for texture
      const displacement = (ridge * 0.4) + (blobby * 0.4) + (detail * 0.1);

      // Apply displacement along normal direction
      vertex.addScaledVector(dir, displacement * noiseAmp);

      // 4. Flatten Y-axis to make rock sit better on ground
      vertex.y *= flattenY;

      positions.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }

    // 5. Recompute normals for correct lighting
    geometry.computeVertexNormals();

    // Center geometry so scaling happens from center
    geometry.center();

    return geometry;
  }

  /**
   * Ridge noise function: creates sharp valleys/cracks.
   * Formula: pow(1.0 - abs(noise), power)
   */
  private static ridgeNoise(
    noise3D: NoiseFunction3D,
    x: number,
    y: number,
    z: number,
    power: number
  ): number {
    const n = noise3D(x, y, z);
    return Math.pow(1.0 - Math.abs(n), power);
  }

  /**
   * Generate a library of rock prototype geometries.
   * 
   * @param count - Number of prototypes to generate
   * @param baseDetail - Base subdivision level for icosahedron
   * @returns Array of BufferGeometry
   */
  static generateLibrary(count: number, baseDetail: number = 2): BufferGeometry[] {
    const library: BufferGeometry[] = [];

    for (let i = 0; i < count; i++) {
      // Use index as seed for reproducible rocks
      const geometry = RockBuilder.generate(i, baseDetail);
      library.push(geometry);
    }

    return library;
  }

  /**
   * Generate a rock with specific style parameters.
   * Allows more control over the rock's appearance.
   * 
   * @param seed - Random seed
   * @param options - Style options
   * @returns BufferGeometry
   */
  static generateWithOptions(
    seed: number,
    options: {
      detail?: number;
      noiseFreq?: number;
      noiseAmp?: number;
      flattenY?: number;
      ridgeSharpness?: number;
    } = {}
  ): BufferGeometry {
    const {
      detail = 2,
      noiseFreq = 1.5,
      noiseAmp = 0.35,
      flattenY = 0.7,
      ridgeSharpness = 2.0
    } = options;

    const geometry = new IcosahedronGeometry(1, detail);
    const prng = alea(seed);
    const noise3D = createNoise3D(prng);

    const positions = geometry.attributes.position;
    const count = positions.count;
    const vertex = new Vector3();

    for (let i = 0; i < count; i++) {
      vertex.fromBufferAttribute(positions, i);
      const dir = vertex.clone().normalize();

      const ridge = RockBuilder.ridgeNoise(
        noise3D,
        vertex.x * noiseFreq,
        vertex.y * noiseFreq,
        vertex.z * noiseFreq,
        ridgeSharpness
      );

      const blobby = noise3D(
        vertex.x * noiseFreq * 0.5,
        vertex.y * noiseFreq * 0.5,
        vertex.z * noiseFreq * 0.5
      );

      const detailNoise = noise3D(
        vertex.x * noiseFreq * 3.0,
        vertex.y * noiseFreq * 3.0,
        vertex.z * noiseFreq * 3.0
      );

      const displacement = (ridge * 0.4) + (blobby * 0.4) + (detailNoise * 0.1);
      vertex.addScaledVector(dir, displacement * noiseAmp);
      vertex.y *= flattenY;

      positions.setXYZ(i, vertex.x, vertex.y, vertex.z);
    }

    geometry.computeVertexNormals();
    geometry.center();

    return geometry;
  }
}
