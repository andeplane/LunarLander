import { describe, expect, it } from 'vitest';
import {
  applyCratersToHeightBuffer,
  type Crater,
  type CraterParams,
  generateCratersForRegion,
  parseGridKey,
} from './craters';
import { createHeightSampler, type HeightSamplerConfig } from './heightSampler';
import { generateTerrain, type TerrainArgs } from './terrain';

/**
 * Production-like config (mirrors ChunkManager.baseTerrainArgs / main.ts),
 * with a bounded crater size so mesh heights stay in a range where float32
 * vertex storage keeps ~1e-6 absolute precision, and a density high enough
 * that every tested chunk actually contains craters.
 */
const baseConfig: HeightSamplerConfig = {
  seed: 0,
  gain: 0.5,
  lacunarity: 2,
  frequency: 0.015,
  amplitude: 1.0,
  altitude: 0.1,
  octaves: 4,
  smoothLowerPlanes: 0,
  width: 400,
  depth: 400,
  renderDistance: 10,
  craterSeed: 42,
  craterDensity: 400,
  craterMinRadius: 5,
  craterMaxRadius: 40,
  craterPowerLawExponent: -2.2,
  craterDepthRatio: 0.15,
  craterRimHeight: 0.3,
  craterRimWidth: 0.2,
  craterFloorFlatness: 0,
};

function craterParamsFrom(config: HeightSamplerConfig): CraterParams {
  return {
    seed: config.craterSeed,
    density: config.craterDensity,
    minRadius: config.craterMinRadius,
    maxRadius: config.craterMaxRadius,
    powerLawExponent: config.craterPowerLawExponent,
    depthRatio: config.craterDepthRatio,
    rimHeight: config.craterRimHeight,
    rimWidth: config.craterRimWidth,
    floorFlatness: config.craterFloorFlatness,
  };
}

/**
 * Build a chunk mesh height buffer exactly the way the chunk worker does
 * (see handleChunkMessage in ChunkWorker.ts): base terrain via
 * generateTerrain, then cached region craters converted to local chunk space
 * and applied to the height buffer. (The worker additionally generates a
 * one-vertex skirt, but that only affects normals — interior vertex heights
 * are a pure function of vertex x/z, which we read back from the buffer.)
 */
function buildChunkMeshLikeWorker(
  config: HeightSamplerConfig,
  gridKey: string,
  resolution: number
): { positions: Float32Array; posX: number; posZ: number; craters: Crater[] } {
  const [gridX, gridZ] = parseGridKey(gridKey);
  const terrainArgs: TerrainArgs = {
    ...config,
    resolution,
    posX: gridX * config.width,
    posZ: gridZ * config.depth,
  };

  const craters = generateCratersForRegion(
    gridKey,
    config.width,
    config.depth,
    craterParamsFrom(config)
  );

  const geometry = generateTerrain(terrainArgs, false);
  const positions = geometry.attributes.position.array as Float32Array;

  const localCraters: Crater[] = craters.map((crater) => ({
    ...crater,
    centerX: crater.centerX - terrainArgs.posX,
    centerZ: crater.centerZ - terrainArgs.posZ,
  }));
  applyCratersToHeightBuffer(positions, config.width, config.depth, localCraters);

  return { positions, posX: terrainArgs.posX, posZ: terrainArgs.posZ, craters };
}

describe(createHeightSampler.name, () => {
  it('matches actual built-mesh vertex heights (base FBM + strength + craters)', () => {
    const gridKey = '3,-2';
    const { positions, posX, posZ, craters } = buildChunkMeshLikeWorker(baseConfig, gridKey, 64);

    // Guard against a vacuous pass: the tested chunk must contain craters
    expect(craters.length).toBeGreaterThan(0);

    const sampler = createHeightSampler(baseConfig);

    const vertexCount = positions.length / 3;
    let maxError = 0;
    for (let i = 0; i < vertexCount; i++) {
      const worldX = posX + positions[i * 3];
      const worldZ = posZ + positions[i * 3 + 2];
      const meshHeight = positions[i * 3 + 1];
      const sampledHeight = sampler.heightAt(worldX, worldZ);
      maxError = Math.max(maxError, Math.abs(sampledHeight - meshHeight));
    }
    expect(maxError).toBeLessThanOrEqual(1e-6);

    // Sanity: craters actually shaped this mesh (some vertex differs from
    // the crater-free base terrain), so the crater branch was exercised
    const craterFree = createHeightSampler({ ...baseConfig, craterDensity: 0 });
    let maxCraterEffect = 0;
    for (let i = 0; i < vertexCount; i++) {
      const worldX = posX + positions[i * 3];
      const worldZ = posZ + positions[i * 3 + 2];
      maxCraterEffect = Math.max(
        maxCraterEffect,
        Math.abs(sampler.heightAt(worldX, worldZ) - craterFree.heightAt(worldX, worldZ))
      );
    }
    expect(maxCraterEffect).toBeGreaterThan(0.5);
  });

  it('is deterministic: two instances with the same config agree exactly', () => {
    const a = createHeightSampler(baseConfig);
    const b = createHeightSampler(baseConfig);

    const points: [number, number][] = [
      [0, 0],
      [12.34, -56.78],
      [199.99, 200.01], // chunk corner neighborhood
      [-1234.5, 987.6],
      [3 * 400 + 17, -2 * 400 - 133],
      [0.001, -0.001],
    ];

    for (const [x, z] of points) {
      // Across instances
      expect(a.heightAt(x, z)).toBe(b.heightAt(x, z));
      expect(a.slopeAt(x, z)).toBe(b.slopeAt(x, z));
      // Across repeated calls on the same instance (cache must not drift)
      expect(a.heightAt(x, z)).toBe(a.heightAt(x, z));
    }
  });

  it('is continuous across chunk boundaries (no seam)', () => {
    const sampler = createHeightSampler(baseConfig);
    const epsilon = 0.001;

    // Boundary between chunk (0,0) and (1,0) lies at x = 0.5 * chunkWidth
    const boundaryX = 0.5 * baseConfig.width;
    for (const z of [-180, -55, 0, 42.5, 177]) {
      const west = sampler.heightAt(boundaryX - epsilon, z);
      const east = sampler.heightAt(boundaryX + epsilon, z);
      expect(Math.abs(east - west)).toBeLessThan(0.01);
    }

    // Boundary between chunk (0,0) and (0,-1) lies at z = -0.5 * chunkDepth
    const boundaryZ = -0.5 * baseConfig.depth;
    for (const x of [-150, -20, 0, 66, 190]) {
      const north = sampler.heightAt(x, boundaryZ - epsilon);
      const south = sampler.heightAt(x, boundaryZ + epsilon);
      expect(Math.abs(south - north)).toBeLessThan(0.01);
    }
  });

  describe('slopeAt', () => {
    it('returns near-zero degrees on flat terrain', () => {
      // Zero main-noise amplitude and no craters: only the low-frequency
      // altitude-variation field baked into createTerrainEvaluator remains,
      // which contributes at most ~1 degree of slope
      const flatConfig: HeightSamplerConfig = {
        ...baseConfig,
        amplitude: 0,
        craterDensity: 0,
      };
      const sampler = createHeightSampler(flatConfig);

      for (const [x, z] of [
        [0, 0],
        [123, -456],
        [-789, 321],
      ] as const) {
        expect(sampler.slopeAt(x, z)).toBeLessThan(2);
      }
    });

    it('returns a large slope in degrees on a crater wall', () => {
      const sampler = createHeightSampler(baseConfig);

      // Deterministically pick a sizable crater from the chunk-(0,0) region
      // and probe its inner bowl wall, where the profile is steepest
      const craters = generateCratersForRegion(
        '0,0',
        baseConfig.width,
        baseConfig.depth,
        craterParamsFrom(baseConfig)
      );
      const bigCrater = craters.reduce((a, b) => (b.radius > a.radius ? b : a));
      expect(bigCrater.radius).toBeGreaterThan(baseConfig.craterMinRadius);

      const wallX = bigCrater.centerX + 0.75 * bigCrater.radius;
      const wallSlope = sampler.slopeAt(wallX, bigCrater.centerZ);
      expect(wallSlope).toBeGreaterThan(5);
      expect(wallSlope).toBeLessThanOrEqual(90);
    });

    it('equals atan of the central-difference gradient, in degrees', () => {
      const sampler = createHeightSampler(baseConfig);

      const check = (x: number, z: number, baselineM: number) => {
        const half = baselineM / 2;
        const gradX = (sampler.heightAt(x + half, z) - sampler.heightAt(x - half, z)) / baselineM;
        const gradZ = (sampler.heightAt(x, z + half) - sampler.heightAt(x, z - half)) / baselineM;
        const expected = Math.atan(Math.hypot(gradX, gradZ)) * (180 / Math.PI);
        return expected;
      };

      // Default baseline (1.5 m)
      expect(sampler.slopeAt(37, -81)).toBeCloseTo(check(37, -81, 1.5), 12);
      // Explicit baseline
      expect(sampler.slopeAt(37, -81, 4)).toBeCloseTo(check(37, -81, 4), 12);
      expect(sampler.slopeAt(-260, 143, 0.5)).toBeCloseTo(check(-260, 143, 0.5), 12);
    });
  });
});
