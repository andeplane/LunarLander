import { generateTerrain, createTerrainEvaluator, type TerrainArgs } from './terrain';
import { 
  generateCratersForRegion, 
  getCraterHeightModAt, 
  applyCratersToHeightBuffer,
  parseGridKey,
  type CraterParams, 
  type Crater 
} from './craters';
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
  stableAxes?: Float32Array; // Flattened array of stable axes [x1, y1, z1, x2, y2, z2, ...] (one per prototype)
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
  return densityConstant * diameter ** exponent;
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

  const dMinPow = dMin ** exponent;
  const dMaxPow = dMax ** exponent;

  return (dMinPow + u * (dMaxPow - dMinPow)) ** (1 / exponent);
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

// Configuration constants for rock placement
const GRADIENT_DELTA = 0.5; // Distance for gradient calculation (meters)
const MAX_SLOPE_THRESHOLD = 0.3; // Maximum acceptable slope for direct placement
const SEARCH_RADIUS = 2.5; // Radius to search for flatter positions (meters)
const SEARCH_SAMPLES = 10; // Number of positions to sample in search
const MIN_BURIAL_PERCENT = 0.4; // Minimum percentage of rock below surface (40%)
const MAX_BURIAL_PERCENT = 0.6; // Maximum percentage of rock below surface (60%)

// Terrain evaluator cached per chunk (reuses exact same logic as generateTerrain)
let cachedTerrainEvaluator: ((x: number, z: number) => {y: number; biome: number[]}) | null = null;

// Cached craters for current chunk (used by both terrain and rock placement)
let cachedCraters: Crater[] = [];
let cachedChunkWorldX = 0;
let cachedChunkWorldZ = 0;

/**
 * Setup the height sampler by creating the terrain evaluator.
 * Uses the exact same logic as generateTerrain - just caches the evaluator function.
 */
function setupHeightSampler(terrainArgs: TerrainArgs): void {
  // Create terrain evaluator (reuses exact same logic as generateTerrain)
  cachedTerrainEvaluator = createTerrainEvaluator(terrainArgs);
}

/**
 * Setup crater cache for current chunk.
 */
function setupCraterCache(
  gridKey: string, 
  chunkWidth: number, 
  chunkDepth: number, 
  params: CraterParams
): void {
  // Generate craters for this region (including neighbors for seamless edges)
  cachedCraters = generateCratersForRegion(gridKey, chunkWidth, chunkDepth, params);
  
  // Cache chunk world offset for coordinate conversion
  const [gridX, gridZ] = parseGridKey(gridKey);
  cachedChunkWorldX = gridX * chunkWidth;
  cachedChunkWorldZ = gridZ * chunkDepth;
}

/**
 * Sample terrain height by calling the terrain evaluator directly.
 * Uses the exact same function as generateTerrain - just for a single point.
 * IMPORTANT: Must apply the same strength multiplier as displaceY() in terrain.ts
 * 
 * Now includes crater modifications for unified height function.
 */
function sampleHeightFromVertices(
  _positions: ArrayLike<number> | null,
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
  const baseHeight = result.y * strength;
  
  // Apply crater modifications (convert local to world coordinates)
  const worldX = x + cachedChunkWorldX;
  const worldZ = z + cachedChunkWorldZ;
  const craterMod = getCraterHeightModAt(worldX, worldZ, cachedCraters);
  
  return baseHeight + craterMod;
}

/**
 * Extract interior vertices from an extended mesh (with skirt).
 * Removes the outer row/column of vertices to get the original chunk size.
 * 
 * @param extendedPositions - Positions from extended mesh (with skirt)
 * @param extendedNormals - Normals from extended mesh
 * @param extendedBiome - Biome data from extended mesh (optional)
 * @param extendedUv - UV data from extended mesh (optional)
 * @param extendedRes - Resolution of extended mesh (original resolution + 2)
 * @param targetRes - Target resolution (original resolution)
 * @returns Extracted positions, normals, biome, and UV for interior vertices only
 */
function extractInterior(
  extendedPositions: Float32Array,
  extendedNormals: Float32Array,
  extendedBiome: Float32Array | undefined,
  extendedUv: Float32Array | undefined,
  extendedRes: number,  // resolution + 2
  targetRes: number     // resolution
): { 
  positions: Float32Array; 
  normals: Float32Array;
  biome: Float32Array | undefined;
  uv: Float32Array | undefined;
} {
  const targetVerticesPerRow = targetRes + 1;
  const extendedVerticesPerRow = extendedRes + 1;
  const positions = new Float32Array(targetVerticesPerRow * targetVerticesPerRow * 3);
  const normals = new Float32Array(targetVerticesPerRow * targetVerticesPerRow * 3);
  const biome = extendedBiome ? new Float32Array(targetVerticesPerRow * targetVerticesPerRow * 3) : undefined;
  const uv = extendedUv ? new Float32Array(targetVerticesPerRow * targetVerticesPerRow * 2) : undefined;
  
  for (let z = 0; z < targetVerticesPerRow; z++) {
    for (let x = 0; x < targetVerticesPerRow; x++) {
      // Skip first row/column of extended mesh (the skirt)
      const srcIdx = ((z + 1) * extendedVerticesPerRow + (x + 1)) * 3;
      const dstIdx = (z * targetVerticesPerRow + x) * 3;
      
      positions[dstIdx] = extendedPositions[srcIdx];
      positions[dstIdx + 1] = extendedPositions[srcIdx + 1];
      positions[dstIdx + 2] = extendedPositions[srcIdx + 2];
      
      normals[dstIdx] = extendedNormals[srcIdx];
      normals[dstIdx + 1] = extendedNormals[srcIdx + 1];
      normals[dstIdx + 2] = extendedNormals[srcIdx + 2];
      
      if (biome && extendedBiome) {
        biome[dstIdx] = extendedBiome[srcIdx];
        biome[dstIdx + 1] = extendedBiome[srcIdx + 1];
        biome[dstIdx + 2] = extendedBiome[srcIdx + 2];
      }
      
      if (uv && extendedUv) {
        const srcUvIdx = ((z + 1) * extendedVerticesPerRow + (x + 1)) * 2;
        const dstUvIdx = (z * targetVerticesPerRow + x) * 2;
        uv[dstUvIdx] = extendedUv[srcUvIdx];
        uv[dstUvIdx + 1] = extendedUv[srcUvIdx + 1];
      }
    }
  }
  return { positions, normals, biome, uv };
}

/**
 * Calculate surface gradient (slope) at a given position.
 * Samples heights at nearby points to compute gradient vector.
 * 
 * @param x - X position in local chunk space
 * @param z - Z position in local chunk space
 * @param smoothLowerPlanes - Terrain smoothness parameter
 * @returns Slope magnitude (sqrt(gradX^2 + gradZ^2))
 */
function calculateSlope(
  x: number,
  z: number,
  smoothLowerPlanes: number
): number {
  if (!cachedTerrainEvaluator) {
    return 0;
  }

  // Sample heights at 4 nearby points
  const h1 = sampleHeightFromVertices(null, 0, 0, 0, x + GRADIENT_DELTA, z, smoothLowerPlanes);
  const h2 = sampleHeightFromVertices(null, 0, 0, 0, x - GRADIENT_DELTA, z, smoothLowerPlanes);
  const h3 = sampleHeightFromVertices(null, 0, 0, 0, x, z + GRADIENT_DELTA, smoothLowerPlanes);
  const h4 = sampleHeightFromVertices(null, 0, 0, 0, x, z - GRADIENT_DELTA, smoothLowerPlanes);

  // Calculate gradient components
  const gradX = (h1 - h2) / (2 * GRADIENT_DELTA);
  const gradZ = (h3 - h4) / (2 * GRADIENT_DELTA);

  // Return slope magnitude
  return Math.sqrt(gradX * gradX + gradZ * gradZ);
}

/**
 * Calculate surface normal at a given position.
 * Uses gradient calculation to determine the "upward" normal direction.
 * 
 * @param x - X position in local chunk space
 * @param z - Z position in local chunk space
 * @param smoothLowerPlanes - Terrain smoothness parameter
 * @returns Normalized surface normal vector [nx, ny, nz]
 */
function calculateSurfaceNormal(
  x: number,
  z: number,
  smoothLowerPlanes: number
): [number, number, number] {
  if (!cachedTerrainEvaluator) {
    return [0, 1, 0]; // Default to up
  }

  // Sample heights at 4 nearby points
  const h1 = sampleHeightFromVertices(null, 0, 0, 0, x + GRADIENT_DELTA, z, smoothLowerPlanes);
  const h2 = sampleHeightFromVertices(null, 0, 0, 0, x - GRADIENT_DELTA, z, smoothLowerPlanes);
  const h3 = sampleHeightFromVertices(null, 0, 0, 0, x, z + GRADIENT_DELTA, smoothLowerPlanes);
  const h4 = sampleHeightFromVertices(null, 0, 0, 0, x, z - GRADIENT_DELTA, smoothLowerPlanes);

  // Calculate gradient components
  const gradX = (h1 - h2) / (2 * GRADIENT_DELTA);
  const gradZ = (h3 - h4) / (2 * GRADIENT_DELTA);

  // Surface normal is perpendicular to gradient: normal = normalize([-gradX, 1, -gradZ])
  const nx = -gradX;
  const ny = 1;
  const nz = -gradZ;

  // Normalize
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-6) {
    return [0, 1, 0]; // Default to up if gradient is zero
  }
  return [nx / len, ny / len, nz / len];
}

/**
 * Find a flatter position near an initial candidate position.
 * Uses deterministic RNG to search nearby positions for lower slope.
 * 
 * @param initialX - Initial X position
 * @param initialZ - Initial Z position
 * @param smoothLowerPlanes - Terrain smoothness parameter
 * @param random - Deterministic random number generator
 * @returns Improved position [x, z] with lower slope
 */
function findFlatterPosition(
  initialX: number,
  initialZ: number,
  smoothLowerPlanes: number,
  random: () => number
): [number, number] {
  // Check initial position slope
  const initialSlope = calculateSlope(initialX, initialZ, smoothLowerPlanes);

  // If initial position is flat enough, use it directly
  if (initialSlope < MAX_SLOPE_THRESHOLD) {
    return [initialX, initialZ];
  }

  // Search nearby positions for flatter spot
  let bestX = initialX;
  let bestZ = initialZ;
  let bestSlope = initialSlope;

  for (let i = 0; i < SEARCH_SAMPLES; i++) {
    // Generate random offset within search radius
    const angle = random() * Math.PI * 2;
    const radius = random() * SEARCH_RADIUS;
    const offsetX = Math.cos(angle) * radius;
    const offsetZ = Math.sin(angle) * radius;

    const candidateX = initialX + offsetX;
    const candidateZ = initialZ + offsetZ;
    const candidateSlope = calculateSlope(candidateX, candidateZ, smoothLowerPlanes);

    // Keep track of flattest position found
    if (candidateSlope < bestSlope) {
      bestX = candidateX;
      bestZ = candidateZ;
      bestSlope = candidateSlope;
    }
  }

  return [bestX, bestZ];
}

/**
 * Compute stable orientation that aligns rock's stable axis with surface normal.
 * Uses quaternion rotation to align the stable axis with the surface normal.
 * 
 * @param stableAxis - Rock's stable axis vector [x, y, z] (normalized)
 * @param surfaceNormal - Surface normal vector [nx, ny, nz] (normalized)
 * @param random - Deterministic random number generator for small variation
 * @returns Euler angles [rx, ry, rz] for rotation
 */
function computeStableOrientation(
  stableAxis: [number, number, number],
  surfaceNormal: [number, number, number],
  random: () => number
): [number, number, number] {
  const [sx, sy, sz] = stableAxis;
  const [nx, ny, nz] = surfaceNormal;

  // Calculate dot product
  const dot = sx * nx + sy * ny + sz * nz;
  
  // If vectors are already aligned (or opposite), add small random rotation
  if (Math.abs(dot) > 0.9999) {
    // Add small random rotation around surface normal for natural variation
    const angle = random() * Math.PI * 2;
    return [0, angle, 0]; // Simple rotation around Y axis
  }

  // Calculate rotation axis (cross product)
  const cx = sy * nz - sz * ny;
  const cy = sz * nx - sx * nz;
  const cz = sx * ny - sy * nx;
  
  // Normalize cross product
  const clen = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (clen < 1e-6) {
    // Vectors are parallel, use identity with small variation
    const angle = random() * Math.PI * 2;
    return [0, angle, 0];
  }
  
  // Build quaternion from axis-angle representation
  // q = [cos(θ/2), sin(θ/2) * axis]
  // where θ = acos(dot) and axis = normalized cross product
  const angle = Math.acos(Math.max(-1, Math.min(1, dot))); // Clamp dot to [-1, 1]
  const halfAngle = angle / 2;
  const sinHalfAngle = Math.sin(halfAngle);
  
  const qw = Math.cos(halfAngle);
  const qx = (cx / clen) * sinHalfAngle;
  const qy = (cy / clen) * sinHalfAngle;
  const qz = (cz / clen) * sinHalfAngle;

  // Convert quaternion to Euler angles (ZYX order, same as Three.js)
  // Roll (x-axis rotation)
  const sinr_cosp = 2 * (qw * qx + qy * qz);
  const cosr_cosp = 1 - 2 * (qx * qx + qy * qy);
  const rx = Math.atan2(sinr_cosp, cosr_cosp);

  // Pitch (y-axis rotation)
  const sinp = 2 * (qw * qy - qz * qx);
  let ry: number;
  if (Math.abs(sinp) >= 1) {
    ry = Math.sign(sinp) * Math.PI / 2; // Use 90 degrees if out of range
  } else {
    ry = Math.asin(sinp);
  }

  // Yaw (z-axis rotation)
  const siny_cosp = 2 * (qw * qz + qx * qy);
  const cosy_cosp = 1 - 2 * (qy * qy + qz * qz);
  const rz = Math.atan2(siny_cosp, cosy_cosp);

  // Add small random rotation around surface normal for natural variation
  const variationAngle = (random() - 0.5) * 0.2; // ±0.1 radians (~±6 degrees)
  return [rx, ry + variationAngle, rz];
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
  rockConfig: RockGenerationConfig,
  stableAxes?: Float32Array
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
    // Generate initial random position in local chunk space (centered at origin)
    const initialX = (random() - 0.5) * chunkWidth;
    const initialZ = (random() - 0.5) * chunkDepth;

    // Find flatter position near initial position
    const [localX, localZ] = findFlatterPosition(
      initialX,
      initialZ,
      terrainArgs.smoothLowerPlanes,
      random
    );

    // Sample rock diameter from truncated power-law [lodMinDiam, maxDiam]
    const diameter = sampleRockDiameter(
      random,
      lodMinDiameter,
      rockConfig.maxDiameter,
      rockConfig.powerLawExponent
    );

    // Assign prototype ID (deterministic from RNG)
    const prototypeId = Math.floor(random() * rockLibrarySize);

    // Calculate surface normal at placement position
    const surfaceNormal = calculateSurfaceNormal(
      localX,
      localZ,
      terrainArgs.smoothLowerPlanes
    );

    // Get stable axis for this prototype (if available)
    let rx: number, ry: number, rz: number;
    if (stableAxes && stableAxes.length >= (prototypeId + 1) * 3) {
      const stableAxis: [number, number, number] = [
        stableAxes[prototypeId * 3],
        stableAxes[prototypeId * 3 + 1],
        stableAxes[prototypeId * 3 + 2]
      ];
      // Compute stable orientation aligning stable axis with surface normal
      [rx, ry, rz] = computeStableOrientation(stableAxis, surfaceNormal, random);
    } else {
      // Fallback to random rotation if stable axes not available
      rx = random() * Math.PI * 2;
      ry = random() * Math.PI * 2;
      rz = random() * Math.PI * 2;
    }

    // Sample terrain height at final position
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
    // So rock extends from -0.35*diameter to +0.35*diameter in Y (total height = 0.7*diameter)
    // To bury 40-60%: rock bottom should be 0.28*diameter to 0.42*diameter below surface
    // Calculate burial depth: 0.28*diameter + random() * 0.14*diameter (gives 40-60% range)
    const burialDepth = diameter * (MIN_BURIAL_PERCENT * 0.7 + random() * (MAX_BURIAL_PERCENT - MIN_BURIAL_PERCENT) * 0.7);
    // Offset: 0.35*diameter - burialDepth
    const offsetY = diameter * 0.35 - burialDepth;
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
    const matrices = placementsByPrototype.get(prototypeId);
    if (matrices) {
      matrices.push(matrix);
    }
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
  const { terrainArgs, gridKey, lodLevel, rockLibrarySize, rockConfig, stableAxes } = m.data;

  // Setup crater cache FIRST (before terrain generation)
  // This ensures both terrain and rock placement use the same craters
  const craterParams: CraterParams = {
    seed: terrainArgs.craterSeed,
    density: terrainArgs.craterDensity,
    minRadius: terrainArgs.craterMinRadius,
    maxRadius: terrainArgs.craterMaxRadius,
    powerLawExponent: terrainArgs.craterPowerLawExponent,
    depthRatio: terrainArgs.craterDepthRatio,
    rimHeight: terrainArgs.craterRimHeight,
    rimWidth: terrainArgs.craterRimWidth,
    floorFlatness: terrainArgs.craterFloorFlatness,
  };
  setupCraterCache(gridKey, terrainArgs.width, terrainArgs.depth, craterParams);

  // Generate extended terrain geometry (with +1 vertex skirt on each edge)
  // This allows edge vertices to have full face neighborhoods for correct normals
  const extendedResolution = terrainArgs.resolution + 2; // +2 segments = +1 vertex per edge
  const vertexSpacing = terrainArgs.width / terrainArgs.resolution;
  const extendedWidth = terrainArgs.width + 2 * vertexSpacing;
  const extendedDepth = terrainArgs.depth + 2 * vertexSpacing;
  
  // Create extended terrain args
  // The terrain evaluator will automatically sample correct positions for extended vertices
  const extendedTerrainArgs: TerrainArgs = {
    ...terrainArgs,
    resolution: extendedResolution,
    width: extendedWidth,
    depth: extendedDepth,
  };
  
  const geometry = generateTerrain(extendedTerrainArgs);

  // Extract terrain attributes (positions is mutable Float32Array)
  const extendedPositions = geometry.attributes.position.array as Float32Array;

  // Apply cached craters to the extended terrain height buffer
  // Convert to local chunk space for mesh modification
  const localCraters: Crater[] = cachedCraters.map(crater => ({
    ...crater,
    centerX: crater.centerX - cachedChunkWorldX,
    centerZ: crater.centerZ - cachedChunkWorldZ,
  }));
  
  // Apply to extended mesh (using extended dimensions)
  applyCratersToHeightBuffer(extendedPositions, extendedWidth, extendedDepth, localCraters);
  
  // Update geometry and compute normals on extended mesh
  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
  const extendedNormals = geometry.attributes.normal.array as Float32Array;
  const extendedBiome = geometry.attributes.biome?.array as Float32Array | undefined;
  const extendedUv = geometry.attributes.uv?.array as Float32Array | undefined;
  
  // Extract interior vertices (remove skirt)
  const { positions, normals, biome, uv } = extractInterior(
    extendedPositions,
    extendedNormals,
    extendedBiome,
    extendedUv,
    extendedResolution,
    terrainArgs.resolution
  );
  
  // Generate index for interior mesh (standard grid indices)
  const targetVerticesPerRow = terrainArgs.resolution + 1;
  const index = new Uint32Array(terrainArgs.resolution * terrainArgs.resolution * 2 * 3);
  let idx = 0;
  for (let z = 0; z < terrainArgs.resolution; z++) {
    for (let x = 0; x < terrainArgs.resolution; x++) {
      const a = z * targetVerticesPerRow + x;
      const b = z * targetVerticesPerRow + (x + 1);
      const c = (z + 1) * targetVerticesPerRow + x;
      const d = (z + 1) * targetVerticesPerRow + (x + 1);
      
      index[idx++] = a;
      index[idx++] = c;
      index[idx++] = b;
      
      index[idx++] = b;
      index[idx++] = c;
      index[idx++] = d;
    }
  }

  // Generate rock placements using scientific lunar distribution
  // Rocks will now sit on the cratered terrain
  const rockPlacements = generateRockPlacements(
    positions,
    terrainArgs,
    lodLevel,
    gridKey,
    rockLibrarySize,
    rockConfig,
    stableAxes
  );

  // Build result
  const result: ChunkWorkerResult = {
    positions,
    normals,
    uvs: uv,
    biome: biome,
    index,
    rockPlacements,
    gridKey,
    lodLevel,
    resolution: terrainArgs.resolution,
  };

  postMessage(result);
};
