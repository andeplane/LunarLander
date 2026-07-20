/**
 * BenchmarkRunner - Core benchmark execution logic for terrain, rocks, and chunks.
 *
 * Provides timing measurements for:
 * - Terrain generation at various resolutions
 * - Rock geometry generation at various detail levels
 * - Full chunk generation via the production ChunkWorker (terrain + craters + rocks)
 */

import { generateTerrain, type TerrainArgs } from '../terrain/terrain';
import { applyCratersToHeightBuffer, generateCratersForRegion, type CraterParams } from '../terrain/craters';
import { DEFAULT_LOD_LEVELS, getResolutionForLodLevel } from '../terrain/LodUtils';
import type { ChunkWorkerMessage, ChunkWorkerResult } from '../terrain/ChunkWorker';
import type { RockGenerationConfig } from '../types';
import { RockBuilder } from '../environment/RockBuilder';
import { calculateStats, sanitizeIterations } from './stats';

/**
 * Result from a single benchmark run
 */
export interface BenchmarkResult {
  category: 'terrain' | 'rock' | 'chunk';
  config: string;
  times: number[];       // All iteration times in ms
  mean: number;          // Mean time in ms
  min: number;           // Min time in ms
  max: number;           // Max time in ms
  median: number;        // Median time in ms
  vertices: number;      // Vertex count (if applicable)
  triangles: number;     // Triangle count (if applicable)
  throughput: string;    // e.g., "1234 verts/ms" or "5678 tris/ms"
}

/**
 * Progress callback for UI updates
 */
export type ProgressCallback = (current: number, total: number, message: string) => void;

/**
 * Default terrain arguments for benchmarking
 */
function getDefaultTerrainArgs(resolution: number): TerrainArgs {
  return {
    seed: 42,
    gain: 0.5,
    lacunarity: 1.8,
    frequency: 0.008,
    amplitude: 1.0,
    altitude: 0,
    octaves: 6,
    smoothLowerPlanes: 0.5,
    width: 400,
    depth: 400,
    resolution,
    posX: 0,
    posZ: 0,
    renderDistance: 5,
    // Crater params
    craterSeed: 42,
    craterDensity: 100,
    craterMinRadius: 5,
    craterMaxRadius: 150,
    craterPowerLawExponent: -2.2,
    craterDepthRatio: 0.15,
    craterRimHeight: 0.3,
    craterRimWidth: 0.2,
    craterFloorFlatness: 0,
  };
}

/**
 * Default crater parameters for benchmarking
 */
function getDefaultCraterParams(): CraterParams {
  return {
    seed: 42,
    density: 100,
    minRadius: 5,
    maxRadius: 150,
    powerLawExponent: -2.2,
    depthRatio: 0.15,
    rimHeight: 0.3,
    rimWidth: 0.2,
    floorFlatness: 0,
  };
}

/**
 * Default rock generation config, mirroring the app config in src/main.ts
 */
function getDefaultRockConfig(): RockGenerationConfig {
  return {
    minDiameter: 0.75,
    maxDiameter: 10.0,
    densityConstant: 0.0005,
    powerLawExponent: -2.5,
    lodMinDiameterScale: [1.0, 1.0, 1.0, 2.0, 4.0, 6.0],
  };
}

/** Rock library size used by the app (see src/main.ts). */
const DEFAULT_ROCK_LIBRARY_SIZE = 30;

/**
 * Build the extended terrain args exactly like the production ChunkWorker does:
 * +2 segments (= +1 vertex skirt per edge) so edge vertices get full face
 * neighborhoods for correct normals. Keeps benchmark cost aligned with the
 * real per-chunk terrain work.
 */
function getExtendedTerrainArgs(terrainArgs: TerrainArgs): TerrainArgs {
  const vertexSpacing = terrainArgs.width / terrainArgs.resolution;
  return {
    ...terrainArgs,
    resolution: terrainArgs.resolution + 2,
    width: terrainArgs.width + 2 * vertexSpacing,
    depth: terrainArgs.depth + 2 * vertexSpacing,
  };
}

/**
 * Run terrain generation benchmark at various resolutions.
 *
 * Mirrors the worker pipeline: extended (+2 skirt) mesh generation, crater
 * application on the extended height buffer, and vertex normal recomputation.
 */
export async function runTerrainBenchmark(
  resolutions: number[],
  iterations: number,
  onProgress?: ProgressCallback
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const runs = sanitizeIterations(iterations);
  const total = resolutions.length * runs;
  let current = 0;

  for (const resolution of resolutions) {
    const times: number[] = [];
    const terrainArgs = getDefaultTerrainArgs(resolution);
    const extendedArgs = getExtendedTerrainArgs(terrainArgs);
    const craterParams = getDefaultCraterParams();
    const gridKey = '0,0';

    let vertices = 0;
    let triangles = 0;

    for (let i = 0; i < runs; i++) {
      onProgress?.(++current, total, `Terrain ${resolution}x${resolution}, iteration ${i + 1}/${runs}`);

      // Allow UI to update
      await new Promise(resolve => setTimeout(resolve, 0));

      const start = performance.now();

      // Generate extended terrain (with +1 vertex skirt), like the worker
      const geometry = generateTerrain(extendedArgs);

      // Generate craters for the chunk region and apply to the extended buffer
      const craters = generateCratersForRegion(gridKey, terrainArgs.width, terrainArgs.depth, craterParams);
      const positions = geometry.attributes.position.array as Float32Array;
      applyCratersToHeightBuffer(positions, extendedArgs.width, extendedArgs.depth, craters);

      // Recompute normals
      geometry.computeVertexNormals();

      const end = performance.now();
      times.push(end - start);

      // Capture geometry info on last iteration
      if (i === runs - 1) {
        vertices = geometry.attributes.position.count;
        triangles = geometry.index ? geometry.index.count / 3 : vertices / 3;
      }

      // Cleanup
      geometry.dispose();
    }

    const stats = calculateStats(times);
    const throughput = stats.mean > 0 ? `${Math.round(vertices / stats.mean)} verts/ms` : 'N/A';

    results.push({
      category: 'terrain',
      config: `${resolution}×${resolution}`,
      times,
      mean: stats.mean,
      min: stats.min,
      max: stats.max,
      median: stats.median,
      vertices,
      triangles,
      throughput,
    });
  }

  return results;
}

/**
 * Run rock generation benchmark at various detail levels
 */
export async function runRockBenchmark(
  detailLevels: number[],
  librarySize: number,
  iterations: number,
  onProgress?: ProgressCallback
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const runs = sanitizeIterations(iterations);
  const total = detailLevels.length * runs;
  let current = 0;

  for (const detail of detailLevels) {
    const times: number[] = [];
    let triangles = 0;

    // Calculate expected triangle count: 20 * (detail + 1)^2
    const expectedTriangles = 20 * (detail + 1) ** 2;

    for (let i = 0; i < runs; i++) {
      onProgress?.(++current, total, `Rocks detail=${detail}, library=${librarySize}, iteration ${i + 1}/${runs}`);

      // Allow UI to update
      await new Promise(resolve => setTimeout(resolve, 0));

      const start = performance.now();

      // Generate rock library
      const geometries = RockBuilder.generateLibrary(librarySize, { detail });

      const end = performance.now();
      times.push(end - start);

      // Capture geometry info on last iteration
      if (i === runs - 1 && geometries.length > 0) {
        // Sum triangles from all geometries
        triangles = geometries.reduce((sum, geom) => {
          const count = geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
          return sum + count;
        }, 0);
      }

      // Cleanup
      for (const geom of geometries) {
        geom.dispose();
      }
    }

    const stats = calculateStats(times);
    const throughput = stats.mean > 0 ? `${Math.round(triangles / stats.mean)} tris/ms` : 'N/A';

    results.push({
      category: 'rock',
      config: `detail=${detail} (~${expectedTriangles} tris) × ${librarySize}`,
      times,
      mean: stats.mean,
      min: stats.min,
      max: stats.max,
      median: stats.median,
      vertices: 0, // Not relevant for rocks
      triangles,
      throughput,
    });
  }

  return results;
}

/**
 * Create a production chunk worker (same module the app uses).
 */
function createChunkWorker(): Worker {
  return new Worker(
    new URL('../terrain/ChunkWorker.ts', import.meta.url),
    { type: 'module' }
  );
}

/**
 * Post a chunk build request to the worker and wait for its result.
 */
function runChunkWorkerJob(worker: Worker, message: ChunkWorkerMessage): Promise<ChunkWorkerResult> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent<ChunkWorkerResult>) => {
      cleanup();
      resolve(e.data);
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      reject(new Error(`Chunk worker failed: ${e.message}`));
    };
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage(message);
  });
}

/**
 * Build a chunk worker message for a given LOD level, mirroring what
 * ChunkManager.dispatchNext sends in production.
 */
function buildChunkWorkerMessage(lodLevel: number, resolution: number): ChunkWorkerMessage {
  return {
    terrainArgs: getDefaultTerrainArgs(resolution),
    gridKey: '0,0',
    lodLevel,
    rockLibrarySize: DEFAULT_ROCK_LIBRARY_SIZE,
    rockConfig: getDefaultRockConfig(),
    // stableAxes omitted: the worker falls back to computing orientations,
    // which is the same code path exercised when axes are unavailable.
  };
}

/**
 * Run full chunk generation benchmark through the real ChunkWorker.
 *
 * This exercises the exact production pipeline: extended (+2 skirt) terrain,
 * crater application, normal computation, interior extraction, index
 * generation, real rock placement, and the postMessage round trip.
 */
export async function runChunkBenchmark(
  lodLevels: number[],
  iterations: number,
  onProgress?: ProgressCallback
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const runs = sanitizeIterations(iterations);
  const total = lodLevels.length * runs;
  let current = 0;

  const worker = createChunkWorker();

  try {
    // Warm up the worker (module compile + JIT) with a cheap chunk so the
    // first timed iteration isn't dominated by startup cost.
    const lowestResolution = DEFAULT_LOD_LEVELS[DEFAULT_LOD_LEVELS.length - 1];
    await runChunkWorkerJob(worker, buildChunkWorkerMessage(DEFAULT_LOD_LEVELS.length - 1, lowestResolution));

    for (const lodLevel of lodLevels) {
      const times: number[] = [];
      const resolution = getResolutionForLodLevel(lodLevel, DEFAULT_LOD_LEVELS);

      let vertices = 0;
      let triangles = 0;

      for (let i = 0; i < runs; i++) {
        onProgress?.(++current, total, `Chunk LOD ${lodLevel} (${resolution}×${resolution}), iteration ${i + 1}/${runs}`);

        // Allow UI to update
        await new Promise(resolve => setTimeout(resolve, 0));

        const start = performance.now();
        const result = await runChunkWorkerJob(worker, buildChunkWorkerMessage(lodLevel, resolution));
        const end = performance.now();

        times.push(end - start);

        // Capture geometry info on last iteration
        if (i === runs - 1) {
          vertices = result.positions.length / 3;
          triangles = result.index.length / 3;
        }
      }

      const stats = calculateStats(times);
      const throughput = stats.mean > 0 ? `${Math.round(vertices / stats.mean)} verts/ms` : 'N/A';

      results.push({
        category: 'chunk',
        config: `LOD ${lodLevel} (${resolution}×${resolution})`,
        times,
        mean: stats.mean,
        min: stats.min,
        max: stats.max,
        median: stats.median,
        vertices,
        triangles,
        throughput,
      });
    }
  } finally {
    worker.terminate();
  }

  return results;
}

/**
 * Run all benchmarks, honoring the per-category iteration counts.
 */
export async function runAllBenchmarks(
  terrainResolutions: number[],
  terrainIterations: number,
  rockDetails: number[],
  rockLibrarySize: number,
  rockIterations: number,
  chunkLods: number[],
  chunkIterations: number,
  onProgress?: ProgressCallback
): Promise<BenchmarkResult[]> {
  const allResults: BenchmarkResult[] = [];

  const terrainRuns = sanitizeIterations(terrainIterations);
  const rockRuns = sanitizeIterations(rockIterations);
  const chunkRuns = sanitizeIterations(chunkIterations);

  const totalSteps =
    terrainResolutions.length * terrainRuns +
    rockDetails.length * rockRuns +
    chunkLods.length * chunkRuns;
  let currentStep = 0;

  // Wrap progress to accumulate across all benchmarks
  const wrapProgress = (_current: number, _total: number, message: string) => {
    currentStep++;
    onProgress?.(currentStep, totalSteps, message);
  };

  // Terrain
  const terrainResults = await runTerrainBenchmark(terrainResolutions, terrainRuns, wrapProgress);
  allResults.push(...terrainResults);

  // Rocks
  const rockResults = await runRockBenchmark(rockDetails, rockLibrarySize, rockRuns, wrapProgress);
  allResults.push(...rockResults);

  // Chunks
  const chunkResults = await runChunkBenchmark(chunkLods, chunkRuns, wrapProgress);
  allResults.push(...chunkResults);

  return allResults;
}
