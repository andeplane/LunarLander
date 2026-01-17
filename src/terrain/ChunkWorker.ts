import { generateTerrain, createTerrainEvaluator, type TerrainArgs } from './terrain';
import alea from 'alea';
import type { RockGenerationConfig } from '../types';

/**
 * Message sent to the chunk worker
 */
export interface ChunkWorkerMessage {
  terrainArgs: Parameters<typeof generateTerrain>[0];
  gridKey: string;
  lodLevel: number;
  rockLibrarySize: number;
  rockConfig: RockGenerationConfig;
}

/**
 * Rock placement data computed in worker
 */
export interface RockPlacement {
  prototypeId: number;
  matrices: Float32Array;  // Flattened Matrix4 array (16 floats per rock)
}

/**
 * Result from chunk worker including terrain and rock data
 */
export interface ChunkWorkerResult {
  // Terrain data
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  biome?: ArrayLike<number>;
  index?: ArrayLike<number>;

  // Rock placement data
  rockPlacements: RockPlacement[];

  // Metadata
  gridKey: string;
  lodLevel: number;
  resolution: number;
}

// ============================================================================
// Scientific Rock Distribution (Rüsch et al. 2024)
// ============================================================================

/**
 * Calculate expected rock count per m² above a given diameter.
 * Uses power-law: N(>D) = A * D^exponent
 * 
 * @param diameter - Minimum rock diameter in meters
 * @param densityConstant - A in formula (rocks per m² at D=1m)
 * @param exponent - Power-law exponent (typically -2.5)
 */
function rockDensityAbove(diameter: number, densityConstant: number, exponent: number): number {
  return densityConstant * Math.pow(diameter, exponent);
}

/**
 * Calculate expected rocks per chunk for a given minimum diameter.
 */
function expectedRocksPerChunk(
  minDiameter: number,
  chunkArea: number,
  densityConstant: number,
  exponent: number
): number {
  const density = rockDensityAbove(minDiameter, densityConstant, exponent);
  return Math.round(density * chunkArea);
}

/**
 * Sample a rock diameter from the truncated power-law distribution.
 * N(>D) = A * D^exponent (cumulative size-frequency distribution)
 * 
 * Uses inverse CDF sampling:
 * D = [ Dmin^exp + u * (Dmax^exp - Dmin^exp) ]^(1/exp)
 * 
 * @param random - Random number generator function
 * @param dMin - Minimum diameter for this LOD
 * @param dMax - Maximum diameter (rare large boulders)
 * @param exponent - Power-law exponent
 */
function sampleRockDiameter(
  random: () => number,
  dMin: number,
  dMax: number,
  exponent: number
): number {
  const u = random();

  const dMinPow = Math.pow(dMin, exponent);
  const dMaxPow = Math.pow(dMax, exponent);

  return Math.pow(dMinPow + u * (dMaxPow - dMinPow), 1 / exponent);
}

/**
 * Get minimum rock diameter for a given LOD level based on config.
 */
function getMinDiameterForLod(
  lodLevel: number,
  baseMinDiameter: number,
  lodMinDiameterScale: number[]
): number {
  const scaleIndex = Math.min(lodLevel, lodMinDiameterScale.length - 1);
  const scale = lodMinDiameterScale[scaleIndex];
  return baseMinDiameter * scale;
}

// ============================================================================
// Matrix4 Utilities (manual implementation for worker)
// ============================================================================

/**
 * Compose a Matrix4 from position, quaternion (from euler), and scale.
 * Returns a flat Float32Array of 16 elements.
 */
function composeMatrix(
  px: number, py: number, pz: number,
  rx: number, ry: number, rz: number,
  sx: number, sy: number, sz: number
): Float32Array {
  // Convert Euler angles to quaternion
  const c1 = Math.cos(rx / 2);
  const c2 = Math.cos(ry / 2);
  const c3 = Math.cos(rz / 2);
  const s1 = Math.sin(rx / 2);
  const s2 = Math.sin(ry / 2);
  const s3 = Math.sin(rz / 2);

  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;

  // Build rotation matrix from quaternion
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  // Column-major order (Three.js convention)
  return new Float32Array([
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,

    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,

    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,

    px,
    py,
    pz,
    1
  ]);
}

// ============================================================================
// Rock Placement Generation (World-Space, LOD-Stable)
// ============================================================================

// Terrain evaluator cached per chunk (reuses exact same logic as generateTerrain)
let cachedTerrainEvaluator: ((x: number, z: number) => {y: number; biome: number[]}) | null = null;

/**
 * Setup the height sampler by creating the terrain evaluator.
 * Uses the exact same logic as generateTerrain - just caches the evaluator function.
 */
function setupHeightSampler(terrainArgs: TerrainArgs): void {
  // Create terrain evaluator (reuses exact same logic as generateTerrain)
  cachedTerrainEvaluator = createTerrainEvaluator(terrainArgs);
}

/**
 * Sample terrain height by calling the terrain evaluator directly.
 * Uses the exact same function as generateTerrain - just for a single point.
 * IMPORTANT: Must apply the same strength multiplier as displaceY() in terrain.ts
 */
function sampleHeightFromVertices(
  _positions: ArrayLike<number>,
  _resolution: number,
  _chunkWidth: number,
  _chunkDepth: number,
  x: number,
  z: number,
  smoothLowerPlanes: number
): number {
  if (!cachedTerrainEvaluator) {
    return 0; // Fallback if not set up
  }

  // Call terrain evaluator directly (x, z are already in local chunk space)
  const result = cachedTerrainEvaluator(x, z);
  
  // Apply the same strength multiplier as displaceY() in terrain.ts
  // This ensures rock height matches actual terrain mesh height
  const strength = 2.8 * (1 - smoothLowerPlanes * 0.5);
  return result.y * strength;
}

/**
 * Generate rock placements for a chunk using scientific lunar distribution.
 * 
 * Uses power-law distribution N(>D) = A * D^-2.5 to calculate expected rock count
 * for the LOD's minimum diameter, then generates exactly that many rocks.
 * 
 * All rocks generated are visible at this LOD (no wasteful filtering).
 * Diameters are sampled from truncated power-law [lodMinDiam, maxDiam].
 */
function generateRockPlacements(
  positions: ArrayLike<number>,
  terrainArgs: TerrainArgs,
  lodLevel: number,
  gridKey: string,
  rockLibrarySize: number,
  rockConfig: RockGenerationConfig
): RockPlacement[] {
  // Create seeded random generator based on grid key
  const seed = hashString(gridKey);
  const random = alea(seed);

  const chunkWidth = terrainArgs.width;
  const chunkDepth = terrainArgs.depth;
  const chunkArea = chunkWidth * chunkDepth;
  const resolution = terrainArgs.resolution;

  // Get LOD-specific minimum diameter
  const lodMinDiameter = getMinDiameterForLod(
    lodLevel,
    rockConfig.minDiameter,
    rockConfig.lodMinDiameterScale
  );

  // Calculate expected rock count using scientific distribution
  const rockCount = expectedRocksPerChunk(
    lodMinDiameter,
    chunkArea,
    rockConfig.densityConstant,
    rockConfig.powerLawExponent
  );

  // Setup height sampler ONCE for all rocks in this chunk
  setupHeightSampler(terrainArgs);

  // Group placements by prototype ID
  const placementsByPrototype: Map<number, Float32Array[]> = new Map();

  // Generate exactly the expected number of rocks for this LOD
  // All generated rocks are visible (no filtering needed)
  for (let i = 0; i < rockCount; i++) {
    // Generate position in local chunk space (centered at origin)
    const localX = (random() - 0.5) * chunkWidth;
    const localZ = (random() - 0.5) * chunkDepth;

    // Sample rock diameter from truncated power-law [lodMinDiam, maxDiam]
    const diameter = sampleRockDiameter(
      random,
      lodMinDiameter,
      rockConfig.maxDiameter,
      rockConfig.powerLawExponent
    );

    // Assign prototype ID (deterministic from RNG)
    const prototypeId = Math.floor(random() * rockLibrarySize);

    // Random rotation (deterministic from RNG)
    const rx = random() * Math.PI * 2;
    const ry = random() * Math.PI * 2;
    const rz = random() * Math.PI * 2;

    // Sample terrain height
    const y = sampleHeightFromVertices(
      positions,
      resolution,
      chunkWidth,
      chunkDepth,
      localX,
      localZ,
      terrainArgs.smoothLowerPlanes
    );

    // Scale based on diameter (base rock geometry is 1m)
    const scale = diameter;

    // Rock geometry is centered at origin with Y-scale of 0.7 baked in
    // So rock extends from -0.35*diameter to +0.35*diameter in Y
    // To place rock's bottom at terrain height, offset by +0.35*diameter
    // Then subtract 20% to partially bury it: 0.35 - 0.2 = 0.15
    const offsetY = diameter * 0.15;
    const finalY = y + offsetY;

    // Compute transform matrix
    const matrix = composeMatrix(
      localX, finalY, localZ,
      rx, ry, rz,
      scale, scale, scale
    );

    // Add to prototype group
    if (!placementsByPrototype.has(prototypeId)) {
      placementsByPrototype.set(prototypeId, []);
    }
    placementsByPrototype.get(prototypeId)!.push(matrix);
  }

  // Convert to RockPlacement array
  const result: RockPlacement[] = [];

  for (const [prototypeId, matrices] of placementsByPrototype.entries()) {
    // Flatten all matrices into single Float32Array
    const flatMatrices = new Float32Array(matrices.length * 16);
    for (let i = 0; i < matrices.length; i++) {
      flatMatrices.set(matrices[i], i * 16);
    }

    result.push({
      prototypeId,
      matrices: flatMatrices
    });
  }

  return result;
}

/**
 * Simple string hash for seeding random generator
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

// ============================================================================
// Worker Message Handler
// ============================================================================

self.onmessage = (m: MessageEvent<ChunkWorkerMessage>) => {
  const { terrainArgs, gridKey, lodLevel, rockLibrarySize, rockConfig } = m.data;

  // Generate terrain geometry
  const geometry = generateTerrain(terrainArgs);

  // Extract terrain attributes
  const positions = geometry.attributes.position.array;
  const normals = geometry.attributes.normal.array;
  const index = geometry.index?.array;

  // Generate rock placements using scientific lunar distribution
  const rockPlacements = generateRockPlacements(
    positions,
    terrainArgs,
    lodLevel,
    gridKey,
    rockLibrarySize,
    rockConfig
  );

  // Build result
  const result: ChunkWorkerResult = {
    positions,
    normals,
    uvs: geometry.attributes.uv?.array,
    biome: geometry.attributes.biome?.array,
    index,
    rockPlacements,
    gridKey,
    lodLevel,
    resolution: terrainArgs.resolution,
  };

  postMessage(result);
};
