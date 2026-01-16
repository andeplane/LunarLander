import { BufferGeometry, IcosahedronGeometry, Vector3 } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import alea from 'alea';

/**
 * RockBuilder generates procedural rock geometries using the scraping algorithm.
 * 
 * Algorithm (based on gl-rock):
 * 1. Start with IcosahedronGeometry for uniform triangulation (no UV seams)
 * 2. Merge vertices to weld duplicates (ensures flood-fill works correctly)
 * 3. Build vertex adjacency from faces
 * 4. Randomly select scrape points with varied parameters
 * 5. Project nearby vertices onto planes (creates flat facets)
 * 6. Apply fBm noise for final variation
 * 7. Recompute smooth vertex normals
 * 
 * This creates realistic angular rocks with flat faces and rounded areas.
 */
export class RockBuilder {
  // Reusable temp vectors (avoid GC pressure in hot loops)
  private static readonly _v1 = new Vector3();


  /**
   * Project point p onto plane defined by normal n and point r0.
   * Uses scalar math to avoid allocations.
   */
  private static project(
    nx: number, ny: number, nz: number,
    r0x: number, r0y: number, r0z: number,
    px: number, py: number, pz: number,
    out: Vector3
  ): void {
    // Formula: project p onto plane = p + n * dot(n, r0 - p) / dot(n, n)
    const dx = r0x - px;
    const dy = r0y - py;
    const dz = r0z - pz;
    const dotN = nx * nx + ny * ny + nz * nz;
    const t = (nx * dx + ny * dy + nz * dz) / dotN;
    
    out.set(
      px + nx * t,
      py + ny * t,
      pz + nz * t
    );
  }

  /**
   * Accumulate scrape displacement for a vertex.
   * Instead of directly projecting, accumulates weighted displacement that will be blended.
   * This prevents holes from overlapping scrapes projecting vertices to different planes.
   */
  private static accumulateScrapeDisplacement(
    positionIndex: number,
    originalPositions: Float32Array,
    normals: Float32Array,
    displacements: Float32Array,
    weights: Float32Array,
    strength: number,
    radius: number
  ): void {
    const vertexCount = originalPositions.length / 3;
    
    // Get center position from ORIGINAL positions
    const cx = originalPositions[positionIndex * 3];
    const cy = originalPositions[positionIndex * 3 + 1];
    const cz = originalPositions[positionIndex * 3 + 2];
    
    // Get normal (use original position's normal)
    let nx = normals[positionIndex * 3];
    let ny = normals[positionIndex * 3 + 1];
    let nz = normals[positionIndex * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx /= len;
    ny /= len;
    nz /= len;
    
    // r0 is a point on the plane (offset by strength along normal)
    const r0x = cx - nx * strength;
    const r0y = cy - ny * strength;
    const r0z = cz - nz * strength;
    
    const radiusSq = radius * radius;
    let verticesAffected = 0;
    
    for (let i = 0; i < vertexCount; i++) {
      // Get ORIGINAL vertex position
      const origPx = originalPositions[i * 3];
      const origPy = originalPositions[i * 3 + 1];
      const origPz = originalPositions[i * 3 + 2];
      
      // Check if ORIGINAL vertex position is within radius
      const dx = origPx - cx;
      const dy = origPy - cy;
      const dz = origPz - cz;
      const distSq = dx * dx + dy * dy + dz * dz;
      
      if (distSq < radiusSq) {
        // Calculate weight based on distance (closer = higher weight)
        const dist = Math.sqrt(distSq);
        const normalizedDist = dist / radius; // 0 to 1
        // Use smooth falloff (1 at center, 0 at edge)
        const weight = 1.0 - (normalizedDist * normalizedDist); // Quadratic falloff
        
        // Project original position onto plane
        RockBuilder.project(nx, ny, nz, r0x, r0y, r0z, origPx, origPy, origPz, RockBuilder._v1);
        
        // Calculate displacement from original position
        const dispX = RockBuilder._v1.x - origPx;
        const dispY = RockBuilder._v1.y - origPy;
        const dispZ = RockBuilder._v1.z - origPz;
        
        // Accumulate weighted displacement
        displacements[i * 3] += dispX * weight;
        displacements[i * 3 + 1] += dispY * weight;
        displacements[i * 3 + 2] += dispZ * weight;
        weights[i] += weight;
        
        verticesAffected++;
      }
    }
  }


  /**
   * Fractal Brownian Motion (fBm) noise with multiple octaves.
   * Creates more natural, rocky texture than single octave.
   */
  private static fbm(
    noise3D: NoiseFunction3D,
    x: number,
    y: number,
    z: number,
    octaves: number = 3
  ): number {
    let value = 0;
    let amplitude = 1;
    let frequency = 1;
    let maxValue = 0;
    
    for (let i = 0; i < octaves; i++) {
      value += amplitude * noise3D(x * frequency, y * frequency, z * frequency);
      maxValue += amplitude;
      amplitude *= 0.5;
      frequency *= 2;
    }
    
    return value / maxValue;
  }

  /**
   * Create base geometry with IcosahedronGeometry and merge vertices.
   * This ensures uniform triangulation and no duplicate vertices.
   * 
   * Note: Triangle count follows formula 20*(detail+1)^2, not 20*4^detail.
   */
  private static createBaseGeometry(detail: number = 3): BufferGeometry {
    const baseGeometry = new IcosahedronGeometry(1, detail);
    // Merge vertices to weld any duplicates (critical for flood-fill)
    // mergeVertices returns BufferGeometry (loses specific geometry type)
    const merged = mergeVertices(baseGeometry, 1e-6);
    return merged;
  }

  /**
   * Apply scraping and noise to a geometry (modifies in place).
   * Separated for reuse in generateLibrary().
   */
  private static applyScrapingAndNoise(
    geometry: BufferGeometry,
    seed: number,
    options: {
      scrapeCount?: number;
      scrapeMinDist?: number;
      scrapeStrength?: number;
      scrapeRadius?: number;
      noiseScale?: number;
      noiseStrength?: number;
      scale?: [number, number, number];
    } = {}
  ): void {
    const {
      scrapeCount = 7,
      scrapeMinDist = 0.8,
      scrapeStrength = 0.2,
      scrapeRadius = 0.6, // Increased from 0.4 to affect more vertices and create smoother transitions
      noiseScale = 2.0,
      noiseStrength = 0.15, // Increased from 0.1 to smooth out flat facets
      scale = [1, 1, 0.7],
    } = options;

    // Create seeded PRNG
    const prng = alea(seed);
    const noise3D = createNoise3D(prng);

    // Get position and normal arrays
    const positions = geometry.attributes.position;
    const normals = geometry.attributes.normal;
    const positionArray = positions.array as Float32Array;
    const normalArray = normals.array as Float32Array;
    const vertexCount = positions.count;

    // Store original positions BEFORE any scraping to prevent holes from overlapping scrapes
    const originalPositions = new Float32Array(positionArray);

    // Randomly select scrape positions (using original positions)
    const scrapeIndices: number[] = [];
    const scrapePositions: number[] = []; // Store as flat array [x, y, z, ...]

    for (let i = 0; i < scrapeCount; i++) {
      let attempts = 0;
      let found = false;

      while (!found && attempts < 100) {
        const randIndex = Math.floor(prng() * vertexCount);
        const px = originalPositions[randIndex * 3];
        const py = originalPositions[randIndex * 3 + 1];
        const pz = originalPositions[randIndex * 3 + 2];

        // Check minimum distance from other scrape points (scalar math)
        let tooClose = false;
        for (let j = 0; j < scrapePositions.length; j += 3) {
          const ex = scrapePositions[j];
          const ey = scrapePositions[j + 1];
          const ez = scrapePositions[j + 2];
          const dx = px - ex;
          const dy = py - ey;
          const dz = pz - ez;
          const distSq = dx * dx + dy * dy + dz * dz;
          
          if (distSq < scrapeMinDist * scrapeMinDist) {
            tooClose = true;
            break;
          }
        }

        if (!tooClose) {
          scrapeIndices.push(randIndex);
          scrapePositions.push(px, py, pz);
          found = true;
        }
        attempts++;
      }
    }

    // Accumulate displacements from all scrapes to prevent holes from overlapping projections
    // Each vertex accumulates weighted displacements from all affecting scrapes
    const displacements = new Float32Array(vertexCount * 3); // [dx, dy, dz, ...]
    const weights = new Float32Array(vertexCount); // Total weight per vertex
    
    // Apply scraping at selected positions with randomized parameters
    for (const scrapeIndex of scrapeIndices) {
      // Randomize strength and radius per scrape for natural variation
      const localStrength = scrapeStrength * (0.6 + 0.8 * prng());
      const localRadius = scrapeRadius * (0.6 + 1.2 * prng());
      
      RockBuilder.accumulateScrapeDisplacement(
        scrapeIndex,
        originalPositions,
        normalArray,
        displacements,
        weights,
        localStrength,
        localRadius
      );
    }
    
    // Apply accumulated displacements with normalization
    for (let i = 0; i < vertexCount; i++) {
      const w = weights[i];
      if (w > 0) {
        // Normalize by total weight to get smooth blend
        positionArray[i * 3] = originalPositions[i * 3] + displacements[i * 3] / w;
        positionArray[i * 3 + 1] = originalPositions[i * 3 + 1] + displacements[i * 3 + 1] / w;
        positionArray[i * 3 + 2] = originalPositions[i * 3 + 2] + displacements[i * 3 + 2] / w;
      }
    }

    // Recompute normals after scraping (before noise) so noise displacement uses correct normals
    geometry.computeVertexNormals();
    // Update normal array reference after recomputation
    const updatedNormalArray = geometry.attributes.normal.array as Float32Array;

    // Apply final fBm noise distortion (scalar math, zero allocations)
    for (let i = 0; i < vertexCount; i++) {
      const px = positionArray[i * 3];
      const py = positionArray[i * 3 + 1];
      const pz = positionArray[i * 3 + 2];

      // Apply fBm noise (2-3 octaves for rocky texture)
      const noise = noiseStrength * RockBuilder.fbm(
        noise3D,
        px * noiseScale,
        py * noiseScale,
        pz * noiseScale,
        3
      );

      // Displace along normal (scalar math) - use updated normals after scraping
      const nx = updatedNormalArray[i * 3];
      const ny = updatedNormalArray[i * 3 + 1];
      const nz = updatedNormalArray[i * 3 + 2];
      
      const newX = px + nx * noise;
      const newY = py + ny * noise;
      const newZ = pz + nz * noise;

      // Apply scale (flatten Y for resting appearance)
      positionArray[i * 3] = newX * scale[0];
      positionArray[i * 3 + 1] = newY * scale[1];
      positionArray[i * 3 + 2] = newZ * scale[2];
    }

    // Mark attributes as dirty for GPU upload
    positions.needsUpdate = true;
    normals.needsUpdate = true;

    // Recompute smooth normals one final time after noise
    geometry.computeVertexNormals();

    // Compute bounds for frustum culling
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    // Center geometry
    geometry.center();
  }

  /**
   * Generate a single rock geometry using scraping algorithm.
   * 
   * @param seed - Random seed for this rock
   * @param options - Rock generation options
   * @returns BufferGeometry with scraped vertices
   */
  static generate(
    seed: number,
    options: {
      detail?: number;
      scrapeCount?: number;
      scrapeMinDist?: number;
      scrapeStrength?: number;
      scrapeRadius?: number;
      noiseScale?: number;
      noiseStrength?: number;
      scale?: [number, number, number];
    } = {}
  ): BufferGeometry {
    const { detail = 3 } = options;

    // Create base geometry
    const geometry = RockBuilder.createBaseGeometry(detail);

    // Apply scraping and noise
    RockBuilder.applyScrapingAndNoise(geometry, seed, options);

    return geometry;
  }

  /**
   * Generate a library of rock prototype geometries.
   * Optimized: reuses base geometry topology and adjacency for performance.
   * 
   * @param count - Number of prototypes to generate
   * @param options - Rock generation options (optional)
   * @returns Array of BufferGeometry
   */
  static generateLibrary(
    count: number,
    options?: {
      detail?: number;
      scrapeCount?: number;
      scrapeMinDist?: number;
      scrapeStrength?: number;
      scrapeRadius?: number;
      noiseScale?: number;
      noiseStrength?: number;
      scale?: [number, number, number];
    }
  ): BufferGeometry[] {
    const { detail = 3 } = options || {};

    // Build base geometry once (expensive operation)
    const baseGeometry = RockBuilder.createBaseGeometry(detail);

    // Clone and scrape each rock (cheap operations)
    return Array.from({ length: count }, (_, i) => {
      const geometry = baseGeometry.clone();
      RockBuilder.applyScrapingAndNoise(geometry, i, options);
      return geometry;
    });
  }
}
