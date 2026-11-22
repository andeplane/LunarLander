import { describe, expect, it } from 'vitest';
import {
  ROCK_TIERS,
  rockHeightRatio,
  rockTriangleBudget,
  shapeCountFor,
  sizeTierForDiameter,
} from '../environment/rockPrototypes';
import type { RockGenerationConfig } from '../types';
import {
  expectedRockCount,
  forEachRock,
  placeRocks,
  ROCK_FIELD_DEFAULTS,
  type RockChunk,
  type RockHeightSampler,
  type RockPlacement,
  rockDensityMultiplier,
  rockFieldMask,
  rockMinDiameterForLod,
} from './rockPlacement';

const LIBRARY_SIZE = 30;
const LAST_TIER = ROCK_TIERS.length - 1;

/** The production configuration (see src/main.ts). */
const config: RockGenerationConfig = {
  minDiameter: 0.33,
  maxDiameter: 12,
  densityConstant: 0.00048,
  powerLawExponent: -2.1,
  lodMinDiameterScale: [1, 1.5, 2.5, 4.5, 9, 18, 40],
};

const GROUND = 10;
const flat: RockHeightSampler = () => GROUND;

function chunkAt(gridX: number, gridZ: number, seed = 42): RockChunk {
  return { seed, width: 400, depth: 400, posX: gridX * 400, posZ: gridZ * 400 };
}

interface Rock {
  x: number;
  z: number;
  diameter: number;
}

function population(chunk: RockChunk, rockConfig: RockGenerationConfig = config): Rock[] {
  const rocks: Rock[] = [];
  forEachRock(chunk, rockConfig, (x, z, diameter) => {
    rocks.push({ x, z, diameter });
  });
  return rocks;
}

function instanceCount(placements: readonly RockPlacement[]): number {
  return placements.reduce((sum, placement) => sum + placement.matrices.length / 16, 0);
}

function triangleCount(placements: readonly RockPlacement[]): number {
  return placements.reduce(
    (sum, placement) =>
      sum +
      (placement.matrices.length / 16) * rockTriangleBudget(ROCK_TIERS[placement.tier].detail),
    0
  );
}

/** One decoded rock instance of a placement group. */
interface Instance {
  prototypeId: number;
  tier: number;
  axisX: number[];
  axisY: number[];
  axisZ: number[];
  position: number[];
  color: number[];
}

function instances(placements: readonly RockPlacement[]): Instance[] {
  const result: Instance[] = [];
  for (const { prototypeId, tier, matrices, colors } of placements) {
    for (let i = 0; i < matrices.length / 16; i++) {
      const m = Array.from(matrices.subarray(i * 16, i * 16 + 16));
      result.push({
        prototypeId,
        tier,
        axisX: m.slice(0, 3),
        axisY: m.slice(4, 7),
        axisZ: m.slice(8, 11),
        position: m.slice(12, 15),
        color: Array.from(colors.subarray(i * 3, i * 3 + 3)),
      });
    }
  }
  return result;
}

const length = (v: number[]): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Fraction of the rock's height that is below the (flat) ground. */
function burialFraction(instance: Instance): number {
  const scaleY = length(instance.axisY);
  const upY = instance.axisY[1] / scaleY;
  const sink = (GROUND - instance.position[1]) / upY;
  return sink / (rockHeightRatio(instance.prototypeId) * scaleY);
}

/** A config whose rocks all fall into one size range. */
function sizedConfig(
  minDiameter: number,
  maxDiameter: number,
  densityConstant: number
): RockGenerationConfig {
  return { ...config, minDiameter, maxDiameter, densityConstant, lodMinDiameterScale: [1] };
}

describe(rockFieldMask.name, () => {
  it('stays in [0, 1], with open plains and saturated fields both present', () => {
    let zeros = 0;
    let ones = 0;
    let sum = 0;
    const samples = 200 * 200;
    for (let i = 0; i < 200; i++) {
      for (let j = 0; j < 200; j++) {
        const value = rockFieldMask(42, i * 61.3 - 6000, j * 57.1 - 6000, 450);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        sum += value;
        if (value === 0) zeros++;
        if (value > 0.95) ones++;
      }
    }
    expect(zeros / samples).toBeGreaterThan(0.3);
    expect(ones / samples).toBeGreaterThan(0.01);
    // The mean the density normalization relies on
    expect(sum / samples).toBeGreaterThan(0.18);
    expect(sum / samples).toBeLessThan(0.29);
  });

  it('is a deterministic function of seed and world position', () => {
    const a = rockFieldMask(1, 123.4, -567.8, 450);
    const other = rockFieldMask(2, 123.4, -567.8, 450);
    expect(rockFieldMask(1, 123.4, -567.8, 450)).toBe(a);
    // Switching seeds and back rebuilds the same noise
    expect(rockFieldMask(1, 123.4, -567.8, 450)).toBe(a);
    let differs = other !== a;
    for (let i = 0; i < 50 && !differs; i++) {
      differs = rockFieldMask(1, i * 97, i * 31, 450) !== rockFieldMask(2, i * 97, i * 31, 450);
    }
    expect(differs).toBe(true);
  });

  it('varies slowly: fields are hundreds of meters across', () => {
    let largestStep = 0;
    for (let i = 0; i < 2000; i++) {
      const x = i * 13.7 - 9000;
      largestStep = Math.max(
        largestStep,
        Math.abs(rockFieldMask(42, x + 5, 77, 450) - rockFieldMask(42, x, 77, 450))
      );
    }
    expect(largestStep).toBeLessThan(0.2);
  });
});

describe(rockDensityMultiplier.name, () => {
  it('averages to one and spans the plains / field contrast', () => {
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    const n = 300;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const value = rockDensityMultiplier(42, config, i * 53.3 - 8000, j * 47.9 - 8000);
        sum += value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    expect(sum / (n * n)).toBeGreaterThan(0.85);
    expect(sum / (n * n)).toBeLessThan(1.15);
    const { fieldPeakDensity, plainsDensity } = ROCK_FIELD_DEFAULTS;
    expect(max / min).toBeCloseTo(fieldPeakDensity / plainsDensity, 5);
  });

  it('is uniform when plains and fields have the same weight', () => {
    const uniform: RockGenerationConfig = { ...config, fieldPeakDensity: 2, plainsDensity: 2 };
    expect(rockDensityMultiplier(42, uniform, 10, 20)).toBeCloseTo(1, 10);
    expect(rockDensityMultiplier(42, uniform, -900, 3000)).toBeCloseTo(1, 10);
  });

  it('clamps the plains weight to the peak weight', () => {
    const inverted: RockGenerationConfig = { ...config, fieldPeakDensity: 1, plainsDensity: 5 };
    expect(rockDensityMultiplier(42, inverted, 10, 20)).toBeCloseTo(1, 10);
  });
});

describe(rockMinDiameterForLod.name, () => {
  it('scales the minimum diameter per LOD and reuses the last entry beyond the list', () => {
    expect(rockMinDiameterForLod(config, 0)).toBeCloseTo(0.33, 10);
    expect(rockMinDiameterForLod(config, 3)).toBeCloseTo(0.33 * 4.5, 10);
    expect(rockMinDiameterForLod(config, 12)).toBeCloseTo(0.33 * 40, 10);
    expect(rockMinDiameterForLod(config, -2)).toBeCloseTo(0.33, 10);
  });

  it('falls back to the configured minimum without a scale list', () => {
    expect(rockMinDiameterForLod({ ...config, lodMinDiameterScale: [] }, 4)).toBe(0.33);
  });
});

describe(expectedRockCount.name, () => {
  it('follows the truncated power law', () => {
    const area = 400 * 400;
    expect(expectedRockCount(config, area)).toBeCloseTo(
      0.00048 * area * (0.33 ** -2.1 - 12 ** -2.1),
      6
    );
    expect(expectedRockCount(config, area, 1)).toBeCloseTo(0.00048 * area * (1 - 12 ** -2.1), 6);
    // Diameters below the minimum count from the minimum
    expect(expectedRockCount(config, area, 0.1)).toBe(expectedRockCount(config, area));
    expect(expectedRockCount(config, area, 12)).toBe(0);
    expect(expectedRockCount(config, area, 50)).toBe(0);
  });
});

describe(forEachRock.name, () => {
  it('is deterministic and independent of what was enumerated before', () => {
    const first = population(chunkAt(3, -2));
    population(chunkAt(0, 0));
    population(chunkAt(3, -2, 7));
    expect(population(chunkAt(3, -2))).toEqual(first);
    expect(first.length).toBeGreaterThan(100);
  });

  it('depends on the terrain seed and the chunk', () => {
    const base = population(chunkAt(1, 1));
    expect(population(chunkAt(1, 1, 43))).not.toEqual(base);
    expect(population(chunkAt(1, 2))).not.toEqual(base);
  });

  it('keeps every rock inside its chunk and inside the diameter range', () => {
    for (const rock of population(chunkAt(-4, 5))) {
      expect(Math.abs(rock.x)).toBeLessThanOrEqual(200);
      expect(Math.abs(rock.z)).toBeLessThanOrEqual(200);
      expect(rock.diameter).toBeGreaterThanOrEqual(config.minDiameter);
      expect(rock.diameter).toBeLessThanOrEqual(config.maxDiameter);
    }
  });

  it('averages 600-1200 rocks per chunk, matching the power law, with sparse and dense chunks', () => {
    const counts: number[] = [];
    let aboveOneMeter = 0;
    let aboveThreeMeters = 0;
    for (let gx = -8; gx < 8; gx++) {
      for (let gz = -8; gz < 8; gz++) {
        const rocks = population(chunkAt(gx, gz));
        counts.push(rocks.length);
        aboveOneMeter += rocks.filter((rock) => rock.diameter >= 1).length;
        aboveThreeMeters += rocks.filter((rock) => rock.diameter >= 3).length;
      }
    }
    const chunks = counts.length;
    const mean = counts.reduce((sum, count) => sum + count, 0) / chunks;
    const area = 400 * 400;
    expect(mean).toBeGreaterThan(600);
    expect(mean).toBeLessThan(1200);
    expect(mean / expectedRockCount(config, area)).toBeGreaterThan(0.8);
    expect(mean / expectedRockCount(config, area)).toBeLessThan(1.2);
    expect(aboveOneMeter / chunks / expectedRockCount(config, area, 1)).toBeGreaterThan(0.75);
    expect(aboveOneMeter / chunks / expectedRockCount(config, area, 1)).toBeLessThan(1.25);
    expect(aboveThreeMeters / chunks / expectedRockCount(config, area, 3)).toBeGreaterThan(0.7);
    expect(aboveThreeMeters / chunks / expectedRockCount(config, area, 3)).toBeLessThan(1.3);
    // Clustering: boulder fields hold several times more rocks than the plains
    expect(Math.max(...counts) / Math.min(...counts)).toBeGreaterThan(3);
  });

  it('follows the boulder-field density inside a chunk', () => {
    let inFields = 0;
    let onPlains = 0;
    let fieldArea = 0;
    let plainsArea = 0;
    for (let gx = 0; gx < 6; gx++) {
      for (let gz = 0; gz < 6; gz++) {
        const chunk = chunkAt(gx, gz);
        for (const rock of population(chunk)) {
          const mask = rockFieldMask(chunk.seed, rock.x + chunk.posX, rock.z + chunk.posZ, 450);
          if (mask > 0.7) inFields++;
          if (mask < 0.05) onPlains++;
        }
        for (let i = 0; i < 40; i++) {
          for (let j = 0; j < 40; j++) {
            const mask = rockFieldMask(
              chunk.seed,
              chunk.posX - 195 + i * 10,
              chunk.posZ - 195 + j * 10,
              450
            );
            if (mask > 0.7) fieldArea++;
            if (mask < 0.05) plainsArea++;
          }
        }
      }
    }
    expect(fieldArea).toBeGreaterThan(0);
    expect(plainsArea).toBeGreaterThan(0);
    const contrast = inFields / fieldArea / (onPlains / plainsArea);
    expect(contrast).toBeGreaterThan(8);
  });

  it('continues boulder fields across chunk borders', () => {
    // Rocks within 30 m of the border shared by horizontally adjacent chunks:
    // the counts on both sides rise and fall together
    const left: number[] = [];
    const right: number[] = [];
    for (let gx = -10; gx < 10; gx++) {
      for (let gz = -6; gz < 6; gz++) {
        left.push(population(chunkAt(gx, gz)).filter((rock) => rock.x > 170).length);
        right.push(population(chunkAt(gx + 1, gz)).filter((rock) => rock.x < -170).length);
      }
    }
    const mean = (values: number[]): number =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const meanLeft = mean(left);
    const meanRight = mean(right);
    let covariance = 0;
    let varianceLeft = 0;
    let varianceRight = 0;
    for (let i = 0; i < left.length; i++) {
      covariance += (left[i] - meanLeft) * (right[i] - meanRight);
      varianceLeft += (left[i] - meanLeft) ** 2;
      varianceRight += (right[i] - meanRight) ** 2;
    }
    const correlation = covariance / Math.sqrt(varianceLeft * varianceRight);
    expect(correlation).toBeGreaterThan(0.8);
    expect(meanLeft / meanRight).toBeGreaterThan(0.85);
    expect(meanLeft / meanRight).toBeLessThan(1.15);
  });

  it('stops at the triangle budget of the chunk', () => {
    const budget = 20000;
    const limited: RockGenerationConfig = { ...config, maxTrianglesPerChunk: budget };
    const chunk = chunkAt(2, 2);
    const all = population(chunk);
    const kept = population(chunk, limited);
    expect(kept.length).toBeLessThan(all.length);
    expect(kept).toEqual(all.slice(0, kept.length));
    const triangles = kept.reduce(
      (sum, rock) =>
        sum + rockTriangleBudget(ROCK_TIERS[sizeTierForDiameter(rock.diameter)].detail),
      0
    );
    expect(triangles).toBeLessThanOrEqual(budget);
    expect(triangles).toBeGreaterThan(budget - rockTriangleBudget(ROCK_TIERS[0].detail));
  });

  it('yields nothing for an empty diameter range, zero density or zero weights', () => {
    const chunk = chunkAt(0, 0);
    expect(population(chunk, { ...config, maxDiameter: 0.33 })).toEqual([]);
    expect(population(chunk, { ...config, densityConstant: 0 })).toEqual([]);
    expect(population({ ...chunk, width: 0.01, depth: 0.01 }, config)).toEqual([]);
  });
});

describe(placeRocks.name, () => {
  it('is deterministic', () => {
    const chunk = chunkAt(1, -3);
    const first = placeRocks(chunk, 0, LIBRARY_SIZE, config, flat);
    placeRocks(chunkAt(5, 5), 2, LIBRARY_SIZE, config, flat);
    const second = placeRocks(chunk, 0, LIBRARY_SIZE, config, flat);
    expect(second).toEqual(first);
    // Fresh buffers every call: results are transferred to the main thread
    expect(second[0].matrices).not.toBe(first[0].matrices);
    expect(second[0].matrices.buffer).not.toBe(first[0].matrices.buffer);
  });

  it('places exactly the enumerated population at LOD 0', () => {
    const chunk = chunkAt(-2, 4);
    const rocks = population(chunk);
    const placed = instances(placeRocks(chunk, 0, LIBRARY_SIZE, config, flat));
    expect(placed).toHaveLength(rocks.length);
    // Every placed rock stands (within its tilt times burial) where the population says
    const byPosition = new Map<string, Rock>();
    for (const rock of rocks) {
      byPosition.set(`${Math.round(rock.x)},${Math.round(rock.z)}`, rock);
    }
    let matched = 0;
    for (const instance of placed) {
      let found = false;
      for (const dx of [-1, 0, 1]) {
        for (const dz of [-1, 0, 1]) {
          const rock = byPosition.get(
            `${Math.round(instance.position[0]) + dx},${Math.round(instance.position[2]) + dz}`
          );
          if (
            rock &&
            Math.hypot(rock.x - instance.position[0], rock.z - instance.position[2]) <
              0.1 * rock.diameter
          ) {
            found = true;
          }
        }
      }
      if (found) matched++;
    }
    // (a few rocks share a rounded cell with another one and are skipped by the lookup)
    expect(matched / placed.length).toBeGreaterThan(0.97);
  });

  it('groups rocks by mesh tier and shape, ordered, with matching buffers', () => {
    const placements = placeRocks(chunkAt(0, 0), 0, LIBRARY_SIZE, config, flat);
    const keys = placements.map(
      (placement) => placement.tier * LIBRARY_SIZE + placement.prototypeId
    );
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
    expect(new Set(keys).size).toBe(keys.length);
    for (const placement of placements) {
      expect(placement.matrices.length).toBeGreaterThan(0);
      expect(placement.matrices.length % 16).toBe(0);
      expect(placement.colors.length).toBe((placement.matrices.length / 16) * 3);
      expect(placement.prototypeId).toBeGreaterThanOrEqual(0);
      expect(placement.prototypeId).toBeLessThan(LIBRARY_SIZE);
    }
  });

  it('selects the mesh tier from the rock size at LOD 0', () => {
    const cases: { min: number; max: number; density: number; tier: number }[] = [
      { min: 6.5, max: 11, density: 0.02, tier: 0 },
      { min: 3.2, max: 5.8, density: 0.01, tier: 1 },
      { min: 1.3, max: 2.9, density: 0.002, tier: 2 },
      { min: 0.65, max: 1.15, density: 0.001, tier: 3 },
      { min: 0.33, max: 0.58, density: 0.0005, tier: 4 },
    ];
    for (const { min, max, density, tier } of cases) {
      const placements = placeRocks(
        chunkAt(0, 0),
        0,
        LIBRARY_SIZE,
        sizedConfig(min, max, density),
        flat
      );
      expect(instanceCount(placements)).toBeGreaterThan(20);
      for (const placement of placements) {
        expect(placement.tier).toBe(tier);
      }
      expect(placements.length).toBeLessThanOrEqual(ROCK_TIERS[tier].maxShapes);
    }
  });

  it('drops one mesh tier per chunk LOD', () => {
    const boulders = sizedConfig(3.2, 5.8, 0.01);
    for (let lod = 0; lod < 8; lod++) {
      const placements = placeRocks(chunkAt(0, 0), lod, LIBRARY_SIZE, boulders, flat);
      expect(placements.length).toBeGreaterThan(0);
      for (const placement of placements) {
        expect(placement.tier).toBe(Math.min(LAST_TIER, 1 + lod));
      }
      expect(placements.length).toBeLessThanOrEqual(shapeCountFor(1, lod, LIBRARY_SIZE));
    }
  });

  it('streams disjoint sizes without changing the identities, poses or tints used by gameplay', () => {
    const chunk = chunkAt(2, -1);
    const all = instances(placeRocks(chunk, 0, LIBRARY_SIZE, config, flat));
    const bands = [
      [1.5, Infinity],
      [0.6, 1.5],
      [config.minDiameter, 0.6],
    ] as const;
    const streamed = bands.flatMap((band) =>
      instances(placeRocks(chunk, 0, LIBRARY_SIZE, config, flat, band))
    );
    const identities = (list: Instance[]) =>
      list.map(({ tier: _tier, ...physical }) => JSON.stringify(physical)).sort();
    expect(identities(streamed)).toEqual(identities(all));
  });

  it('shows the same rocks at the same place on coarser LODs, minus the small ones', () => {
    const chunk = chunkAt(2, -1);
    const rocks = population(chunk);
    const positionsAt = (lod: number): Set<string> =>
      new Set(
        instances(placeRocks(chunk, lod, LIBRARY_SIZE, config, flat)).map(
          (instance) =>
            `${instance.position[0]},${instance.position[2]},${instance.axisX.join(',')}`
        )
      );
    const fine = positionsAt(0);
    for (const lod of [1, 2]) {
      const coarse = positionsAt(lod);
      const expected = rocks.filter(
        (rock) => rock.diameter >= rockMinDiameterForLod(config, lod)
      ).length;
      expect(coarse.size).toBe(expected);
      expect(coarse.size).toBeLessThan(fine.size);
      for (const key of coarse) {
        expect(fine.has(key)).toBe(true);
      }
    }
    for (const lod of [3, 4, 5]) {
      const expected = rocks.filter(
        (rock) => rock.diameter >= rockMinDiameterForLod(config, lod)
      ).length;
      expect(instanceCount(placeRocks(chunk, lod, LIBRARY_SIZE, config, flat))).toBe(expected);
    }
    // Beyond the largest diameter nothing is left
    expect(placeRocks(chunk, 6, LIBRARY_SIZE, config, flat)).toEqual([]);
  });

  it('stays within the draw call and triangle budgets, and far chunks cost next to nothing', () => {
    const maxDraws = [0, 0, 0, 0, 0, 0];
    const maxTriangles = [0, 0, 0, 0, 0, 0];
    for (let gx = -5; gx < 5; gx++) {
      for (let gz = -5; gz < 5; gz++) {
        for (let lod = 0; lod < 6; lod++) {
          const placements = placeRocks(chunkAt(gx, gz), lod, LIBRARY_SIZE, config, flat);
          maxDraws[lod] = Math.max(maxDraws[lod], placements.length);
          maxTriangles[lod] = Math.max(maxTriangles[lod], triangleCount(placements));
        }
      }
    }
    expect(maxDraws[0]).toBeLessThanOrEqual(45);
    expect(maxTriangles[0]).toBeLessThanOrEqual(250000);
    for (let lod = 1; lod < 6; lod++) {
      expect(maxDraws[lod]).toBeLessThanOrEqual(maxDraws[lod - 1]);
      expect(maxTriangles[lod]).toBeLessThan(maxTriangles[lod - 1] * 0.6);
    }
    expect(maxDraws[3]).toBeLessThanOrEqual(12);
    expect(maxDraws[4]).toBeLessThanOrEqual(3);
    expect(maxDraws[5]).toBeLessThanOrEqual(2);
    expect(maxTriangles[3]).toBeLessThan(10000);
  });

  it('never exceeds the configured triangle budget', () => {
    const limited: RockGenerationConfig = { ...config, maxTrianglesPerChunk: 30000 };
    for (let gx = 0; gx < 6; gx++) {
      const placements = placeRocks(chunkAt(gx, 9), 0, LIBRARY_SIZE, limited, flat);
      expect(triangleCount(placements)).toBeLessThanOrEqual(30000);
    }
  });

  it('builds right-handed, orthogonal instance frames with varied non-uniform scale', () => {
    const placed = instances(placeRocks(chunkAt(0, 1), 0, LIBRARY_SIZE, config, flat));
    let nonUniform = 0;
    const yaws = new Set<number>();
    for (const { axisX, axisY, axisZ } of placed) {
      const sx = length(axisX);
      const sy = length(axisY);
      const sz = length(axisZ);
      expect(Math.abs(dot(axisX, axisY)) / (sx * sy)).toBeLessThan(1e-5);
      expect(Math.abs(dot(axisX, axisZ)) / (sx * sz)).toBeLessThan(1e-5);
      expect(Math.abs(dot(axisY, axisZ)) / (sy * sz)).toBeLessThan(1e-5);
      // Right-handed: (X × Y) · Z > 0
      const cross = [
        axisX[1] * axisY[2] - axisX[2] * axisY[1],
        axisX[2] * axisY[0] - axisX[0] * axisY[2],
        axisX[0] * axisY[1] - axisX[1] * axisY[0],
      ];
      expect(dot(cross, axisZ)).toBeGreaterThan(0);
      // Up stays close to vertical on flat ground (small random tilt only)
      expect(axisY[1] / sy).toBeGreaterThan(0.99);
      // Scales stay within ±12 % horizontally and ±18 % vertically of one diameter
      expect(sx / sz).toBeGreaterThan(0.88 / 1.12 - 1e-6);
      expect(sx / sz).toBeLessThan(1.12 / 0.88 + 1e-6);
      expect(sy / sx).toBeGreaterThan(0.82 / 1.12 - 1e-6);
      expect(sy / sx).toBeLessThan(1.18 / 0.88 + 1e-6);
      if (Math.abs(sx / sz - 1) > 0.03) nonUniform++;
      yaws.add(Math.floor(((Math.atan2(axisX[2], axisX[0]) + Math.PI) / (2 * Math.PI)) * 8));
    }
    expect(nonUniform / placed.length).toBeGreaterThan(0.5);
    expect(yaws.size).toBeGreaterThanOrEqual(8);
  });

  it('gives rocks their diameter range as scale', () => {
    const narrow = sizedConfig(2, 2.2, 0.01);
    for (const { axisX, axisZ } of instances(
      placeRocks(chunkAt(0, 0), 0, LIBRARY_SIZE, narrow, flat)
    )) {
      expect(length(axisX)).toBeGreaterThanOrEqual(2 * 0.88 - 1e-5);
      expect(length(axisX)).toBeLessThanOrEqual(2.2 * 1.12 + 1e-5);
      expect(length(axisZ)).toBeGreaterThanOrEqual(2 * 0.88 - 1e-5);
      expect(length(axisZ)).toBeLessThanOrEqual(2.2 * 1.12 + 1e-5);
    }
  });

  it('buries rocks by 8-30 % of their height, big boulders the least', () => {
    const all = instances(placeRocks(chunkAt(3, 3), 0, LIBRARY_SIZE, config, flat));
    expect(all.length).toBeGreaterThan(100);
    for (const instance of all) {
      const fraction = burialFraction(instance);
      expect(fraction).toBeGreaterThanOrEqual(0.08 - 1e-4);
      expect(fraction).toBeLessThanOrEqual(0.3 + 1e-4);
      // The base is below ground, the top above it
      expect(instance.position[1]).toBeLessThan(GROUND);
    }

    const small = instances(
      placeRocks(chunkAt(3, 3), 0, LIBRARY_SIZE, sizedConfig(0.4, 2.5, 0.002), flat)
    );
    const big = instances(
      placeRocks(chunkAt(3, 3), 0, LIBRARY_SIZE, sizedConfig(3.5, 11, 0.02), flat)
    );
    expect(small.length).toBeGreaterThan(20);
    expect(big.length).toBeGreaterThan(20);
    for (const instance of small) {
      expect(burialFraction(instance)).toBeGreaterThanOrEqual(0.14 - 1e-4);
    }
    for (const instance of big) {
      expect(burialFraction(instance)).toBeLessThanOrEqual(0.16 + 1e-4);
    }
    const spread = small.map(burialFraction);
    expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(0.1);
  });

  it('rests rocks on the sampled terrain and tilts them with the slope', () => {
    const slope: RockHeightSampler = (x, z) => 0.25 * x - 0.1 * z;
    const placed = instances(placeRocks(chunkAt(0, 0), 0, LIBRARY_SIZE, config, slope));
    let meanUpX = 0;
    let meanUpZ = 0;
    for (const { axisY, position } of placed) {
      const scaleY = length(axisY);
      meanUpX += axisY[0] / scaleY / placed.length;
      meanUpZ += axisY[2] / scaleY / placed.length;
      // The instance origin (base center) sits just below the terrain surface
      const ground = slope(position[0], position[2]);
      expect(position[1]).toBeLessThan(ground + 1e-3);
      expect(ground - position[1]).toBeLessThan(scaleY);
    }
    // Up leans against the gradient (0.25, -0.1), following 85 % of the slope
    expect(meanUpX).toBeLessThan(-0.15);
    expect(meanUpX).toBeGreaterThan(-0.25);
    expect(meanUpZ).toBeGreaterThan(0.05);
    expect(meanUpZ).toBeLessThan(0.12);
  });

  it('limits the tilt on very steep ground and buries the uphill side instead', () => {
    const cliff: RockHeightSampler = (x) => 3 * x;
    const placed = instances(placeRocks(chunkAt(0, 0), 0, LIBRARY_SIZE, config, cliff));
    for (const { axisY, position } of placed) {
      const scaleY = length(axisY);
      // Slope 3 would give up.y = 0.32; the limit of 0.7·0.85 keeps it above 0.8
      expect(axisY[1] / scaleY).toBeGreaterThan(0.8);
      expect(position[1]).toBeLessThan(cliff(position[0], position[2]));
    }
  });

  it('samples the terrain only around each rock', () => {
    const chunk = chunkAt(0, 0);
    let calls = 0;
    let farthest = 0;
    const counting: RockHeightSampler = (x, z) => {
      calls++;
      farthest = Math.max(farthest, Math.abs(x), Math.abs(z));
      return 0;
    };
    const placed = instanceCount(placeRocks(chunk, 0, LIBRARY_SIZE, config, counting));
    expect(calls).toBeGreaterThanOrEqual(placed * 3);
    expect(calls).toBeLessThanOrEqual(placed * 5);
    // Probes reach at most 1.5 m beyond the chunk
    expect(farthest).toBeLessThanOrEqual(201.5);
  });

  it('tints every rock: brightness within ±15 % with a slight warm / cool shift', () => {
    const placed = instances(placeRocks(chunkAt(1, 1), 0, LIBRARY_SIZE, config, flat));
    let min = Infinity;
    let max = -Infinity;
    let warm = 0;
    let cool = 0;
    for (const { color } of placed) {
      const [r, g, b] = color;
      expect(g).toBeGreaterThanOrEqual(0.85 - 1e-5);
      expect(g).toBeLessThanOrEqual(1.15 + 1e-5);
      expect(Math.abs(r / g - 1)).toBeLessThanOrEqual(0.03 + 1e-5);
      // Warmth shifts red and blue in opposite directions
      expect(r / g + b / g).toBeCloseTo(2, 4);
      min = Math.min(min, g);
      max = Math.max(max, g);
      if (r > b) warm++;
      if (r < b) cool++;
    }
    expect(min).toBeLessThan(0.9);
    expect(max).toBeGreaterThan(1.1);
    expect(warm).toBeGreaterThan(placed.length * 0.3);
    expect(cool).toBeGreaterThan(placed.length * 0.3);
  });

  it('uses shapes from the whole library for big boulders and a fixed set for small rocks', () => {
    const bigShapes = new Set<number>();
    const smallShapes = new Set<number>();
    for (let gx = 0; gx < 12; gx++) {
      for (const placement of placeRocks(chunkAt(gx, 0), 0, LIBRARY_SIZE, config, flat)) {
        (placement.tier <= 1 ? bigShapes : smallShapes).add(placement.prototypeId);
      }
    }
    expect(bigShapes.size).toBeGreaterThan(20);
    expect(Math.max(...smallShapes)).toBeLessThan(10);
  });

  it('accepts degenerate library sizes and LOD levels', () => {
    const chunk = chunkAt(0, 0);
    const single = placeRocks(chunk, 0, 0, config, flat);
    expect(single.length).toBeGreaterThan(0);
    for (const placement of single) {
      expect(placement.prototypeId).toBe(0);
    }
    expect(placeRocks(chunk, -1, LIBRARY_SIZE, config, flat)).toEqual(
      placeRocks(chunk, 0, LIBRARY_SIZE, config, flat)
    );
    expect(placeRocks(chunk, 1.7, LIBRARY_SIZE, config, flat)).toEqual(
      placeRocks(chunk, 1, LIBRARY_SIZE, config, flat)
    );
    expect(placeRocks(chunk, 0, LIBRARY_SIZE, { ...config, densityConstant: 0 }, flat)).toEqual([]);
  });

  it('handles a chunk with far more rocks than any before it', () => {
    const crowded: RockGenerationConfig = {
      ...config,
      densityConstant: 0.004,
      maxTrianglesPerChunk: 5e6,
    };
    const chunk = chunkAt(7, 7);
    const placements = placeRocks(chunk, 0, LIBRARY_SIZE, crowded, flat);
    expect(instanceCount(placements)).toBe(population(chunk, crowded).length);
    expect(instanceCount(placements)).toBeGreaterThan(3000);
  });
});
