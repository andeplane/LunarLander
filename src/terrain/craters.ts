/**
 * Procedural crater generation for lunar terrain.
 * 
 * Implements deterministic crater placement using power-law size distribution
 * based on real lunar crater statistics (S(D) ≈ 22,000 · D^(-2.4) craters/km²).
 * 
 * Craters are applied as height buffer modifications after base terrain generation,
 * ensuring seamless continuity across chunk boundaries via neighbor-aware generation.
 */

import alea from 'alea';
import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';

/**
 * Configuration for crater generation (passed via TerrainArgs)
 */
export interface CraterParams {
  seed: number;
  density: number;           // Craters per km² at reference size (1m radius)
  minRadius: number;         // Minimum crater radius in meters
  maxRadius: number;         // Maximum crater radius in meters
  powerLawExponent: number;  // Size-frequency distribution exponent
  depthRatio: number;        // Crater depth = radius * depthRatio
  rimHeight: number;         // Rim height as fraction of depth (0-1)
  rimWidth: number;          // Rim extends beyond radius by this fraction
  floorFlatness: number;     // 0 = parabolic bowl, 1 = flat floor
}

/**
 * A single crater definition
 */
export interface Crater {
  centerX: number;     // World X coordinate
  centerZ: number;     // World Z coordinate
  radius: number;      // Crater radius in meters
  depth: number;       // Maximum depth at center
  rimHeight: number;   // Height of raised rim
  rimOuterRadius: number; // Outer edge of rim
  floorFlatness: number;  // Floor shape parameter
  // Wobble parameters for irregular rim (using noise)
  wobbleAmplitude: number;  // How much the radius varies (0-1 fraction of radius)
  wobbleSeed: number;       // Unique seed for this crater's noise
}

/**
 * Simple string hash for seeding random generator (same as in ChunkWorker)
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Sample crater radius from power-law distribution.
 * Uses inverse CDF sampling for the cumulative size-frequency distribution.
 * 
 * @param random - Seeded random function (0-1)
 * @param minR - Minimum radius
 * @param maxR - Maximum radius
 * @param exponent - Power-law exponent (typically -2.0 to -3.0)
 */
function sampleCraterRadius(
  random: () => number,
  minR: number,
  maxR: number,
  exponent: number
): number {
  const u = random();
  const minPow = minR ** exponent;
  const maxPow = maxR ** exponent;
  return (minPow + u * (maxPow - minPow)) ** (1 / exponent);
}

/**
 * Parse grid key "x,z" to [gridX, gridZ]
 */
export function parseGridKey(gridKey: string): [number, number] {
  const [x, z] = gridKey.split(',').map(Number);
  return [x, z];
}

/**
 * Generate craters for a single chunk cell.
 * 
 * @param gridX - Chunk grid X coordinate
 * @param gridZ - Chunk grid Z coordinate
 * @param chunkWidth - Chunk width in meters
 * @param chunkDepth - Chunk depth in meters
 * @param params - Crater generation parameters
 * @returns Array of craters whose centers are within this chunk
 */
function generateCratersForCell(
  gridX: number,
  gridZ: number,
  chunkWidth: number,
  chunkDepth: number,
  params: CraterParams
): Crater[] {
  const craters: Crater[] = [];
  
  // Seed RNG with combination of global seed and chunk position
  const cellKey = `crater:${params.seed}:${gridX},${gridZ}`;
  const random = alea(hashString(cellKey));
  
  // Calculate expected crater count based on density and chunk area
  // Density is per km² at 1m radius, scale by chunk area
  const chunkAreaKm2 = (chunkWidth * chunkDepth) / 1_000_000;
  
  // Expected count scales with density and area
  // Use Poisson distribution approximation via random sampling
  const expectedCount = params.density * chunkAreaKm2;
  
  // Generate Poisson-distributed count (simple approximation)
  // For small expected values, this works well
  let count = 0;
  if (expectedCount > 0) {
    // Poisson approximation: for each "slot", roll to see if crater exists
    const L = Math.exp(-expectedCount);
    let p = 1;
    while (p > L) {
      count++;
      p *= random();
    }
    count = Math.max(0, count - 1);
  }
  
  // Generate each crater
  for (let i = 0; i < count; i++) {
    // Random position within chunk (world coordinates)
    const centerX = (gridX + random() - 0.5) * chunkWidth;
    const centerZ = (gridZ + random() - 0.5) * chunkDepth;
    
    // Sample radius from power-law distribution
    const radius = sampleCraterRadius(
      random,
      params.minRadius,
      params.maxRadius,
      params.powerLawExponent
    );
    
    // Calculate crater properties
    const depth = radius * params.depthRatio * 2; // depthRatio is relative to diameter
    const rimHeight = depth * params.rimHeight;
    const rimOuterRadius = radius * (1 + params.rimWidth);
    
    // Generate wobble parameters for irregular rim
    const wobbleAmplitude = 0.02 + random() * 0.05; // 2-7% radius variation (subtle)
    const wobbleSeed = Math.floor(random() * 100000); // Unique seed for noise
    
    craters.push({
      centerX,
      centerZ,
      radius,
      depth,
      rimHeight,
      rimOuterRadius,
      floorFlatness: params.floorFlatness,
      wobbleAmplitude,
      wobbleSeed,
    });
  }
  
  return craters;
}

/**
 * Generate all craters that could affect a chunk, including from neighbor cells.
 * 
 * Uses 3x3 neighbor scan to ensure craters crossing boundaries are included.
 * 
 * @param gridKey - Current chunk's grid key "x,z"
 * @param chunkWidth - Chunk width in meters
 * @param chunkDepth - Chunk depth in meters
 * @param params - Crater generation parameters
 * @returns Array of all craters that could affect this chunk
 */
export function generateCratersForRegion(
  gridKey: string,
  chunkWidth: number,
  chunkDepth: number,
  params: CraterParams
): Crater[] {
  const [gridX, gridZ] = parseGridKey(gridKey);
  const allCraters: Crater[] = [];
  
  // Calculate chunk bounds in world coordinates
  const chunkMinX = (gridX - 0.5) * chunkWidth;
  const chunkMaxX = (gridX + 0.5) * chunkWidth;
  const chunkMinZ = (gridZ - 0.5) * chunkDepth;
  const chunkMaxZ = (gridZ + 0.5) * chunkDepth;
  
  // Scan 3x3 grid of cells (including neighbors)
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const cellCraters = generateCratersForCell(
        gridX + dx,
        gridZ + dz,
        chunkWidth,
        chunkDepth,
        params
      );
      
      // Filter to craters that could affect this chunk
      // A crater affects a chunk if its rim overlaps the chunk bounds
      for (const crater of cellCraters) {
        const effectRadius = crater.rimOuterRadius;
        
        // Check if crater's influence area overlaps chunk bounds
        if (
          crater.centerX + effectRadius >= chunkMinX &&
          crater.centerX - effectRadius <= chunkMaxX &&
          crater.centerZ + effectRadius >= chunkMinZ &&
          crater.centerZ - effectRadius <= chunkMaxZ
        ) {
          allCraters.push(crater);
        }
      }
    }
  }
  
  return allCraters;
}

/**
 * Compute the height modification at a given distance from crater center.
 * 
 * Profile:
 * - Inside crater (r < R): parabolic/flat bowl depression
 * - Rim zone (R < r < rimOuter): raised rim with smooth falloff
 * - Outside rim: no modification
 * 
 * @param distance - Distance from crater center
 * @param crater - Crater definition
 * @returns Height modification (negative = depression, positive = rim)
 */
// Cache noise functions by seed to avoid recreating them
const noiseCache = new Map<number, NoiseFunction2D>();

function getNoiseForSeed(seed: number): NoiseFunction2D {
  let noise = noiseCache.get(seed);
  if (!noise) {
    const prng = alea(seed);
    noise = createNoise2D(prng);
    noiseCache.set(seed, noise);
    // Limit cache size to prevent memory leaks
    if (noiseCache.size > 1000) {
      const firstKey = noiseCache.keys().next().value;
      if (firstKey !== undefined) noiseCache.delete(firstKey);
    }
  }
  return noise;
}

/**
 * Calculate wobbled radius at a given angle using simplex noise
 */
function getWobblyRadius(baseRadius: number, angle: number, crater: Crater): number {
  const { wobbleAmplitude, wobbleSeed } = crater;
  
  // Sample noise on a circle - this gives smooth, organic variation around the rim
  // Use multiple octaves at different frequencies for more natural irregularity
  const noise = getNoiseForSeed(wobbleSeed);
  
  // Sample points on a unit circle, scaled for different frequencies
  const x1 = Math.cos(angle);
  const y1 = Math.sin(angle);
  
  // Low frequency (large features) + high frequency (small bumps)
  const freq1 = 2.0;  // ~2 major bumps
  const freq2 = 5.0;  // ~5 medium bumps  
  const freq3 = 11.0; // ~11 small bumps
  
  const wobble1 = noise(x1 * freq1, y1 * freq1) * 0.6;
  const wobble2 = noise(x1 * freq2, y1 * freq2) * 0.3;
  const wobble3 = noise(x1 * freq3, y1 * freq3) * 0.1;
  
  const totalWobble = wobble1 + wobble2 + wobble3;
  
  return baseRadius * (1 + totalWobble * wobbleAmplitude);
}

export function craterHeightProfile(distance: number, angle: number, crater: Crater): number {
  const { radius, depth, rimHeight, rimOuterRadius, floorFlatness } = crater;
  
  // Apply wobble to radius and rim outer radius
  const wobbledRadius = getWobblyRadius(radius, angle, crater);
  const wobbledRimOuter = getWobblyRadius(rimOuterRadius, angle, crater);
  
  if (distance >= wobbledRimOuter) {
    // Outside crater influence
    return 0;
  }
  
  if (distance <= wobbledRadius) {
    // Inside crater bowl
    const normalizedDist = distance / wobbledRadius;
    
    // Parabolic profile: depth * (1 - (r/R)²)
    // With floor flatness: interpolate between parabolic and flat
    const parabolicDepth = depth * (1 - normalizedDist * normalizedDist);
    
    if (floorFlatness > 0 && normalizedDist < 0.5) {
      // Flat floor in center, blend to parabolic at edges
      const flatDepth = depth;
      const blendFactor = normalizedDist / 0.5; // 0 at center, 1 at half-radius
      const blendedDepth = flatDepth * (1 - blendFactor * floorFlatness) + 
                          parabolicDepth * blendFactor * floorFlatness;
      return -blendedDepth;
    }
    
    return -parabolicDepth;
  }
  
  // Rim zone (wobbledRadius < distance < wobbledRimOuter)
  // Use a smooth bell curve that starts at 0, peaks, then returns to 0
  const rimWidth = wobbledRimOuter - wobbledRadius;
  const rimProgress = (distance - wobbledRadius) / rimWidth; // 0 at crater edge, 1 at rim outer edge
  
  // Bell curve: sin(π * progress) peaks at 0.5
  // This ensures smooth transition at both edges (no discontinuity)
  const bellCurve = Math.sin(Math.PI * rimProgress);
  
  return rimHeight * bellCurve;
}

/**
 * Get the crater height modification at a single world point.
 * Used for procedural height queries (e.g., rock placement).
 * 
 * @param worldX - World X coordinate
 * @param worldZ - World Z coordinate  
 * @param craters - Array of craters to consider
 * @returns Height modification (negative for depression, positive for rim)
 */
export function getCraterHeightModAt(
  worldX: number,
  worldZ: number,
  craters: Crater[]
): number {
  if (craters.length === 0) return 0;
  
  let totalHeightMod = 0;
  let hasRim = false;
  let maxRim = 0;
  
  for (const crater of craters) {
    const dx = worldX - crater.centerX;
    const dz = worldZ - crater.centerZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    
    // Skip if clearly outside crater influence (with wobble margin)
    if (distance >= crater.rimOuterRadius * 1.3) continue;
    
    // Calculate angle for wobbly radius
    const angle = Math.atan2(dz, dx);
    const heightMod = craterHeightProfile(distance, angle, crater);
    
    if (heightMod < 0) {
      // Depression: use deepest (most negative)
      totalHeightMod = Math.min(totalHeightMod, heightMod);
    } else if (heightMod > 0) {
      // Rim: track separately
      hasRim = true;
      maxRim = Math.max(maxRim, heightMod);
    }
  }
  
  // Only apply rim if we're not in a depression
  if (totalHeightMod < 0) {
    return totalHeightMod;
  } else if (hasRim) {
    return maxRim;
  }
  
  return 0;
}

/**
 * Apply craters to a terrain height buffer.
 * 
 * Modifies the Y values of the position buffer based on crater profiles.
 * Uses min() for overlapping craters to simulate newer craters overwriting older ones.
 * 
 * @param positions - Float32Array of vertex positions (x, y, z per vertex)
 * @param chunkWidth - Chunk width in meters
 * @param chunkDepth - Chunk depth in meters
 * @param craters - Array of craters to apply
 */
export function applyCratersToHeightBuffer(
  positions: Float32Array,
  _chunkWidth: number,
  _chunkDepth: number,
  craters: Crater[]
): void {
  if (craters.length === 0) return;
  
  const vertexCount = positions.length / 3;
  let _modifiedCount = 0;
  
  // For each vertex, compute crater influence
  for (let i = 0; i < vertexCount; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    
    // Track the deepest depression and highest rim at this point
    let totalHeightMod = 0;
    let hasRim = false;
    let maxRim = 0;
    
    for (const crater of craters) {
      // Calculate distance from vertex to crater center
      // Note: vertex positions are in local chunk space (centered at origin)
      // Crater centers are in world space, so we need to account for this
      const dx = x - crater.centerX;
      const dz = z - crater.centerZ;
      const distance = Math.sqrt(dx * dx + dz * dz);
      
      // Skip if clearly outside crater influence (use base radius * 1.5 for wobble margin)
      if (distance >= crater.rimOuterRadius * 1.3) continue;
      
      // Calculate angle for wobbly radius
      const angle = Math.atan2(dz, dx);
      const heightMod = craterHeightProfile(distance, angle, crater);
      
      if (heightMod < 0) {
        // Depression: use deepest (most negative)
        totalHeightMod = Math.min(totalHeightMod, heightMod);
      } else if (heightMod > 0) {
        // Rim: track separately, only apply if no depression
        hasRim = true;
        maxRim = Math.max(maxRim, heightMod);
      }
    }
    
    // Apply height modification
    // Depression takes priority over rim (newer craters destroy older rims)
    if (totalHeightMod < 0) {
      positions[i * 3 + 1] = y + totalHeightMod;
      _modifiedCount++;
    } else if (hasRim) {
      positions[i * 3 + 1] = y + maxRim;
      _modifiedCount++;
    }
  }
}

/**
 * Main entry point for crater application in the worker.
 * 
 * Generates craters for the region and applies them to the height buffer.
 * Vertex positions are in local chunk space but crater world positions
 * need to be converted to match.
 * 
 * @param positions - Float32Array of vertex positions
 * @param gridKey - Chunk grid key "x,z"
 * @param chunkWidth - Chunk width in meters
 * @param chunkDepth - Chunk depth in meters
 * @param params - Crater generation parameters
 */
export function applyCratersToChunk(
  positions: Float32Array,
  gridKey: string,
  chunkWidth: number,
  chunkDepth: number,
  params: CraterParams
): number {
  // Generate craters for this region (including neighbors)
  const craters = generateCratersForRegion(gridKey, chunkWidth, chunkDepth, params);
  
  if (craters.length === 0) return 0;
  
  // Convert crater positions from world space to local chunk space
  const [gridX, gridZ] = parseGridKey(gridKey);
  const chunkWorldX = gridX * chunkWidth;
  const chunkWorldZ = gridZ * chunkDepth;
  
  const localCraters: Crater[] = craters.map(crater => ({
    ...crater,
    centerX: crater.centerX - chunkWorldX,
    centerZ: crater.centerZ - chunkWorldZ,
  }));
  
  // Apply craters to height buffer
  applyCratersToHeightBuffer(positions, chunkWidth, chunkDepth, localCraters);
  
  return craters.length;
}
