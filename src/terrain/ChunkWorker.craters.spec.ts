import { chunkSkirtDepth, skirtIndexCount, skirtVertexCount } from './chunkSkirt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RockGenerationConfig } from '../types';
import {
  type ChunkWorkerMessage,
  type ChunkWorkerResult,
  createWorkerHeightProbe,
  handleChunkMessage,
} from './ChunkWorker';
import { buildChunkMesh } from './chunkMesh';
import { craterParamsFromTerrainArgs, generateCratersForRegion } from './craters';
import { createHeightSampler } from './heightSampler';
import type { TerrainArgs } from './terrain';

/** Production settings (mirrors ChunkManager.baseTerrainArgs + main.ts). */
function chunkArgs(gridX: number, gridZ: number, resolution: number): TerrainArgs {
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
    resolution,
    posX: gridX * 400,
    posZ: gridZ * 400,
    renderDistance: 10,
    craterSeed: 42,
    craterDensity: 6000,
    craterMinRadius: 1,
    craterMaxRadius: 250,
    craterPowerLawExponent: -2,
    craterDepthRatio: 0.2,
    craterRimHeight: 0.04,
    craterRimWidth: 1.5,
    craterFloorFlatness: 0,
    craterDegradedDepthRatio: 0.04,
    craterFreshnessExponent: 3,
  };
}

const rockConfig: RockGenerationConfig = {
  minDiameter: 0.75,
  maxDiameter: 10.0,
  densityConstant: 0.0005,
  powerLawExponent: -2.5,
  lodMinDiameterScale: [1.0, 1.0, 1.0, 2.0, 4.0, 6.0],
};

/** Deterministic pseudo-random points in [-half, half]². */
function scatter(count: number, half: number): [number, number][] {
  const points: [number, number][] = [];
  let state = 12345;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let i = 0; i < count; i++) {
    points.push([(next() * 2 - 1) * half, (next() * 2 - 1) * half]);
  }
  return points;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(createWorkerHeightProbe.name, () => {
  it('returns exactly the heightSampler height everywhere in the chunk', () => {
    for (const [gridX, gridZ, resolution] of [
      [0, 0, 1024],
      [3, -2, 64],
      [-5, 7, 8],
    ] as const) {
      const args = chunkArgs(gridX, gridZ, resolution);
      const probe = createWorkerHeightProbe(args);
      const sampler = createHeightSampler(args);
      const bare = createHeightSampler({ ...args, craterDensity: 0 });

      let cratered = 0;
      for (const [x, z] of scatter(4000, 200)) {
        const worldX = x + args.posX;
        const worldZ = z + args.posZ;
        const expected = sampler.heightAt(worldX, worldZ);
        expect(probe(worldX - args.posX, worldZ - args.posZ)).toBe(expected);
        if (expected !== bare.heightAt(worldX, worldZ)) cratered++;
      }
      // Most of a saturated surface lies inside some crater's influence
      expect(cratered).toBeGreaterThan(1000);
    }
  });

  it('keeps sampling the cratered surface just outside the chunk (rock probes)', () => {
    const args = chunkArgs(1, 1, 32);
    const probe = createWorkerHeightProbe(args);
    const sampler = createHeightSampler(args);
    for (const [x, z] of [
      [202.5, 10],
      [-203.9, -77],
      [35, 201],
      [-120, -202.2],
    ] as const) {
      // The neighboring chunk owns these points in the height sampler
      expect(probe(x, z)).toBeCloseTo(sampler.heightAt(x + args.posX, z + args.posZ), 9);
    }
  });

  it('samples bare terrain when craters are disabled', () => {
    const args = { ...chunkArgs(2, 2, 16), craterDensity: 0 };
    const probe = createWorkerHeightProbe(args);
    const sampler = createHeightSampler(args);
    expect(probe(12, -40)).toBe(sampler.heightAt(812, 760));
  });

  it('reuses the crater cache for the same chunk and replaces it for another', () => {
    const args = chunkArgs(0, 0, 64);
    const first = createWorkerHeightProbe(args);
    const value = first(20, 30);
    // Same chunk at a coarser LOD needs a larger margin; a finer one does not
    expect(createWorkerHeightProbe({ ...args, resolution: 8 })(20, 30)).toBe(value);
    expect(createWorkerHeightProbe({ ...args, resolution: 512 })(20, 30)).toBe(value);

    const other = chunkArgs(6, 0, 64);
    expect(createWorkerHeightProbe(other)(20, 30)).toBe(
      createHeightSampler(other).heightAt(2420, 30)
    );
  });
});

describe('handleChunkMessage', () => {
  it('posts the chunk mesh built from the shared height pipeline', () => {
    const posted: { result: ChunkWorkerResult; transfer: Transferable[] }[] = [];
    vi.stubGlobal(
      'postMessage',
      (result: ChunkWorkerResult, options: { transfer: Transferable[] }) => {
        posted.push({ result, transfer: options.transfer });
      }
    );

    const terrainArgs = chunkArgs(2, -3, 32);
    const message: ChunkWorkerMessage = {
      terrainArgs,
      gridKey: '2,-3',
      lodLevel: 5,
      rockLibrarySize: 30,
      rockConfig,
    };
    handleChunkMessage(new MessageEvent<ChunkWorkerMessage>('message', { data: message }));

    expect(posted.length).toBe(1);
    const { result, transfer } = posted[0];
    expect(result.gridKey).toBe('2,-3');
    expect(result.lodLevel).toBe(5);
    expect(result.resolution).toBe(32);

    const expected = buildChunkMesh(
      terrainArgs,
      generateCratersForRegion('2,-3', 400, 400, craterParamsFromTerrainArgs(terrainArgs), 400 / 32),
      chunkSkirtDepth(400 / 32)
    );
    expect(Array.from(result.positions)).toEqual(Array.from(expected.positions));
    expect(Array.from(result.normals)).toEqual(Array.from(expected.normals));

    // Two triangles per grid cell, then the hanging skirt's wall
    expect(result.positions.length).toBe((33 * 33 + skirtVertexCount(32)) * 3);
    expect(result.index.length).toBe(32 * 32 * 6 + skirtIndexCount(32));
    expect(Math.max(...result.index.subarray(0, 32 * 32 * 6))).toBe(33 * 33 - 1);
    expect(Math.max(...result.index)).toBe(33 * 33 + skirtVertexCount(32) - 1);
    expect(Array.from(result.index.subarray(0, 6))).toEqual([0, 33, 1, 1, 33, 34]);

    expect(transfer).toContain(result.positions.buffer);
    expect(transfer).toContain(result.normals.buffer);
    expect(transfer).toContain(result.index.buffer);
  });
});
