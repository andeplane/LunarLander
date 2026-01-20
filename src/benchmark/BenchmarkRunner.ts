/**
 * BenchmarkRunner - Core benchmark execution logic for terrain, rocks, and chunks.
 * 
 * Provides timing measurements for:
 * - Terrain generation at various resolutions
 * - Rock geometry generation at various detail levels
 * - Full chunk generation (terrain + craters + rock placements)
 */

import { generateTerrain, type TerrainArgs } from '../terrain/terrain';
import { applyCratersToHeightBuffer, generateCratersForRegion, type CraterParams } from '../terrain/craters';
import { RockBuilder } from '../environment/RockBuilder';

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
    falloff: 0,
    erosion: 0.3,
    erosionSoftness: 0.5,
    rivers: 0,
    riversFrequency: 0.1,
    riverWidth: 0.3,
    lakes: 0,
    lakesFalloff: 0.1,
    riverFalloff: 0.1,
    smoothLowerPlanes: 0.5,
    octaves: 6,
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
 * Calculate statistics from an array of times
 */
function calculateStats(times: number[]): { mean: number; min: number; max: number; median: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  
  return { mean, min, max, median };
}

/**
 * Run terrain generation benchmark at various resolutions
 */
export async function runTerrainBenchmark(
  resolutions: number[],
  iterations: number,
  onProgress?: ProgressCallback
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const total = resolutions.length * iterations;
  let current = 0;
  
  for (const resolution of resolutions) {
    const times: number[] = [];
    const terrainArgs = getDefaultTerrainArgs(resolution);
    const craterParams = getDefaultCraterParams();
    const gridKey = '0,0';
    
    let vertices = 0;
    let triangles = 0;
    
    for (let i = 0; i < iterations; i++) {
      onProgress?.(++current, total, `Terrain ${resolution}x${resolution}, iteration ${i + 1}/${iterations}`);
      
      // Allow UI to update
      await new Promise(resolve => setTimeout(resolve, 0));
      
      const start = performance.now();
      
      // Generate terrain
      const geometry = generateTerrain(terrainArgs);
      
      // Generate and apply craters
      const craters = generateCratersForRegion(gridKey, terrainArgs.width, terrainArgs.depth, craterParams);
      const positions = geometry.attributes.position.array as Float32Array;
      applyCratersToHeightBuffer(positions, terrainArgs.width, terrainArgs.depth, craters);
      
      // Recompute normals
      geometry.computeVertexNormals();
      
      const end = performance.now();
      times.push(end - start);
      
      // Capture geometry info on last iteration
      if (i === iterations - 1) {
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
  const total = detailLevels.length * iterations;
  let current = 0;
  
  for (const detail of detailLevels) {
    const times: number[] = [];
    let triangles = 0;
    
    // Calculate expected triangle count: 20 * (detail + 1)^2
    const expectedTriangles = 20 * (detail + 1) ** 2;
    
    for (let i = 0; i < iterations; i++) {
      onProgress?.(++current, total, `Rocks detail=${detail}, library=${librarySize}, iteration ${i + 1}/${iterations}`);
      
      // Allow UI to update
      await new Promise(resolve => setTimeout(resolve, 0));
      
      const start = performance.now();
      
      // Generate rock library
      const geometries = RockBuilder.generateLibrary(librarySize, { detail });
      
      const end = performance.now();
      times.push(end - start);
      
      // Capture geometry info on last iteration
      if (i === iterations - 1 && geometries.length > 0) {
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
 * LOD levels mapping to terrain resolutions
 */
const LOD_RESOLUTIONS = [2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4];

/**
 * Run full chunk generation benchmark (terrain + craters + rock placement simulation)
 */
export async function runChunkBenchmark(
  lodLevels: number[],
  iterations: number,
  onProgress?: ProgressCallback
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const total = lodLevels.length * iterations;
  let current = 0;
  
  for (const lodLevel of lodLevels) {
    const times: number[] = [];
    const resolution = LOD_RESOLUTIONS[lodLevel] ?? 16;
    const terrainArgs = getDefaultTerrainArgs(resolution);
    const craterParams = getDefaultCraterParams();
    const gridKey = '0,0';
    
    let vertices = 0;
    let triangles = 0;
    
    for (let i = 0; i < iterations; i++) {
      onProgress?.(++current, total, `Chunk LOD ${lodLevel} (${resolution}×${resolution}), iteration ${i + 1}/${iterations}`);
      
      // Allow UI to update
      await new Promise(resolve => setTimeout(resolve, 0));
      
      const start = performance.now();
      
      // 1. Generate terrain
      const geometry = generateTerrain(terrainArgs);
      
      // 2. Generate and apply craters
      const craters = generateCratersForRegion(gridKey, terrainArgs.width, terrainArgs.depth, craterParams);
      const positions = geometry.attributes.position.array as Float32Array;
      applyCratersToHeightBuffer(positions, terrainArgs.width, terrainArgs.depth, craters);
      
      // 3. Recompute normals
      geometry.computeVertexNormals();
      
      // 4. Simulate rock placement computation (just the height sampling overhead)
      // In real worker, this involves sampling heights for rock positions
      // We'll simulate by doing some terrain height lookups
      const rockCount = Math.floor(terrainArgs.width * terrainArgs.depth * 0.0001); // ~16 rocks per chunk
      for (let r = 0; r < rockCount; r++) {
        // Simulate height sampling at random positions
        const _x = (Math.random() - 0.5) * terrainArgs.width;
        const _z = (Math.random() - 0.5) * terrainArgs.depth;
        // Just do some math to simulate work
        Math.sqrt(_x * _x + _z * _z);
      }
      
      const end = performance.now();
      times.push(end - start);
      
      // Capture geometry info on last iteration
      if (i === iterations - 1) {
        vertices = geometry.attributes.position.count;
        triangles = geometry.index ? geometry.index.count / 3 : vertices / 3;
      }
      
      // Cleanup
      geometry.dispose();
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
  
  return results;
}

/**
 * Run all benchmarks with default settings
 */
export async function runAllBenchmarks(
  terrainResolutions: number[],
  rockDetails: number[],
  rockLibrarySize: number,
  chunkLods: number[],
  iterations: number,
  onProgress?: ProgressCallback
): Promise<BenchmarkResult[]> {
  const allResults: BenchmarkResult[] = [];
  
  const totalSteps = 
    terrainResolutions.length * iterations +
    rockDetails.length * iterations +
    chunkLods.length * iterations;
  let currentStep = 0;
  
  // Wrap progress to accumulate across all benchmarks
  const wrapProgress = (_current: number, _total: number, message: string) => {
    currentStep++;
    onProgress?.(currentStep, totalSteps, message);
  };
  
  // Terrain
  const terrainResults = await runTerrainBenchmark(terrainResolutions, iterations, wrapProgress);
  allResults.push(...terrainResults);
  
  // Rocks
  const rockResults = await runRockBenchmark(rockDetails, rockLibrarySize, iterations, wrapProgress);
  allResults.push(...rockResults);
  
  // Chunks
  const chunkResults = await runChunkBenchmark(chunkLods, iterations, wrapProgress);
  allResults.push(...chunkResults);
  
  return allResults;
}
