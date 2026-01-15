import { generateTerrain, createTerrainEvaluator, type TerrainArgs } from './terrain';
import alea from 'alea';
import { BufferGeometry, BufferAttribute, Float32BufferAttribute, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import { generateGridIndices } from './EdgeStitcher';

/**
 * Message sent to the chunk worker
 */
export interface ChunkWorkerMessage {
  terrainArgs: Parameters<typeof generateTerrain>[0];
  gridKey: string;
  lodLevel: number;
  rockLibrarySize: number;
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
// Rock Distribution Parameters (Scientific lunar distribution)
// ============================================================================

/** Minimum rock diameter in meters - increased for visibility */
const D_MIN = 0.5;

/** Maximum rock diameter in meters (rare large boulders) */
const D_MAX = 5.0;

/** Power-law exponent for size-frequency distribution */
const POWER_LAW_EXPONENT = -2.5;

/** LOD-based minimum diameter thresholds - more generous for visibility */
const LOD_MIN_DIAMETERS: number[] = [
  0.1,   // LOD 0: Show rocks >= 10cm
  0.2,   // LOD 1: Show rocks >= 20cm
  0.5,   // LOD 2: Show rocks >= 50cm
  1.0,   // LOD 3: Show rocks >= 1m
  2.0,   // LOD 4: Show rocks >= 2m
  3.0,   // LOD 5+: Show rocks >= 3m
];

// ============================================================================
// Power-Law Distribution Sampling
// ============================================================================

/**
 * Sample a rock diameter from the power-law distribution.
 * N(>D) = A * D^-2.5 (cumulative size-frequency distribution)
 * 
 * Uses inverse CDF sampling:
 * D = [ Dmin^exp + u * (Dmax^exp - Dmin^exp) ]^(1/exp)
 */
function sampleRockDiameter(random: () => number): number {
  const u = random();
  const exp = POWER_LAW_EXPONENT;

  const dMinPow = Math.pow(D_MIN, exp);
  const dMaxPow = Math.pow(D_MAX, exp);

  return Math.pow(dMinPow + u * (dMaxPow - dMinPow), 1 / exp);
}

/**
 * Get minimum rock diameter for a given LOD level
 */
function getMinDiameterForLod(lodLevel: number): number {
  if (lodLevel >= LOD_MIN_DIAMETERS.length) {
    return LOD_MIN_DIAMETERS[LOD_MIN_DIAMETERS.length - 1];
  }
  return LOD_MIN_DIAMETERS[lodLevel];
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

/** Number of rock candidates to generate per chunk (same at all LODs) */
const ROCK_CANDIDATES_PER_CHUNK = 100;

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
 */
function sampleHeightFromVertices(
  _positions: ArrayLike<number>,
  _resolution: number,
  _chunkWidth: number,
  _chunkDepth: number,
  x: number,
  z: number
): number {
  if (!cachedTerrainEvaluator) {
    return 0; // Fallback if not set up
  }

  // Call terrain evaluator directly (x, z are already in local chunk space)
  const result = cachedTerrainEvaluator(x, z);
  return result.y;
}

/**
 * Generate rock placements for a chunk using world-space positions.
 * 
 * Key insight: Generate the SAME rock candidates at all LOD levels using
 * deterministic RNG based on chunk key. LOD only affects filtering by size.
 * Heights are sampled from already-generated terrain vertices (fast, no duplicate computation).
 * This ensures rocks never change position when LOD changes - they only
 * appear/disappear based on size threshold.
 */
function generateRockPlacements(
  positions: ArrayLike<number>,
  terrainArgs: TerrainArgs,
  lodLevel: number,
  gridKey: string,
  rockLibrarySize: number
): RockPlacement[] {
  // Create seeded random generator based on grid key
  const seed = hashString(gridKey);
  const random = alea(seed);

  const minDiameter = getMinDiameterForLod(lodLevel);
  const chunkWidth = terrainArgs.width;
  const chunkDepth = terrainArgs.depth;
  const resolution = terrainArgs.resolution;

  // Setup height sampler ONCE for all rocks in this chunk (creates terrain evaluator, reuses exact same logic)
  setupHeightSampler(terrainArgs);

  // Group placements by prototype ID
  const placementsByPrototype: Map<number, Float32Array[]> = new Map();

  // Generate ALL rock candidates (same at every LOD level)
  // The RNG sequence is identical regardless of LOD
  for (let i = 0; i < ROCK_CANDIDATES_PER_CHUNK; i++) {
    // Generate position in local chunk space (centered at origin)
    // These positions are the SAME at all LOD levels
    const localX = (random() - 0.5) * chunkWidth;
    const localZ = (random() - 0.5) * chunkDepth;

    // Sample rock diameter from power-law distribution
    // This is also deterministic from the RNG sequence
    const diameter = sampleRockDiameter(random);

    // Assign prototype ID (deterministic from RNG)
    const prototypeId = Math.floor(random() * rockLibrarySize);

    // Random rotation (deterministic from RNG)
    const rx = random() * Math.PI * 2;
    const ry = random() * Math.PI * 2;
    const rz = random() * Math.PI * 2;

    // === LOD FILTERING ===
    // Only rocks large enough pass through at this LOD level
    // This is the ONLY thing that varies with LOD
    if (diameter < minDiameter) {
      continue;
    }

    // Sample terrain height from already-generated vertex positions
    const y = sampleHeightFromVertices(
      positions,
      resolution,
      chunkWidth,
      chunkDepth,
      localX,
      localZ
    );

    // Scale based on diameter (base rock geometry is 1m)
    const scale = diameter;

    // Offset Y slightly so rock sits on surface, not buried
    const offsetY = diameter * 0.3;
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
  const { terrainArgs, gridKey, lodLevel, rockLibrarySize } = m.data;
  const totalStart = performance.now();

  // Generate terrain geometry
  console.log(`[ChunkWorker] ${gridKey} LOD${lodLevel}: Starting terrain generation (res=${terrainArgs.resolution})`);
  const terrainStart = performance.now();
  const geometry = generateTerrain(terrainArgs);
  const terrainTime = performance.now() - terrainStart;
  console.log(`[ChunkWorker] ${gridKey} LOD${lodLevel}: Terrain done in ${terrainTime.toFixed(1)}ms`);

  // Extract terrain attributes
  const positions = geometry.attributes.position.array;
  const normals = geometry.attributes.normal.array;
  const index = geometry.index?.array;

  // Generate rock placements using world-space coordinates
  // Heights are sampled from already-generated vertex positions (fast, no duplicate computation)
  console.log(`[ChunkWorker] ${gridKey} LOD${lodLevel}: Starting rock placement`);
  const rockStart = performance.now();
  const rockPlacements = generateRockPlacements(
    positions,
    terrainArgs,
    lodLevel,
    gridKey,
    rockLibrarySize
  );
  const rockTime = performance.now() - rockStart;
  const rockCount = rockPlacements.reduce((sum, p) => sum + p.matrices.length / 16, 0);
  console.log(`[ChunkWorker] ${gridKey} LOD${lodLevel}: Rocks done in ${rockTime.toFixed(1)}ms (${rockCount} rocks)`);

  const totalTime = performance.now() - totalStart;
  console.log(`[ChunkWorker] ${gridKey} LOD${lodLevel}: TOTAL ${totalTime.toFixed(1)}ms (terrain=${terrainTime.toFixed(1)}ms, rocks=${rockTime.toFixed(1)}ms)`);

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
