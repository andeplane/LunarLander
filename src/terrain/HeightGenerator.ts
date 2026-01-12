/**
 * Height generator responsible for:
 * - Deterministic terrain height generation
 * - Multi-octave noise composition
 * - Height query API for any world position
 * - Single source of truth for terrain height
 */

import { createNoise2D } from 'simplex-noise';

/**
 * Terrain layer configuration
 * Must match the layers in meshGeneration.ts for consistency
 */
interface TerrainLayer {
  amplitude: number;    // Height contribution in meters
  wavelength: number;   // Horizontal scale in meters
}

/**
 * Terrain layers - same configuration as meshGeneration.ts
 * These are the full-detail layers (equivalent to highest LOD)
 */
const TERRAIN_LAYERS: TerrainLayer[] = [
  // Large-scale: highlands/maria variation
  { amplitude: 800, wavelength: 15000 },
  { amplitude: 400, wavelength: 8000 },
  
  // Medium-scale: hills and ridges
  { amplitude: 60, wavelength: 1500 },
  { amplitude: 30, wavelength: 600 },
  
  // Small-scale: rocks and surface roughness  
  { amplitude: 8, wavelength: 80 },
  { amplitude: 4, wavelength: 30 },
  
  // Fine detail: regolith texture
  { amplitude: 0.3, wavelength: 4 },
  { amplitude: 0.1, wavelength: 1 },
];

// Create seeded PRNG for noise initialization
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export class HeightGenerator {
  private noise2D: (x: number, y: number) => number;

  constructor(seed: number = 12345) {
    // Initialize noise with the same seeding algorithm as meshGeneration.ts
    this.noise2D = createNoise2D(seededRandom(seed));
  }

  /**
   * Get height at world position (x, z)
   * This is the single source of truth for terrain height
   * Uses full detail (all terrain layers)
   */
  getHeightAt(x: number, z: number): number {
    let height = 0;
    
    for (const layer of TERRAIN_LAYERS) {
      const nx = x / layer.wavelength;
      const nz = z / layer.wavelength;
      const noiseValue = this.noise2D(nx, nz); // Returns [-1, 1]
      
      height += noiseValue * layer.amplitude;
    }
    
    return height;
  }

  /**
   * Generate height data for a chunk
   * Useful for pre-computing height grids
   */
  generateChunkHeightData(
    chunkX: number,
    chunkZ: number,
    resolution: number,
    chunkSize: number
  ): Float32Array {
    const heightData = new Float32Array(resolution * resolution);
    
    const worldOffsetX = chunkX * chunkSize;
    const worldOffsetZ = chunkZ * chunkSize;
    const step = chunkSize / (resolution - 1);
    
    let index = 0;
    for (let z = 0; z < resolution; z++) {
      for (let x = 0; x < resolution; x++) {
        const worldX = worldOffsetX + x * step;
        const worldZ = worldOffsetZ + z * step;
        heightData[index++] = this.getHeightAt(worldX, worldZ);
      }
    }
    
    return heightData;
  }
}
