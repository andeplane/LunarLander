import { createTerrainEvaluator, terrainDisplacementStrength, type TerrainArgs } from './terrain';
import {
  buildCraterIndex,
  craterParamsFromTerrainArgs,
  generateCratersForRegion,
  sampleCraterIndex,
  type Crater,
  type CraterIndex,
} from './craters';
import { buildChunkMesh } from './chunkMesh';
import { chunkSkirtDepth, skirtIndexCount, writeSkirtIndices } from './chunkSkirt';
import { placeRocks, type RockPlacement } from './rockPlacement';
import type { RockGenerationConfig } from '../types';

/**
 * Message sent to the chunk worker
 */
export interface ChunkWorkerMessage {
  terrainArgs: TerrainArgs;
  gridKey: string;
  lodLevel: number;
  rockLibrarySize: number;
  rockConfig: RockGenerationConfig;
  rockBand?: [number, number];
}

export type { RockPlacement };

export interface RockBandResult {
  gridKey: string;
  rockBand: [number, number];
  rockPlacements: RockPlacement[];
}

/**
 * Result from chunk worker including terrain and rock data
 */
export interface ChunkWorkerResult {
  // Terrain data (typed arrays so their buffers can be transferred, not cloned)
  positions: Float32Array;
  normals: Float32Array;
  index: Uint32Array;

  heightRange?: [number, number];

  // Rock placement data
  rockPlacements: RockPlacement[];

  // Metadata
  gridKey: string;
  lodLevel: number;
  resolution: number;
}

// ============================================================================
// Rock Placement Generation (World-Space, LOD-Stable)
// ============================================================================

// Terrain evaluator cached per chunk (reuses exact same logic as generateTerrain)
let cachedTerrainEvaluator: ((x: number, z: number) => number) | null = null;

// Cached craters for current chunk (used by both terrain and rock placement)
let cachedCraters: Crater[] = [];
// Point-query index over cachedCraters, built on the first height sample
let cachedCraterIndex: CraterIndex | null = null;
// Identifies the chunk + crater parameters the cache was built for
let cachedCraterKey = '';
let cachedCraterMargin = 0;
let cachedChunkWidth = 0;
let cachedChunkDepth = 0;
let cachedChunkWorldX = 0;
let cachedChunkWorldZ = 0;

/** Rock placement probes heights up to a few meters outside the chunk. */
const ROCK_PROBE_MARGIN = 4;

/**
 * Setup the height sampler by creating the terrain evaluator.
 * Uses the exact same logic as generateTerrain - just caches the evaluator function.
 *
 * Also makes sure the crater cache belongs to this chunk, so standalone
 * callers of generateRockPlacements (main-thread rock queries) sample the
 * same cratered surface as the worker.
 */
function setupHeightSampler(terrainArgs: TerrainArgs): void {
  // Create terrain evaluator (reuses exact same logic as generateTerrain)
  cachedTerrainEvaluator = createTerrainEvaluator(terrainArgs);
  setupCraterCache(terrainArgs);
}

/**
 * Setup crater cache for the chunk described by terrainArgs.
 *
 * The region includes a margin of one vertex spacing (the mesh skirt used
 * for normals) plus the reach of rock placement probes. No-op when the cache
 * already holds this chunk with a sufficient margin.
 */
function setupCraterCache(terrainArgs: TerrainArgs): void {
  const { width, depth, posX, posZ, resolution } = terrainArgs;
  const params = craterParamsFromTerrainArgs(terrainArgs);
  const gridX = Math.round(posX / width);
  const gridZ = Math.round(posZ / depth);
  const margin = Math.max(width, depth) / Math.max(resolution, 1) + ROCK_PROBE_MARGIN;
  const key = `${gridX},${gridZ}|${width}|${depth}|${JSON.stringify(params)}`;
  if (key === cachedCraterKey && margin <= cachedCraterMargin) return;

  // Generate craters for this region (including neighbors for seamless edges)
  cachedCraters = generateCratersForRegion(`${gridX},${gridZ}`, width, depth, params, margin);
  cachedCraterIndex = null;
  cachedCraterKey = key;
  cachedCraterMargin = margin;
  cachedChunkWidth = width;
  cachedChunkDepth = depth;

  // Cache chunk world offset for coordinate conversion
  cachedChunkWorldX = gridX * width;
  cachedChunkWorldZ = gridZ * depth;
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
  const height = cachedTerrainEvaluator(x, z);

  // Apply the same strength multiplier as displaceY() in terrain.ts
  // This ensures rock height matches actual terrain mesh height
  const strength = terrainDisplacementStrength(smoothLowerPlanes);
  const baseHeight = height * strength;
  
  // Apply crater modifications (convert local to world coordinates)
  const worldX = x + cachedChunkWorldX;
  const worldZ = z + cachedChunkWorldZ;
  if (cachedCraters.length === 0) return baseHeight;
  if (cachedCraterIndex === null) {
    const halfX = cachedChunkWidth / 2 + cachedCraterMargin;
    const halfZ = cachedChunkDepth / 2 + cachedCraterMargin;
    cachedCraterIndex = buildCraterIndex(
      cachedCraters,
      cachedChunkWorldX - halfX,
      cachedChunkWorldZ - halfZ,
      cachedChunkWorldX + halfX,
      cachedChunkWorldZ + halfZ
    );
  }
  const craterMod = sampleCraterIndex(cachedCraterIndex, worldX, worldZ);
  
  return baseHeight + craterMod;
}

/**
 * Point sampler over the worker's height pipeline for one chunk: returns the
 * height at chunk-local (x, z) exactly as rock placement sees it. Exposed so
 * tests can pin the worker path against heightSampler.ts and the chunk mesh.
 *
 * The returned function reads module-level caches, so it is only valid until
 * the next chunk is set up (generateRockPlacements / handleChunkMessage).
 */
export function createWorkerHeightProbe(
  terrainArgs: TerrainArgs
): (localX: number, localZ: number) => number {
  setupHeightSampler(terrainArgs);
  return (localX: number, localZ: number) =>
    sampleHeightFromVertices(null, 0, 0, 0, localX, localZ, terrainArgs.smoothLowerPlanes);
}

/**
 * Generate rock placements for a chunk.
 *
 * The rock population (positions, sizes, shapes) is a pure function of the
 * terrain seed and the chunk's grid position, see rockPlacement.ts; the LOD
 * only drops small rocks and selects cheaper meshes. Rocks rest on the same
 * cratered height function the terrain mesh is built from.
 *
 * @param positions - Chunk mesh positions (unused: heights are analytic)
 * @param terrainArgs - Terrain parameters of the chunk
 * @param lodLevel - Chunk LOD level
 * @param _gridKey - Chunk grid key (the chunk is identified by terrainArgs)
 * @param rockLibrarySize - Number of rock shapes in the prototype library
 * @param rockConfig - Rock generation config
 */
export function generateRockPlacements(
  positions: ArrayLike<number>,
  terrainArgs: TerrainArgs,
  lodLevel: number,
  _gridKey: string,
  rockLibrarySize: number,
  rockConfig: RockGenerationConfig,
  band?: [number, number]
): RockPlacement[] {
  // Setup height sampler ONCE for all rocks in this chunk
  setupHeightSampler(terrainArgs);
  const { resolution, width, depth, smoothLowerPlanes } = terrainArgs;
  return placeRocks(
    terrainArgs, lodLevel, rockLibrarySize, rockConfig,
    (x, z) => sampleHeightFromVertices(positions, resolution, width, depth, x, z, smoothLowerPlanes),
    band
  );
}

// ============================================================================
// Worker Message Handler
// ============================================================================

export const handleChunkMessage = (m: MessageEvent<ChunkWorkerMessage>): void => {
  const { terrainArgs, gridKey, lodLevel, rockLibrarySize, rockConfig } = m.data;

  if (m.data.rockBand) {
    const placements = generateRockPlacements(
      [], terrainArgs, 0, gridKey, rockLibrarySize, rockConfig, m.data.rockBand
    );
    const transfer = placements.flatMap(p => [p.matrices.buffer, p.colors.buffer]);
    const result: RockBandResult = { gridKey, rockPlacements: placements, rockBand: m.data.rockBand };
    postMessage(result, { transfer });
    return;
  }
  // Setup crater cache FIRST (before terrain generation)
  // This ensures both terrain and rock placement use the same craters
  setupCraterCache(terrainArgs);

  // Build the terrain mesh: base terrain + craters on a grid with a one-vertex
  // skirt (so edge vertices get full face neighborhoods for correct normals),
  // one normals pass over the final cratered heights, skirt stripped.
  // A wall hung from the perimeter closes the slits between LODs.
  const vertexSpacing = Math.max(terrainArgs.width, terrainArgs.depth) / terrainArgs.resolution;
  const { positions, normals, heightRange } = buildChunkMesh(
    terrainArgs,
    cachedCraters,
    chunkSkirtDepth(vertexSpacing)
  );

  // Generate index for interior mesh (standard grid indices)
  const targetVerticesPerRow = terrainArgs.resolution + 1;
  const index = new Uint32Array(
    terrainArgs.resolution * terrainArgs.resolution * 2 * 3 + skirtIndexCount(terrainArgs.resolution)
  );
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
  writeSkirtIndices(index, idx, terrainArgs.resolution);

  // Generate rock placements using scientific lunar distribution
  // Rocks will now sit on the cratered terrain
  const rockPlacements = rockLibrarySize === 0 ? [] : generateRockPlacements(
    positions,
    terrainArgs,
    lodLevel,
    gridKey,
    rockLibrarySize,
    rockConfig
  );

  // Build result
  const result: ChunkWorkerResult = {
    heightRange,
    positions,
    normals,
    index,
    rockPlacements,
    gridKey,
    lodLevel,
    resolution: terrainArgs.resolution,
  };

  // Transfer all freshly allocated buffers instead of structure-cloning them.
  // This moves ownership to the main thread with zero copying.
  const transfer: Transferable[] = [
    positions.buffer,
    normals.buffer,
    index.buffer,
  ];
  for (const placement of rockPlacements) {
    transfer.push(placement.matrices.buffer, placement.colors.buffer);
  }

  postMessage(result, { transfer });
};

// Register the message handler only inside an actual Web Worker. The module
// is also imported under node (vitest) and on the browser main thread (pad
// search reuses generateRockPlacements) — `self` exists as `window` there,
// and assigning onmessage would hijack the page's message handler.
declare const WorkerGlobalScope: (new () => unknown) | undefined;
if (
  typeof WorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  self.onmessage = handleChunkMessage;
}
