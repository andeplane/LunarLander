/**
 * Chunk generation benchmark (NOT part of the normal test run).
 *
 *   npx vitest bench --run src/terrain/chunkGeneration.bench.ts
 *
 * Times the worker's terrain pipeline (crater region + mesh build: base
 * terrain, crater rasterization, normals) per LOD with production settings,
 * plus the point-sampling path used by rock placement and the pad search.
 * Chunks rotate so crater cell caches see a realistic mix of hits and misses.
 */
import { bench, describe } from 'vitest';
import { buildChunkMesh } from './chunkMesh';
import {
  buildCraterIndex,
  clearCraterCellCache,
  craterParamsFromTerrainArgs,
  generateCratersForRegion,
  sampleCraterIndex,
} from './craters';
import { createHeightSampler } from './heightSampler';
import type { TerrainArgs } from './terrain';

/** Mirrors ChunkManager.baseTerrainArgs + craterGeneration in main.ts. */
function productionTerrainArgs(resolution: number, gridX: number, gridZ: number): TerrainArgs {
  return {
    seed: 0,
    gain: 0.4,
    lacunarity: 2,
    frequency: 0.015,
    amplitude: 0.4,
    altitude: 0.1,
    octaves: 4,
    smoothLowerPlanes: 0,
    width: 400,
    depth: 400,
    renderDistance: 10,
    resolution,
    posX: gridX * 400,
    posZ: gridZ * 400,
    craterSeed: 42,
    craterDensity: 8400,
    craterBreakRadius: 150,
    craterMinRadius: 1,
    craterMaxRadius: 1000,
    craterPowerLawExponent: -2,
    craterDepthRatio: 0.2,
    craterRimHeight: 0.04,
    craterRimWidth: 1.5,
    craterFloorFlatness: 0,
  };
}

let chunkCounter = 0;

function buildChunk(resolution: number): number {
  const gridX = (chunkCounter++ % 3) - 1;
  const gridZ = 2;
  const args = productionTerrainArgs(resolution, gridX, gridZ);
  const craters = generateCratersForRegion(
    `${gridX},${gridZ}`,
    args.width,
    args.depth,
    craterParamsFromTerrainArgs(args),
    args.width / resolution + 4
  );
  return buildChunkMesh(args, craters).positions.length;
}

describe('chunk terrain generation (crater region + mesh + normals)', () => {
  bench('LOD0 1024', () => void buildChunk(1024), { iterations: 9, time: 0, warmupIterations: 3 });
  bench('LOD1 512', () => void buildChunk(512), { iterations: 12, time: 0, warmupIterations: 3 });
  bench('LOD2 256', () => void buildChunk(256), { iterations: 15, time: 0, warmupIterations: 3 });
  bench('LOD5 32', () => void buildChunk(32), { iterations: 60, time: 0, warmupIterations: 5 });
  bench(
    'LOD5 32, cold crater cell cache',
    () => {
      clearCraterCellCache();
      buildChunk(32);
    },
    { iterations: 30, time: 0, warmupIterations: 3 }
  );
});

describe('point sampling', () => {
  const args = productionTerrainArgs(64, 1, 2);
  const craters = generateCratersForRegion('1,2', 400, 400, craterParamsFromTerrainArgs(args), 10);
  const index = buildCraterIndex(craters, 190, 590, 610, 1010);
  const sampler = createHeightSampler(args);

  bench('crater index build (one chunk)', () => {
    buildCraterIndex(craters, 190, 590, 610, 1010);
  });
  bench('20k crater index samples', () => {
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      sum += sampleCraterIndex(index, 200 + (i % 400), 600 + ((i * 7) % 400));
    }
    if (Number.isNaN(sum)) throw new Error('NaN crater height');
  });
  bench('20k heightSampler.heightAt samples', () => {
    let sum = 0;
    for (let i = 0; i < 20000; i++) {
      sum += sampler.heightAt(200 + (i % 400), 600 + ((i * 7) % 400));
    }
    if (Number.isNaN(sum)) throw new Error('NaN height');
  });
});
