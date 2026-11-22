import { describe, expect, it } from 'vitest';
import { buildChunkMesh } from './chunkMesh';
import {
  type Crater,
  craterParamsFromTerrainArgs,
  generateCratersForRegion,
  LOD_FADE_END,
  parseGridKey,
} from './craters';
import { createHeightSampler, type HeightSamplerConfig } from './heightSampler';
import type { TerrainArgs } from './terrain';

/**
 * Production config (mirrors ChunkManager.baseTerrainArgs / main.ts).
 */
const baseConfig: HeightSamplerConfig = {
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

/**
 * Build a chunk mesh exactly the way the chunk worker does (see
 * handleChunkMessage in ChunkWorker.ts): region craters with one vertex
 * spacing of margin, then buildChunkMesh.
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
    craterParamsFromTerrainArgs(config),
    Math.max(config.width, config.depth) / resolution
  );
  const { positions } = buildChunkMesh(terrainArgs, craters);

  return { positions, posX: terrainArgs.posX, posZ: terrainArgs.posZ, craters };
}

describe(createHeightSampler.name, () => {
  it('matches actual built-mesh vertex heights (base terrain + strength + craters)', () => {
    const gridKey = '3,-2';
    // The mesh fades out craters smaller than 2.5 vertex spacings (LOD
    // filter); with 128 segments that is 7.8 m, so start the population at
    // 8 m to compare the full pipeline vertex by vertex
    const resolution = 128;
    const config: HeightSamplerConfig = { ...baseConfig, craterMinRadius: 8 };
    expect(config.craterMinRadius).toBeGreaterThanOrEqual(
      (LOD_FADE_END * config.width) / resolution
    );
    const { positions, posX, posZ, craters } = buildChunkMeshLikeWorker(
      config,
      gridKey,
      resolution
    );

    // Guard against a vacuous pass: the tested chunk must contain craters
    expect(craters.length).toBeGreaterThan(0);

    const sampler = createHeightSampler(config);

    // The mesh stores float32, and evaluates the very same float64 expression
    const vertexCount = positions.length / 3;
    for (let i = 0; i < vertexCount; i++) {
      const worldX = posX + positions[i * 3];
      const worldZ = posZ + positions[i * 3 + 2];
      expect(positions[i * 3 + 1]).toBe(Math.fround(sampler.heightAt(worldX, worldZ)));
    }

    // Sanity: craters actually shaped this mesh (some vertex differs from
    // the crater-free base terrain), so the crater branch was exercised
    const craterFree = createHeightSampler({ ...config, craterDensity: 0 });
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

  it('point-samples every crater, including those a coarse mesh leaves out', () => {
    // Only craters far too small for a 16-segment mesh (25 m spacing)
    const config: HeightSamplerConfig = { ...baseConfig, craterMaxRadius: 6 };
    const { positions, posX, posZ } = buildChunkMeshLikeWorker(config, '0,0', 16);
    const sampler = createHeightSampler(config);
    const craterFree = createHeightSampler({ ...config, craterDensity: 0 });

    let differing = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const worldX = posX + positions[i];
      const worldZ = posZ + positions[i + 2];
      // The mesh is the crater-free surface...
      expect(positions[i + 1]).toBe(Math.fround(craterFree.heightAt(worldX, worldZ)));
      // ...while the sampler still sees the small craters
      if (sampler.heightAt(worldX, worldZ) !== craterFree.heightAt(worldX, worldZ)) differing++;
    }
    expect(differing).toBeGreaterThan(20);
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
      // No fine noise, no relief and no craters: a perfectly level surface
      const flatConfig: HeightSamplerConfig = {
        ...baseConfig,
        amplitude: 0,
        rollingAmplitude: 0,
        massifHeight: 0,
        craterDensity: 0,
      };
      const sampler = createHeightSampler(flatConfig);

      for (const [x, z] of [
        [0, 0],
        [123, -456],
        [-789, 321],
      ] as const) {
        expect(sampler.slopeAt(x, z)).toBe(0);
      }
    });

    it('returns a large slope in degrees on a crater wall', () => {
      const sampler = createHeightSampler(baseConfig);

      // Deterministically pick a sizable fresh crater from the chunk-(0,0)
      // region and probe its inner bowl wall, where the profile is steepest
      const craters = generateCratersForRegion(
        '0,0',
        baseConfig.width,
        baseConfig.depth,
        craterParamsFromTerrainArgs(baseConfig)
      );
      const bigCrater = craters
        .filter((crater) => crater.radius > 10 && crater.radius < 100)
        .reduce((a, b) => (b.freshness > a.freshness ? b : a));
      expect(bigCrater.freshness).toBeGreaterThan(0.5);

      const wallX = bigCrater.centerX + 0.75 * bigCrater.radius;
      const wallSlope = sampler.slopeAt(wallX, bigCrater.centerZ);
      expect(wallSlope).toBeGreaterThan(10);
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
