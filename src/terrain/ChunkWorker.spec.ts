import { describe, it, expect } from 'vitest';
import { generateRockPlacements, type RockPlacement } from './ChunkWorker';
import { generateTerrain, type TerrainArgs } from './terrain';
import type { RockGenerationConfig } from '../types';

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
  lodMinDiameterScale: [1.0, 1.0, 1.0, 2.0, 4.0, 6.0],
};

const LIBRARY_SIZE = 30;

/** One string key per rock instance: prototype id + exact matrix elements. */
function rockKeys(placements: RockPlacement[]): string[] {
  const keys: string[] = [];
  for (const { prototypeId, matrices } of placements) {
    for (let offset = 0; offset < matrices.length; offset += 16) {
      keys.push(`${prototypeId}|${Array.from(matrices.subarray(offset, offset + 16)).join(',')}`);
    }
  }
  return keys;
}

/** Uniform scale (= rock diameter) encoded in a flat column-major Matrix4. */
function rockDiameters(placements: RockPlacement[]): number[] {
  const diameters: number[] = [];
  for (const { matrices } of placements) {
    for (let offset = 0; offset < matrices.length; offset += 16) {
      diameters.push(
        Math.hypot(matrices[offset], matrices[offset + 1], matrices[offset + 2])
      );
    }
  }
  return diameters;
}

function placementsAtLod(lodLevel: number): RockPlacement[] {
  const positions = generateTerrain(terrainArgs).attributes.position.array;
  return generateRockPlacements(
    positions,
    terrainArgs,
    lodLevel,
    '3,-2',
    LIBRARY_SIZE,
    rockConfig
  );
}

describe(generateRockPlacements.name, () => {
  it('keeps every rock identical across LOD levels (coarser LODs are a strict subset)', () => {
    // The bug this pins down: diameters were sampled from the LOD-dependent
    // range [lodMinDiameter, maxDiameter] off a shared LOD-independent RNG
    // stream, so the same rock re-rolled a different (smaller) size whenever
    // the chunk switched to a finer LOD — rocks visibly shrank on descent.
    const fine = rockKeys(placementsAtLod(0));
    const coarse = rockKeys(placementsAtLod(3));

    expect(fine.length).toBeGreaterThan(0);
    expect(coarse.length).toBeGreaterThan(0);
    expect(coarse.length).toBeLessThan(fine.length);

    const fineSet = new Set(fine);
    for (const key of coarse) {
      expect(fineSet.has(key)).toBe(true);
    }
  });

  it('filters by the LOD minimum diameter instead of re-sizing rocks', () => {
    const lodMinDiameter = rockConfig.minDiameter * rockConfig.lodMinDiameterScale[3];

    // Every rock shown at the coarse LOD is at least its minimum diameter...
    for (const diameter of rockDiameters(placementsAtLod(3))) {
      expect(diameter).toBeGreaterThanOrEqual(lodMinDiameter);
    }

    // ...and it shows exactly the fine-LOD rocks above that threshold
    const largeFineCount = rockDiameters(placementsAtLod(0)).filter(
      (d) => d >= lodMinDiameter
    ).length;
    expect(rockDiameters(placementsAtLod(3)).length).toBe(largeFineCount);
  });

  it('is deterministic for a given grid key', () => {
    expect(rockKeys(placementsAtLod(2))).toEqual(rockKeys(placementsAtLod(2)));
  });
});
