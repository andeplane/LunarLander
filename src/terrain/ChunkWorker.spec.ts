import { describe, expect, it } from 'vitest';
import { ROCK_TIERS } from '../environment/rockPrototypes';
import type { RockGenerationConfig } from '../types';
import { createWorkerHeightProbe, generateRockPlacements, type RockPlacement } from './ChunkWorker';
import { forEachRock } from './rockPlacement';
import { generateTerrain, type TerrainArgs } from './terrain';

const terrainArgs: TerrainArgs = {
  seed: 42,
  gain: 0.5,
  lacunarity: 2.0,
  frequency: 0.01,
  amplitude: 10,
  altitude: 0,
  octaves: 4,
  smoothLowerPlanes: 0,
  width: 100,
  depth: 100,
  resolution: 32,
  posX: 0,
  posZ: 0,
  renderDistance: 5,
  craterSeed: 42,
  craterDensity: 0,
  craterMinRadius: 5,
  craterMaxRadius: 50,
  craterPowerLawExponent: -2.4,
  craterDepthRatio: 0.2,
  craterRimHeight: 0.3,
  craterRimWidth: 0.4,
  craterFloorFlatness: 0.5,
};

// 10x the production density so the 100x100 chunk gets ~100 rocks and the
// coarser-LOD subsets are non-trivial
const rockConfig: RockGenerationConfig = {
  minDiameter: 0.75,
  maxDiameter: 10.0,
  densityConstant: 0.005,
  powerLawExponent: -2.5,
  lodMinDiameterScale: [1.0, 1.3, 1.6, 2.0, 4.0, 6.0],
};

const LIBRARY_SIZE = 30;

/** One string key per rock instance: its exact matrix elements. */
function rockKeys(placements: RockPlacement[]): string[] {
  const keys: string[] = [];
  for (const { matrices } of placements) {
    for (let offset = 0; offset < matrices.length; offset += 16) {
      keys.push(Array.from(matrices.subarray(offset, offset + 16)).join(','));
    }
  }
  return keys;
}

function rockCount(placements: RockPlacement[]): number {
  return placements.reduce((sum, placement) => sum + placement.matrices.length / 16, 0);
}

/** Diameters of the chunk's rock population, straight from the enumeration. */
function populationDiameters(): number[] {
  const diameters: number[] = [];
  forEachRock(terrainArgs, rockConfig, (_x, _z, diameter) => {
    diameters.push(diameter);
  });
  return diameters;
}

function placementsAtLod(lodLevel: number): RockPlacement[] {
  const positions = generateTerrain(terrainArgs).attributes.position.array;
  return generateRockPlacements(positions, terrainArgs, lodLevel, '3,-2', LIBRARY_SIZE, rockConfig);
}

describe(generateRockPlacements.name, () => {
  it('keeps every rock identical across LOD levels (coarser LODs are a strict subset)', () => {
    // The bug this pins down: diameters were sampled from the LOD-dependent
    // range [lodMinDiameter, maxDiameter] off a shared LOD-independent RNG
    // stream, so the same rock re-rolled a different (smaller) size whenever
    // the chunk switched to a finer LOD — rocks visibly shrank on descent.
    const fine = rockKeys(placementsAtLod(0));
    const coarse = rockKeys(placementsAtLod(2));

    expect(fine.length).toBeGreaterThan(0);
    expect(coarse.length).toBeGreaterThan(0);
    expect(coarse.length).toBeLessThan(fine.length);

    const fineSet = new Set(fine);
    for (const key of coarse) {
      expect(fineSet.has(key)).toBe(true);
    }
  });

  it('filters by the LOD minimum diameter instead of re-sizing rocks', () => {
    const diameters = populationDiameters();
    expect(rockCount(placementsAtLod(0))).toBe(diameters.length);
    for (const lodLevel of [1, 3, 5]) {
      const lodMinDiameter = rockConfig.minDiameter * rockConfig.lodMinDiameterScale[lodLevel];
      // The LOD shows exactly the rocks at or above its minimum diameter
      expect(rockCount(placementsAtLod(lodLevel))).toBe(
        diameters.filter((d) => d >= lodMinDiameter).length
      );
    }
  });

  it('is deterministic for a given grid key', () => {
    expect(placementsAtLod(2)).toEqual(placementsAtLod(2));
  });

  it('rests the rocks on the worker height pipeline', () => {
    const placements = placementsAtLod(0);
    const probe = createWorkerHeightProbe(terrainArgs);
    for (const { matrices } of placements) {
      for (let offset = 0; offset < matrices.length; offset += 16) {
        const scaleY = Math.hypot(matrices[offset + 4], matrices[offset + 5], matrices[offset + 6]);
        const ground = probe(matrices[offset + 12], matrices[offset + 14]);
        // The base center is buried: a fraction of the height on gentle
        // ground, more where the uphill side digs into a steep slope
        expect(matrices[offset + 13]).toBeLessThan(ground + 0.05 * scaleY);
        expect(ground - matrices[offset + 13]).toBeLessThan(3 * scaleY);
      }
    }
  });

  it('describes every group with a tier, a shape and one tint per rock', () => {
    const placements = placementsAtLod(0);
    expect(placements.length).toBeGreaterThan(1);
    for (const placement of placements) {
      expect(placement.tier).toBeGreaterThanOrEqual(0);
      expect(placement.tier).toBeLessThan(ROCK_TIERS.length);
      expect(placement.prototypeId).toBeLessThan(LIBRARY_SIZE);
      expect(placement.colors.length).toBe((placement.matrices.length / 16) * 3);
    }
  });
});
