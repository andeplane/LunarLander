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
   * Build vertex adjacency list from geometry faces using Set for O(1) lookups.
   * Returns array where each index contains array of adjacent vertex indices.
   */
  private static buildAdjacency(geometry: BufferGeometry): number[][] {
    const positions = geometry.attributes.position;
    const index = geometry.index;
    const vertexCount = positions.count;
    
    // Initialize adjacency sets (Set for O(1) add/lookup)
    const adjacentSets: Set<number>[] = Array.from({ length: vertexCount }, () => new Set());
    
    // Build adjacency from faces
    if (index) {
      // Indexed geometry
      const indices = index.array;
      for (let i = 0; i < indices.length; i += 3) {
        const i1 = indices[i];
        const i2 = indices[i + 1];
        const i3 = indices[i + 2];
        
        // Add each vertex's neighbors (Set automatically handles duplicates)
        adjacentSets[i1].add(i2);
        adjacentSets[i1].add(i3);
        adjacentSets[i2].add(i1);
        adjacentSets[i2].add(i3);
        adjacentSets[i3].add(i1);
        adjacentSets[i3].add(i2);
      }
    } else {
      // Non-indexed geometry (triangles)
      const count = positions.count;
      for (let i = 0; i < count; i += 3) {
        const i1 = i;
        const i2 = i + 1;
        const i3 = i + 2;
        
        adjacentSets[i1].add(i2);
        adjacentSets[i1].add(i3);
        adjacentSets[i2].add(i1);
        adjacentSets[i2].add(i3);
        adjacentSets[i3].add(i1);
        adjacentSets[i3].add(i2);
      }
    }
    
    // Convert Sets to arrays
    return adjacentSets.map(s => Array.from(s));
  }

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
   * Scrape at vertex positionIndex: project nearby vertices onto a plane.
   * Uses flood-fill to find all vertices within radius.
   * Zero allocations - uses reusable temp vectors and scalar math.
   */
  private static scrape(
    positionIndex: number,
    positions: Float32Array,
    normals: Float32Array,
    adjacentVertices: number[][],
    strength: number,
    radius: number
  ): void {
    const vertexCount = positions.length / 3;
    const traversed = new Array(vertexCount).fill(false);
    
    // Get center position (scalar math)
    const cx = positions[positionIndex * 3];
    const cy = positions[positionIndex * 3 + 1];
    const cz = positions[positionIndex * 3 + 2];
    
    // Get and normalize normal (scalar math)
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
    
    // Flood-fill algorithm
    const stack: number[] = [positionIndex];
    const radiusSq = radius * radius;
    
    while (stack.length > 0) {
      const topIndex = stack.pop()!;
      
      if (traversed[topIndex]) continue;
      traversed[topIndex] = true;
      
      // Get vertex position (scalar math)
      const px = positions[topIndex * 3];
      const py = positions[topIndex * 3 + 1];
      const pz = positions[topIndex * 3 + 2];
      
      // Project onto plane (reuse _v1 temp vector)
      RockBuilder.project(nx, ny, nz, r0x, r0y, r0z, px, py, pz, RockBuilder._v1);
      
      // Check if within radius (scalar math)
      const dx = RockBuilder._v1.x - r0x;
      const dy = RockBuilder._v1.y - r0y;
      const dz = RockBuilder._v1.z - r0z;
      const distSq = dx * dx + dy * dy + dz * dz;
      
      if (distSq < radiusSq) {
        // Project vertex onto plane
        positions[topIndex * 3] = RockBuilder._v1.x;
        positions[topIndex * 3 + 1] = RockBuilder._v1.y;
        positions[topIndex * 3 + 2] = RockBuilder._v1.z;
        
        // Update normal to match plane normal
        normals[topIndex * 3] = nx;
        normals[topIndex * 3 + 1] = ny;
        normals[topIndex * 3 + 2] = nz;
        
        // Add neighbors to stack
        const neighbours = adjacentVertices[topIndex];
        for (const neighbourIndex of neighbours) {
          if (!traversed[neighbourIndex]) {
            stack.push(neighbourIndex);
          }
        }
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
   */
  private static createBaseGeometry(detail: number = 3): BufferGeometry {
    const baseGeometry = new IcosahedronGeometry(1, detail);
    // Merge vertices to weld any duplicates (critical for flood-fill)
    // mergeVertices returns BufferGeometry (loses specific geometry type)
    return mergeVertices(baseGeometry, 1e-6);
  }

  /**
   * Apply scraping and noise to a geometry (modifies in place).
   * Separated for reuse in generateLibrary().
   */
  private static applyScrapingAndNoise(
    geometry: BufferGeometry,
    adjacency: number[][],
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
      scrapeRadius = 0.4,
      noiseScale = 2.0,
      noiseStrength = 0.1,
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

    // Randomly select scrape positions
    const scrapeIndices: number[] = [];
    const scrapePositions: number[] = []; // Store as flat array [x, y, z, ...]

    for (let i = 0; i < scrapeCount; i++) {
      let attempts = 0;
      let found = false;

      while (!found && attempts < 100) {
        const randIndex = Math.floor(prng() * vertexCount);
        const px = positionArray[randIndex * 3];
        const py = positionArray[randIndex * 3 + 1];
        const pz = positionArray[randIndex * 3 + 2];

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

    // Apply scraping at selected positions with randomized parameters
    for (const scrapeIndex of scrapeIndices) {
      // Randomize strength and radius per scrape for natural variation
      const localStrength = scrapeStrength * (0.6 + 0.8 * prng());
      const localRadius = scrapeRadius * (0.6 + 1.2 * prng());
      
      RockBuilder.scrape(
        scrapeIndex,
        positionArray,
        normalArray,
        adjacency,
        localStrength,
        localRadius
      );
    }

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

      // Displace along normal (scalar math)
      const nx = normalArray[i * 3];
      const ny = normalArray[i * 3 + 1];
      const nz = normalArray[i * 3 + 2];
      
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

    // Recompute smooth normals
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

    // Build adjacency list (needed for scraping)
    const adjacency = RockBuilder.buildAdjacency(geometry);

    // Apply scraping and noise
    RockBuilder.applyScrapingAndNoise(geometry, adjacency, seed, options);

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

    // Build topology once (expensive operations)
    const baseGeometry = RockBuilder.createBaseGeometry(detail);
    const adjacency = RockBuilder.buildAdjacency(baseGeometry);

    // Clone and scrape each rock (cheap operations)
    return Array.from({ length: count }, (_, i) => {
      const geometry = baseGeometry.clone();
      RockBuilder.applyScrapingAndNoise(geometry, adjacency, i, options);
      return geometry;
    });
  }
}
