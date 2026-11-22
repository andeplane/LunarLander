import alea from 'alea';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildCraterIndex,
  CRATER_INDEX_BUCKET_SIZE,
  type Crater,
  type CraterParams,
  clearCraterCellCache,
  craterHeight,
  craterHeightProfile,
  craterLodWeight,
  craterParamsFromTerrainArgs,
  createCrater,
  cumulativeCraterDensity,
  DEFAULT_DEGRADED_DEPTH_RATIO,
  DEFAULT_STEEP_EXPONENT,
  freshDepthRatio,
  freshnessForAge,
  generateCratersForRegion,
  generateLargeCratersInBounds,
  getCraterHeightModAt,
  LOD_FADE_END,
  LOD_FADE_START,
  parseGridKey,
  radiusForCumulativeDensity,
  rasterizeCraters,
  sampleCraterIndex,
  samplePoissonCount,
} from './craters';

/** Production parameters (mirrors craterGeneration in src/main.ts). */
const params: CraterParams = {
  seed: 42,
  density: 6000,
  minRadius: 1,
  maxRadius: 250,
  powerLawExponent: -2,
  depthRatio: 0.2,
  rimHeight: 0.04,
  rimWidth: 1.5,
  floorFlatness: 0,
  degradedDepthRatio: 0.04,
  freshnessExponent: 3,
};

const CHUNK = 400;

/** Lobed outline used by the profile tests. */
const HARMONICS = [0.05, -0.03, 0.02, 0.01, -0.015, 0.01, 0.008, -0.006];

function fresh(radius: number, harmonics?: readonly number[]): Crater {
  return createCrater({ centerX: 0, centerZ: 0, radius, freshness: 1, harmonics }, params);
}

function degraded(radius: number, harmonics?: readonly number[]): Crater {
  return createCrater({ centerX: 0, centerZ: 0, radius, freshness: 0, harmonics }, params);
}

function craterKey(crater: Crater): string {
  return `${crater.centerX}|${crater.centerZ}|${crater.radius}`;
}

/** Craters whose center lies inside the chunk cell itself. */
function centeredInChunk(craters: readonly Crater[], gridX: number, gridZ: number): Crater[] {
  return craters.filter(
    (c) =>
      c.centerX >= (gridX - 0.5) * CHUNK &&
      c.centerX < (gridX + 0.5) * CHUNK &&
      c.centerZ >= (gridZ - 0.5) * CHUNK &&
      c.centerZ < (gridZ + 0.5) * CHUNK
  );
}

beforeEach(() => {
  clearCraterCellCache();
});

describe(craterParamsFromTerrainArgs.name, () => {
  it('maps the flattened TerrainArgs fields onto CraterParams', () => {
    expect(
      craterParamsFromTerrainArgs({
        craterSeed: 7,
        craterDensity: 123,
        craterMinRadius: 2,
        craterMaxRadius: 90,
        craterPowerLawExponent: -2.1,
        craterDepthRatio: 0.19,
        craterRimHeight: 0.03,
        craterRimWidth: 1.2,
        craterFloorFlatness: 0.4,
        craterDegradedDepthRatio: 0.05,
        craterFreshnessExponent: 2.5,
      })
    ).toEqual({
      seed: 7,
      density: 123,
      minRadius: 2,
      maxRadius: 90,
      powerLawExponent: -2.1,
      depthRatio: 0.19,
      rimHeight: 0.03,
      rimWidth: 1.2,
      floorFlatness: 0.4,
      degradedDepthRatio: 0.05,
      freshnessExponent: 2.5,
    });
  });
});

describe(createCrater.name, () => {
  it('gives a fresh crater rim-to-floor depth/diameter 0.2, a 4% rim and ejecta out to 2.5 R', () => {
    const crater = fresh(10);
    expect(crater.depth + crater.rimHeight).toBeCloseTo(20 * 0.2, 12);
    expect(crater.rimHeight).toBeCloseTo(20 * 0.04, 12);
    expect(crater.cutoff).toBe(2.5);
    expect(crater.influenceRadius).toBeCloseTo(25, 12);
    expect(crater.influenceSq).toBeCloseTo(625, 9);
    expect(crater.invRadius).toBeCloseTo(0.1, 12);
  });

  it('gives a fully degraded crater a shallow bowl and no rim', () => {
    const crater = degraded(10);
    expect(crater.depth).toBeCloseTo(20 * 0.04, 12);
    expect(crater.rimHeight).toBe(0);
    // Degraded craters blend over a wider shoulder (relative to their depth)
    expect(crater.blend / crater.depth).toBeGreaterThan(fresh(10).blend / fresh(10).depth);
  });

  it('falls back to the default degraded depth ratio', () => {
    const { degradedDepthRatio: _unused, ...withoutDegraded } = params;
    const crater = createCrater(
      { centerX: 0, centerZ: 0, radius: 5, freshness: 0 },
      withoutDegraded
    );
    expect(crater.depth).toBeCloseTo(10 * DEFAULT_DEGRADED_DEPTH_RATIO, 12);
  });

  it('clamps freshness to [0, 1] and applies the depth scale', () => {
    const over = createCrater({ centerX: 0, centerZ: 0, radius: 4, freshness: 3 }, params);
    const under = createCrater({ centerX: 0, centerZ: 0, radius: 4, freshness: -1 }, params);
    expect(over.freshness).toBe(1);
    expect(under.freshness).toBe(0);

    const scaled = createCrater(
      { centerX: 0, centerZ: 0, radius: 4, freshness: 1, depthScale: 1.1 },
      params
    );
    expect(scaled.depth + scaled.rimHeight).toBeCloseTo((over.depth + over.rimHeight) * 1.1, 12);
  });

  it('scales depth and rim of craters that form shallow', () => {
    const shallow = createCrater(
      { centerX: 0, centerZ: 0, radius: 10, freshness: 1, freshDepthRatio: 0.12 },
      params
    );
    expect(shallow.depth + shallow.rimHeight).toBeCloseTo(20 * 0.12, 12);
    expect(shallow.rimHeight).toBeCloseTo(20 * 0.04 * 0.6, 12);

    const half = createCrater(
      { centerX: 0, centerZ: 0, radius: 10, freshness: 0.5, freshDepthRatio: 0.12 },
      params
    );
    expect(half.depth + half.rimHeight).toBeCloseTo(20 * 0.08, 12);

    const noDepth = createCrater(
      { centerX: 0, centerZ: 0, radius: 10, freshness: 1 },
      { ...params, depthRatio: 0, degradedDepthRatio: 0 }
    );
    expect(noDepth.rimHeight).toBeCloseTo(20 * 0.04, 12);
  });

  it('flattens the floors of large craters only', () => {
    expect(fresh(5).floorMix).toBe(1);
    expect(fresh(30).floorMix).toBe(1);
    expect(fresh(75).floorMix).toBeLessThan(1);
    expect(fresh(200).floorMix).toBeLessThan(fresh(75).floorMix);

    const flat = createCrater(
      { centerX: 0, centerZ: 0, radius: 5, freshness: 1 },
      { ...params, floorFlatness: 1 }
    );
    expect(flat.floorMix).toBeCloseTo(0.25, 12);
  });

  it('keeps a minimum ejecta extent and widens the influence radius for lobed outlines', () => {
    const narrow = createCrater(
      { centerX: 0, centerZ: 0, radius: 10, freshness: 1 },
      { ...params, rimWidth: 0.1 }
    );
    expect(narrow.cutoff).toBe(1.5);

    const lobed = fresh(10, HARMONICS);
    const sum =
      Math.hypot(HARMONICS[0], HARMONICS[1]) +
      Math.hypot(HARMONICS[2], HARMONICS[3]) +
      Math.hypot(HARMONICS[4], HARMONICS[5]) +
      Math.hypot(HARMONICS[6], HARMONICS[7]);
    expect(lobed.influenceRadius).toBeCloseTo(25 * (1 + sum), 12);
  });
});

describe(craterHeight.name, () => {
  it('reaches the full depth at the center', () => {
    const crater = fresh(10);
    expect(craterHeight(crater, 0, 0)).toBe(-crater.depth);
    expect(craterHeight(crater, 1e-12, 0)).toBe(-crater.depth);
  });

  it('raises a rim crest near r = R on a fresh crater', () => {
    const crater = fresh(10);
    let maxHeight = Number.NEGATIVE_INFINITY;
    let maxAt = 0;
    for (let r = 0; r <= 25; r += 0.01) {
      const h = craterHeight(crater, r, 0);
      if (h > maxHeight) {
        maxHeight = h;
        maxAt = r;
      }
    }
    expect(maxHeight).toBeGreaterThan(0.6 * crater.rimHeight);
    expect(maxHeight).toBeLessThanOrEqual(crater.rimHeight);
    expect(maxAt).toBeGreaterThan(8.5);
    expect(maxAt).toBeLessThan(11.5);

    // Ejecta blanket: still raised at 1.5 R, decaying outward
    const at15 = craterHeight(crater, 15, 0);
    const at20 = craterHeight(crater, 20, 0);
    expect(at15).toBeGreaterThan(0);
    expect(at20).toBeGreaterThan(0);
    expect(at20).toBeLessThan(at15);
  });

  it('is a rimless, monotonic soft bowl when fully degraded', () => {
    const crater = degraded(10);
    let previous = craterHeight(crater, 0, 0);
    expect(previous).toBe(-crater.depth);
    for (let r = 0.01; r <= 26; r += 0.01) {
      const h = craterHeight(crater, r, 0);
      expect(h).toBeLessThanOrEqual(0);
      expect(h).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = h;
    }
    // Depth/diameter in the 0.03-0.06 range of old lunar craters
    expect(crater.depth / 20).toBeGreaterThanOrEqual(0.03);
    expect(crater.depth / 20).toBeLessThanOrEqual(0.06);
  });

  it('contributes exactly 0 from the cutoff outward', () => {
    for (const crater of [fresh(10), degraded(10), fresh(10, HARMONICS), fresh(150)]) {
      for (let k = 0; k < 64; k++) {
        const angle = (k / 64) * 2 * Math.PI;
        for (const factor of [1, 1.0001, 1.5, 10]) {
          const r = crater.influenceRadius * factor;
          expect(craterHeight(crater, r * Math.cos(angle), r * Math.sin(angle))).toBe(0);
        }
      }
    }
    // A lobed outline cuts off inside its bounding influence circle too
    const lobed = fresh(10, HARMONICS);
    let zerosInside = 0;
    for (let k = 0; k < 64; k++) {
      const angle = (k / 64) * 2 * Math.PI;
      const r = lobed.influenceRadius * 0.995;
      if (craterHeight(lobed, r * Math.cos(angle), r * Math.sin(angle)) === 0) zerosInside++;
    }
    expect(zerosInside).toBeGreaterThan(0);
  });

  it('is C1-smooth along every ray: no jump in height or slope (rim and cutoff included)', () => {
    const craters = [
      fresh(10),
      degraded(10),
      createCrater({ centerX: 0, centerZ: 0, radius: 10, freshness: 0.5 }, params),
      fresh(10, HARMONICS),
      degraded(3, HARMONICS),
      fresh(150),
      createCrater(
        { centerX: 0, centerZ: 0, radius: 10, freshness: 1 },
        { ...params, rimWidth: 0.1 }
      ),
    ];
    for (const crater of craters) {
      // Step and tolerances scale with the crater: a kink at the rim would
      // change the slope by ~depth/R within one step
      const step = crater.radius * 1e-4;
      const typicalSlope = crater.depth / crater.radius;
      for (const angle of [0, 0.7, 2.1, 3.9, 5.5]) {
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        let previousHeight = craterHeight(crater, 0, 0);
        let previousSlope = 0;
        let maxSlopeJump = 0;
        let maxHeightJump = 0;
        const end = crater.influenceRadius * 1.02;
        for (let r = step; r <= end; r += step) {
          const h = craterHeight(crater, r * cos, r * sin);
          const slope = (h - previousHeight) / step;
          maxHeightJump = Math.max(maxHeightJump, Math.abs(h - previousHeight));
          if (r > 2 * step) maxSlopeJump = Math.max(maxSlopeJump, Math.abs(slope - previousSlope));
          previousHeight = h;
          previousSlope = slope;
        }
        expect(maxHeightJump).toBeLessThan(10 * typicalSlope * step);
        expect(maxSlopeJump).toBeLessThan(0.01 * typicalSlope);
        // Lands on exactly 0 with zero slope
        expect(previousHeight).toBe(0);
        expect(previousSlope).toBe(0);
      }
    }
  });

  it('approaches the cutoff with vanishing height and slope', () => {
    const crater = fresh(10);
    const justInside = craterHeight(crater, crater.influenceRadius - 1e-3, 0);
    expect(Math.abs(justInside)).toBeLessThan(1e-8);
  });

  it('is round without harmonics and gently irregular with them', () => {
    const round = fresh(10);
    const lobed = fresh(10, HARMONICS);
    const reference = craterHeight(round, 9, 0);
    let minLobed = Number.POSITIVE_INFINITY;
    let maxLobed = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < 90; k++) {
      const angle = (k / 90) * 2 * Math.PI;
      const dx = 9 * Math.cos(angle);
      const dz = 9 * Math.sin(angle);
      expect(craterHeight(round, dx, dz)).toBeCloseTo(reference, 10);
      const h = craterHeight(lobed, dx, dz);
      minLobed = Math.min(minLobed, h);
      maxLobed = Math.max(maxLobed, h);
    }
    expect(maxLobed - minLobed).toBeGreaterThan(0.05);
  });

  it('gives large craters a flatter floor than small ones', () => {
    const small = fresh(10);
    const large = fresh(200);
    // Fraction of the depth recovered at 40% of the radius
    const smallRise = (craterHeight(small, 4, 0) + small.depth) / small.depth;
    const largeRise = (craterHeight(large, 80, 0) + large.depth) / large.depth;
    expect(largeRise).toBeLessThan(0.7 * smallRise);
  });
});

describe(craterHeightProfile.name, () => {
  it('is craterHeight in polar form', () => {
    const crater = fresh(10, HARMONICS);
    for (const [distance, angle] of [
      [0, 0],
      [3, 1],
      [9.5, 2.5],
      [18, 4],
      [40, 5],
    ] as const) {
      expect(craterHeightProfile(distance, angle, crater)).toBe(
        craterHeight(crater, distance * Math.cos(angle), distance * Math.sin(angle))
      );
    }
  });
});

describe(getCraterHeightModAt.name, () => {
  it('returns 0 without craters', () => {
    expect(getCraterHeightModAt(1, 2, [])).toBe(0);
  });

  it('superposes craters additively, so a small crater shows inside a large one', () => {
    const large = createCrater({ centerX: 0, centerZ: 0, radius: 100, freshness: 0.8 }, params);
    const small = createCrater({ centerX: 20, centerZ: -10, radius: 4, freshness: 1 }, params);

    const both = getCraterHeightModAt(20, -10, [large, small]);
    const largeOnly = getCraterHeightModAt(20, -10, [large]);
    expect(both).toBe(largeOnly - small.depth);

    // On the large crater's wall and rim as well
    for (const [x, z] of [
      [21.5, -9],
      [85, 3],
      [101, -2],
      [140, 60],
    ] as const) {
      const expected =
        craterHeight(large, x - large.centerX, z - large.centerZ) +
        craterHeight(small, x - small.centerX, z - small.centerZ);
      expect(getCraterHeightModAt(x, z, [large, small])).toBe(expected);
    }
  });
});

describe(samplePoissonCount.name, () => {
  it('returns 0 for non-positive or invalid means', () => {
    const random = alea('poisson');
    expect(samplePoissonCount(0, random)).toBe(0);
    expect(samplePoissonCount(-3, random)).toBe(0);
    expect(samplePoissonCount(Number.NaN, random)).toBe(0);
  });

  it('has the requested mean and Poisson variance for small and large means', () => {
    for (const mean of [0.07, 2.5, 12, 150, 900]) {
      const random = alea(`poisson:${mean}`);
      const draws = 4000;
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < draws; i++) {
        const count = samplePoissonCount(mean, random);
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBeGreaterThanOrEqual(0);
        sum += count;
        sumSq += count * count;
      }
      const sampleMean = sum / draws;
      const variance = sumSq / draws - sampleMean * sampleMean;
      // Standard error of the mean is sqrt(mean / draws); allow 5 sigma
      expect(Math.abs(sampleMean - mean)).toBeLessThan(5 * Math.sqrt(mean / draws) + 1e-9);
      expect(variance).toBeGreaterThan(0.8 * mean);
      expect(variance).toBeLessThan(1.25 * mean);
    }
  });

  it('is deterministic for a seeded generator', () => {
    expect(samplePoissonCount(40, alea('s'))).toBe(samplePoissonCount(40, alea('s')));
    expect(samplePoissonCount(4, alea('s'))).toBe(samplePoissonCount(4, alea('s')));
  });
});

describe(parseGridKey.name, () => {
  it('parses positive and negative grid coordinates', () => {
    expect(parseGridKey('3,-2')).toEqual([3, -2]);
    expect(parseGridKey('0,0')).toEqual([0, 0]);
  });
});

describe(generateCratersForRegion.name, () => {
  it('is deterministic, with and without the cell cache', () => {
    const first = generateCratersForRegion('2,-3', CHUNK, CHUNK, params);
    const cached = generateCratersForRegion('2,-3', CHUNK, CHUNK, params);
    clearCraterCellCache();
    const regenerated = generateCratersForRegion('2,-3', CHUNK, CHUNK, params);

    expect(first.length).toBeGreaterThan(500);
    expect(cached).toEqual(first);
    expect(regenerated).toEqual(first);
  });

  it('survives eviction from the cell cache', () => {
    const first = generateCratersForRegion('0,0', CHUNK, CHUNK, params);
    // Touch far more cells than the cache holds
    for (let gridX = 10; gridX < 22; gridX++) {
      generateCratersForRegion(`${gridX},40`, CHUNK, CHUNK, params);
    }
    expect(generateCratersForRegion('0,0', CHUNK, CHUNK, params)).toEqual(first);
  });

  it('returns nothing for zero density', () => {
    expect(generateCratersForRegion('0,0', CHUNK, CHUNK, { ...params, density: 0 })).toEqual([]);
  });

  it('depends on the seed and on the chunk', () => {
    const a = generateCratersForRegion('0,0', CHUNK, CHUNK, params).map(craterKey);
    const b = generateCratersForRegion('0,0', CHUNK, CHUNK, { ...params, seed: 43 }).map(craterKey);
    const c = generateCratersForRegion('5,5', CHUNK, CHUNK, params).map(craterKey);
    expect(b).not.toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('returns craters in canonical order (largest first) within the radius limits', () => {
    const craters = generateCratersForRegion('1,1', CHUNK, CHUNK, params);
    for (let i = 0; i < craters.length; i++) {
      expect(craters[i].radius).toBeGreaterThanOrEqual(params.minRadius);
      expect(craters[i].radius).toBeLessThanOrEqual(params.maxRadius);
      if (i > 0) expect(craters[i].radius).toBeLessThanOrEqual(craters[i - 1].radius);
    }
  });

  it('only returns craters that can reach the chunk (plus margin)', () => {
    for (const margin of [0, 30]) {
      const craters = generateCratersForRegion('0,0', CHUNK, CHUNK, params, margin);
      const half = CHUNK / 2 + margin;
      for (const crater of craters) {
        expect(Math.abs(crater.centerX) - crater.influenceRadius).toBeLessThanOrEqual(half);
        expect(Math.abs(crater.centerZ) - crater.influenceRadius).toBeLessThanOrEqual(half);
      }
    }
    const without = new Set(generateCratersForRegion('0,0', CHUNK, CHUNK, params).map(craterKey));
    const withMargin = new Set(
      generateCratersForRegion('0,0', CHUNK, CHUNK, params, 30).map(craterKey)
    );
    expect(withMargin.size).toBeGreaterThan(without.size);
    for (const key of without) expect(withMargin.has(key)).toBe(true);
  });

  it('never misses a crater that reaches the chunk, however far away its cell is', () => {
    // Mostly large craters, so plenty of them reach across more than one chunk
    const large: CraterParams = { ...params, minRadius: 8, density: 400000 };
    // Every crater of a 9x9 cell window, collected through the regions of
    // those chunks (each region contains at least its own cell's craters)
    const all = new Map<string, Crater>();
    for (let gridX = -4; gridX <= 4; gridX++) {
      for (let gridZ = -4; gridZ <= 4; gridZ++) {
        const region = generateCratersForRegion(`${gridX},${gridZ}`, CHUNK, CHUNK, large);
        for (const crater of centeredInChunk(region, gridX, gridZ)) {
          all.set(craterKey(crater), crater);
        }
      }
    }

    const half = CHUNK / 2;
    const expected = new Set<string>();
    let fromBeyondNeighbors = 0;
    for (const [key, crater] of all) {
      const reach = crater.influenceRadius;
      if (Math.abs(crater.centerX) - reach <= half && Math.abs(crater.centerZ) - reach <= half) {
        expected.add(key);
        if (Math.abs(crater.centerX) > 1.5 * CHUNK || Math.abs(crater.centerZ) > 1.5 * CHUNK) {
          fromBeyondNeighbors++;
        }
      }
    }

    const actual = new Set(generateCratersForRegion('0,0', CHUNK, CHUNK, large).map(craterKey));
    expect(actual).toEqual(expected);
    // The window really exercised craters from beyond the 3x3 neighbors
    expect(fromBeyondNeighbors).toBeGreaterThan(0);
  });

  it('gives neighboring chunks exactly the same crater heights on their shared edge', () => {
    const west = generateCratersForRegion('0,0', CHUNK, CHUNK, params);
    const east = generateCratersForRegion('1,0', CHUNK, CHUNK, params);
    const north = generateCratersForRegion('0,-1', CHUNK, CHUNK, params);
    const diagonal = generateCratersForRegion('1,-1', CHUNK, CHUNK, params);

    let nonZero = 0;
    for (let i = 0; i <= 1024; i++) {
      const t = -200 + (400 * i) / 1024;
      const onEastEdge = getCraterHeightModAt(200, t, west);
      expect(getCraterHeightModAt(200, t, east)).toBe(onEastEdge);
      const onNorthEdge = getCraterHeightModAt(t, -200, west);
      expect(getCraterHeightModAt(t, -200, north)).toBe(onNorthEdge);
      if (onEastEdge !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(100);

    // The corner shared by four chunks
    const corner = getCraterHeightModAt(200, -200, west);
    expect(getCraterHeightModAt(200, -200, east)).toBe(corner);
    expect(getCraterHeightModAt(200, -200, north)).toBe(corner);
    expect(getCraterHeightModAt(200, -200, diagonal)).toBe(corner);
  });

  it('follows the N(>r) = density * r^-2 size distribution', () => {
    const radii: number[] = [];
    let chunks = 0;
    for (let gridX = -3; gridX <= 3; gridX++) {
      for (let gridZ = -3; gridZ <= 3; gridZ++) {
        const region = generateCratersForRegion(`${gridX},${gridZ}`, CHUNK, CHUNK, params);
        for (const crater of centeredInChunk(region, gridX, gridZ)) radii.push(crater.radius);
        chunks++;
      }
    }
    const perChunk = (minRadius: number) =>
      radii.filter((radius) => radius >= minRadius).length / chunks;
    const expected = (minRadius: number) =>
      params.density * 0.16 * (minRadius ** -2 - params.maxRadius ** -2);

    // Saturated surface: on the order of a thousand craters per chunk
    expect(perChunk(1)).toBeGreaterThan(600);
    expect(perChunk(1)).toBeLessThan(1200);
    expect(perChunk(1) / expected(1)).toBeGreaterThan(0.95);
    expect(perChunk(1) / expected(1)).toBeLessThan(1.05);
    expect(perChunk(2) / expected(2)).toBeGreaterThan(0.9);
    expect(perChunk(2) / expected(2)).toBeLessThan(1.1);
    expect(perChunk(5) / expected(5)).toBeGreaterThan(0.8);
    expect(perChunk(5) / expected(5)).toBeLessThan(1.2);
    expect(perChunk(20) / expected(20)).toBeGreaterThan(0.6);
    expect(perChunk(20) / expected(20)).toBeLessThan(1.4);
    // No pile-up at the band split (16 m): counts fall smoothly through it
    expect(perChunk(12) / expected(12)).toBeGreaterThan(0.75);
    expect(perChunk(12) / expected(12)).toBeLessThan(1.25);
  });

  it('makes most craters old and soft, with a minority of crisp fresh ones', () => {
    const craters: Crater[] = [];
    for (let gridX = 0; gridX < 4; gridX++) {
      craters.push(
        ...centeredInChunk(generateCratersForRegion(`${gridX},7`, CHUNK, CHUNK, params), gridX, 7)
      );
    }
    const sorted = craters.map((c) => c.freshness).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const crispShare = sorted.filter((f) => f > 0.5).length / sorted.length;
    // Evenly spread ages on the diffusion curve: median freshness 0.30
    expect(median).toBeGreaterThan(0.25);
    expect(median).toBeLessThan(0.35);
    expect(crispShare).toBeGreaterThan(0.15);
    expect(crispShare).toBeLessThan(0.35);

    for (const crater of craters) {
      const depthOverDiameter = (crater.depth + crater.rimHeight) / (2 * crater.radius);
      expect(depthOverDiameter).toBeGreaterThanOrEqual(0.04 * 0.85 - 1e-12);
      expect(depthOverDiameter).toBeLessThanOrEqual(0.2 * 1.15 + 1e-12);
      // Small craters form shallow: never deeper than 12% of the diameter
      if (crater.radius <= 25) expect(depthOverDiameter).toBeLessThanOrEqual(0.12 * 1.15 + 1e-12);
      // Outline irregularity stays within a few percent of the radius
      expect(crater.influenceRadius / (crater.cutoff * crater.radius)).toBeLessThan(1.14);
    }

    // In equilibrium the degradation mix does not depend on size
    const meanFreshness = (list: Crater[]) =>
      list.reduce((sum, c) => sum + c.freshness, 0) / list.length;
    const small = craters.filter((c) => c.radius < 2);
    const large = craters.filter((c) => c.radius > 4 && c.radius <= 25);
    expect(large.length).toBeGreaterThan(100);
    expect(Math.abs(meanFreshness(large) - meanFreshness(small))).toBeLessThan(0.05);
  });

  it('skews ages towards degraded with a higher freshness exponent', () => {
    const meanFreshness = (exponent: number) => {
      clearCraterCellCache();
      const craters = generateCratersForRegion('0,0', CHUNK, CHUNK, {
        ...params,
        freshnessExponent: exponent,
      });
      return craters.reduce((sum, c) => sum + c.freshness, 0) / craters.length;
    };
    expect(meanFreshness(6)).toBeLessThan(meanFreshness(3) - 0.05);
  });

  it('steepens the size distribution above the break radius and keeps those craters fresh', () => {
    const broken: CraterParams = {
      ...params,
      density: 400000,
      minRadius: 20,
      maxRadius: 250,
      breakRadius: 40,
    };
    const count = (p: CraterParams, minRadius: number) => {
      clearCraterCellCache();
      let total = 0;
      for (let gridX = 0; gridX < 12; gridX++) {
        const craters = centeredInChunk(
          generateCratersForRegion(`${gridX},0`, CHUNK, CHUNK, p),
          gridX,
          0
        );
        total += craters.filter((c) => c.radius >= minRadius).length;
      }
      return total;
    };
    const areaKm2 = 12 * 0.16;
    const expectedAll =
      (cumulativeCraterDensity(20, broken) - cumulativeCraterDensity(250, broken)) * areaKm2;
    const expectedBig =
      (cumulativeCraterDensity(80, broken) - cumulativeCraterDensity(250, broken)) * areaKm2;
    expect(count(broken, 20)).toBeGreaterThan(expectedAll * 0.9);
    expect(count(broken, 20)).toBeLessThan(expectedAll * 1.1);
    expect(count(broken, 80)).toBeGreaterThan(expectedBig * 0.6);
    expect(count(broken, 80)).toBeLessThan(expectedBig * 1.4);
    // Without the break there are over twice as many above 80 m
    expect(count({ ...broken, breakRadius: undefined }, 80)).toBeGreaterThan(
      count(broken, 80) * 1.7
    );

    // The oldest crater of radius r has only seen (break / r)^1.2 of its lifetime
    clearCraterCellCache();
    const big = generateLargeCratersInBounds(
      { minX: -4000, maxX: 4000, minZ: -4000, maxZ: 4000 },
      CHUNK,
      CHUNK,
      broken,
      160
    );
    expect(big.length).toBeGreaterThan(20);
    for (const crater of big) {
      const floor = freshnessForAge(
        (40 / crater.radius) ** 1.2,
        freshDepthRatio(crater.radius, broken),
        0.04
      );
      expect(crater.freshness).toBeGreaterThanOrEqual(floor - 1e-12);
    }
    expect(Math.min(...big.map((c) => c.freshness))).toBeGreaterThan(0.2);
  });

  it('reaches giant craters centred many chunks away', () => {
    const giant: CraterParams = { ...params, minRadius: 150, maxRadius: 1000, density: 2_000_000 };
    const bounds = { minX: -8000, maxX: 8000, minZ: -8000, maxZ: 8000 };
    const all = generateLargeCratersInBounds(bounds, CHUNK, CHUNK, giant, 600);
    const far = all.find((c) => Math.hypot(c.centerX, c.centerZ) > 1000 && c.radius > 700);
    if (far === undefined) throw new Error('no giant crater in the test area');

    // A chunk well inside its ejecta, more than two cells from its centre
    const towards = 1 - (far.radius * 1.8) / Math.hypot(far.centerX, far.centerZ);
    const gridX = Math.round((far.centerX * towards) / CHUNK);
    const gridZ = Math.round((far.centerZ * towards) / CHUNK);
    expect(Math.hypot(gridX * CHUNK - far.centerX, gridZ * CHUNK - far.centerZ)).toBeGreaterThan(
      2 * CHUNK
    );
    const seen = generateCratersForRegion(`${gridX},${gridZ}`, CHUNK, CHUNK, giant);
    expect(seen.map(craterKey)).toContain(craterKey(far));
  });

  it('handles size ranges that fall entirely into one population band', () => {
    // Band split is at min(chunk) / (10 * cutoff) = 16 m
    const smallOnly = generateCratersForRegion('0,0', CHUNK, CHUNK, { ...params, maxRadius: 8 });
    const largeOnly = generateCratersForRegion('0,0', CHUNK, CHUNK, {
      ...params,
      minRadius: 20,
      density: 60000,
    });
    expect(smallOnly.length).toBeGreaterThan(0);
    expect(Math.max(...smallOnly.map((c) => c.radius))).toBeLessThanOrEqual(8);
    expect(largeOnly.length).toBeGreaterThan(0);
    expect(Math.min(...largeOnly.map((c) => c.radius))).toBeGreaterThanOrEqual(20);
  });

  it('uses the default freshness exponent when none is given', () => {
    const { freshnessExponent: _unused, ...withoutExponent } = params;
    const explicit = generateCratersForRegion('0,0', CHUNK, CHUNK, params);
    clearCraterCellCache();
    expect(generateCratersForRegion('0,0', CHUNK, CHUNK, withoutExponent)).toEqual(explicit);
  });
});

describe(cumulativeCraterDensity.name, () => {
  const broken: CraterParams = { ...params, density: 8400, breakRadius: 150 };

  it('follows the equilibrium law up to the break and the steep one beyond', () => {
    expect(cumulativeCraterDensity(1, broken)).toBeCloseTo(8400, 9);
    expect(cumulativeCraterDensity(10, broken)).toBeCloseTo(84, 9);
    expect(cumulativeCraterDensity(150, broken)).toBeCloseTo(8400 / 22500, 12);
    expect(cumulativeCraterDensity(300, broken)).toBeCloseTo(
      (8400 / 22500) * 2 ** DEFAULT_STEEP_EXPONENT,
      12
    );
    expect(cumulativeCraterDensity(300, { ...broken, steepExponent: -4 })).toBeCloseTo(
      8400 / 22500 / 16,
      12
    );
    // No break: one law at every size
    expect(cumulativeCraterDensity(300, params)).toBeCloseTo(6000 / 90000, 12);
  });

  it('is inverted by radiusForCumulativeDensity on both sides of the break', () => {
    for (const radius of [1, 7.5, 149, 150, 151, 400, 1000]) {
      expect(
        radiusForCumulativeDensity(cumulativeCraterDensity(radius, broken), broken)
      ).toBeCloseTo(radius, 8);
      expect(
        radiusForCumulativeDensity(cumulativeCraterDensity(radius, params), params)
      ).toBeCloseTo(radius, 8);
    }
    const steep = { ...broken, steepExponent: -4 };
    expect(radiusForCumulativeDensity(cumulativeCraterDensity(600, steep), steep)).toBeCloseTo(
      600,
      8
    );
  });
});

describe(freshDepthRatio.name, () => {
  it('is 60% of the depth ratio for small craters and the full ratio from 200 m radius', () => {
    expect(freshDepthRatio(1, params)).toBeCloseTo(0.12, 12);
    expect(freshDepthRatio(25, params)).toBeCloseTo(0.12, 12);
    expect(freshDepthRatio(200, params)).toBeCloseTo(0.2, 12);
    expect(freshDepthRatio(900, params)).toBeCloseTo(0.2, 12);
    const mid = freshDepthRatio(70, params);
    expect(mid).toBeGreaterThan(0.14);
    expect(mid).toBeLessThan(0.18);
  });
});

describe(freshnessForAge.name, () => {
  it('runs from fresh to erased, dropping fastest at first', () => {
    expect(freshnessForAge(0, 0.2, 0.05)).toBeCloseTo(1, 12);
    expect(freshnessForAge(1, 0.2, 0.05)).toBeCloseTo(0, 12);
    expect(freshnessForAge(-1, 0.2, 0.05)).toBeCloseTo(1, 12);
    expect(freshnessForAge(2, 0.2, 0.05)).toBeCloseTo(0, 12);
    const half = freshnessForAge(0.5, 0.2, 0.05);
    expect(half).toBeGreaterThan(0.2);
    expect(half).toBeLessThan(0.4);
    expect(freshnessForAge(0.25, 0.2, 0.05)).toBeGreaterThan(freshnessForAge(0.5, 0.2, 0.05));
  });

  it('is zero when a crater cannot be deeper fresh than degraded', () => {
    expect(freshnessForAge(0, 0.05, 0.05)).toBe(0);
    expect(freshnessForAge(0, 0.03, 0.05)).toBe(0);
  });
});

describe(generateLargeCratersInBounds.name, () => {
  const MIN_RADIUS = 20;

  it('returns the same large craters the chunks get', () => {
    // One chunk's bounds: every large crater of that chunk's region, no more
    const bounds = { minX: 600, maxX: 1000, minZ: -1400, maxZ: -1000 };
    const large = generateLargeCratersInBounds(bounds, CHUNK, CHUNK, params, MIN_RADIUS);
    const region = generateCratersForRegion('2,-3', CHUNK, CHUNK, params).filter(
      (crater) => crater.radius >= MIN_RADIUS
    );

    expect(large.length).toBeGreaterThan(0);
    expect(large).toEqual(region);
  });

  it('covers a rectangle of many chunks and keeps only craters that reach it', () => {
    const bounds = { minX: -3000, maxX: 3000, minZ: -500, maxZ: 500 };
    const craters = generateLargeCratersInBounds(bounds, CHUNK, CHUNK, params, MIN_RADIUS);

    expect(craters.length).toBeGreaterThan(20);
    for (let i = 0; i < craters.length; i++) {
      const crater = craters[i];
      expect(crater.radius).toBeGreaterThanOrEqual(MIN_RADIUS);
      expect(crater.centerX + crater.influenceRadius).toBeGreaterThanOrEqual(bounds.minX);
      expect(crater.centerX - crater.influenceRadius).toBeLessThanOrEqual(bounds.maxX);
      expect(crater.centerZ + crater.influenceRadius).toBeGreaterThanOrEqual(bounds.minZ);
      expect(crater.centerZ - crater.influenceRadius).toBeLessThanOrEqual(bounds.maxZ);
      if (i > 0) expect(crater.radius).toBeLessThanOrEqual(craters[i - 1].radius);
    }
    // Spread over the whole rectangle, not just one cell
    expect(Math.min(...craters.map((crater) => crater.centerX))).toBeLessThan(-2000);
    expect(Math.max(...craters.map((crater) => crater.centerX))).toBeGreaterThan(2000);
  });

  it('never returns craters below the large band, whatever minRadius asks for', () => {
    const bounds = { minX: -400, maxX: 400, minZ: -400, maxZ: 400 };
    const all = generateLargeCratersInBounds(bounds, CHUNK, CHUNK, params, 0);
    expect(all.length).toBeGreaterThan(0);
    // The band split for 400 m chunks with these parameters is 16 m
    for (const crater of all) expect(crater.radius).toBeGreaterThanOrEqual(16);
  });

  it('returns nothing for zero density or an empty large band', () => {
    const bounds = { minX: -400, maxX: 400, minZ: -400, maxZ: 400 };
    expect(
      generateLargeCratersInBounds(bounds, CHUNK, CHUNK, { ...params, density: 0 }, 0)
    ).toEqual([]);
    expect(
      generateLargeCratersInBounds(bounds, CHUNK, CHUNK, { ...params, maxRadius: 10 }, 0)
    ).toEqual([]);
  });
});

describe(buildCraterIndex.name, () => {
  const bounds = [-200, -200, 200, 200] as const;

  it('returns exactly the brute-force sum inside the indexed rectangle', () => {
    const craters = generateCratersForRegion('0,0', CHUNK, CHUNK, params);
    const index = buildCraterIndex(craters, ...bounds);
    expect(index.largeCount).toBe(
      craters.filter((c) => c.radius >= CRATER_INDEX_BUCKET_SIZE).length
    );

    const random = alea('index-points');
    let nonZero = 0;
    for (let i = 0; i < 20000; i++) {
      const x = -200 + 400 * random();
      const z = -200 + 400 * random();
      const expected = getCraterHeightModAt(x, z, craters);
      expect(sampleCraterIndex(index, x, z)).toBe(expected);
      if (expected !== 0) nonZero++;
    }
    expect(nonZero).toBeGreaterThan(5000);

    // Rectangle borders and corners
    for (const [x, z] of [
      [-200, -200],
      [200, 200],
      [200, -200],
      [-200, 37.5],
      [12.25, 200],
    ] as const) {
      expect(sampleCraterIndex(index, x, z)).toBe(getCraterHeightModAt(x, z, craters));
    }
  });

  it('falls back to the brute-force scan outside the indexed rectangle', () => {
    const craters = generateCratersForRegion('0,0', CHUNK, CHUNK, params, 20);
    const index = buildCraterIndex(craters, ...bounds);
    for (const [x, z] of [
      [-200.5, 0],
      [203, 12],
      [14, -207],
      [-33, 201],
      [210, 210],
    ] as const) {
      expect(sampleCraterIndex(index, x, z)).toBe(getCraterHeightModAt(x, z, craters));
    }
  });

  it('sorts unsorted input into canonical order first', () => {
    const craters = generateCratersForRegion('0,0', CHUNK, CHUNK, params);
    const reversed = [...craters].reverse();
    const index = buildCraterIndex(reversed, ...bounds);
    expect(index.craters).toEqual(craters);
    // Already-sorted input is used as is (no copy)
    expect(buildCraterIndex(craters, ...bounds).craters).toBe(craters);

    const random = alea('unsorted');
    for (let i = 0; i < 500; i++) {
      const x = -200 + 400 * random();
      const z = -200 + 400 * random();
      expect(sampleCraterIndex(index, x, z)).toBe(getCraterHeightModAt(x, z, craters));
    }
  });

  it('orders equally sized craters by position', () => {
    const a = createCrater({ centerX: 5, centerZ: 9, radius: 3, freshness: 1 }, params);
    const b = createCrater({ centerX: 5, centerZ: 2, radius: 3, freshness: 1 }, params);
    const c = createCrater({ centerX: -4, centerZ: 0, radius: 3, freshness: 1 }, params);
    expect(buildCraterIndex([a, b, c], -20, -20, 20, 20).craters).toEqual([c, b, a]);
  });

  it('handles empty lists, other bucket sizes and craters outside the rectangle', () => {
    const empty = buildCraterIndex([], ...bounds);
    expect(sampleCraterIndex(empty, 3, 4)).toBe(0);

    const inside = createCrater({ centerX: 10, centerZ: 10, radius: 3, freshness: 1 }, params);
    const outside = [
      createCrater({ centerX: 500, centerZ: 0, radius: 3, freshness: 1 }, params),
      createCrater({ centerX: -500, centerZ: 0, radius: 3, freshness: 1 }, params),
      createCrater({ centerX: 0, centerZ: 500, radius: 3, freshness: 1 }, params),
      createCrater({ centerX: 0, centerZ: -500, radius: 3, freshness: 1 }, params),
    ];
    const index = buildCraterIndex([inside, ...outside], ...bounds, 25);
    expect(index.bucketsX).toBe(16);
    expect(index.bucketItems.length).toBeGreaterThan(0);
    // Only the inside crater is bucketed
    expect(new Set(index.bucketItems)).toEqual(new Set([index.craters.indexOf(inside)]));
    expect(sampleCraterIndex(index, 10, 10)).toBe(-inside.depth);
    expect(sampleCraterIndex(index, -100, -100)).toBe(0);

    // Degenerate rectangle still yields one bucket
    const point = buildCraterIndex([inside], 10, 10, 10, 10);
    expect(point.bucketsX).toBe(1);
    expect(point.bucketsZ).toBe(1);
    expect(sampleCraterIndex(point, 10, 10)).toBe(-inside.depth);
  });
});

describe(craterLodWeight.name, () => {
  it('keeps every crater when no vertex spacing is given', () => {
    expect(craterLodWeight(0.5, 0)).toBe(1);
    expect(craterLodWeight(0.5, -1)).toBe(1);
  });

  it('fades craters between 1.25 and 2.5 vertex spacings of radius', () => {
    const spacing = 6.25;
    expect(craterLodWeight(LOD_FADE_START * spacing, spacing)).toBe(0);
    expect(craterLodWeight(1, spacing)).toBe(0);
    expect(craterLodWeight(LOD_FADE_END * spacing, spacing)).toBe(1);
    expect(craterLodWeight(100, spacing)).toBe(1);

    let previous = 0;
    for (let radius = LOD_FADE_START * spacing; radius <= LOD_FADE_END * spacing; radius += 0.1) {
      const weight = craterLodWeight(radius, spacing);
      expect(weight).toBeGreaterThanOrEqual(previous);
      expect(weight).toBeLessThanOrEqual(1);
      previous = weight;
    }
    expect(craterLodWeight(((LOD_FADE_START + LOD_FADE_END) / 2) * spacing, spacing)).toBeCloseTo(
      0.5,
      12
    );
  });
});

describe(rasterizeCraters.name, () => {
  function axis(start: number, end: number, count: number): Float64Array {
    const values = new Float64Array(count);
    for (let i = 0; i < count; i++) values[i] = start + ((end - start) * i) / (count - 1);
    return values;
  }

  it('matches the point-sampled sum at every vertex (no LOD fade)', () => {
    const craters = generateCratersForRegion('0,0', CHUNK, CHUNK, params, 10);
    const xs = axis(-210, 210, 337);
    const zs = axis(-210, 210, 211);
    const heights = new Float64Array(xs.length * zs.length);
    rasterizeCraters(heights, xs, zs, craters);

    let nonZero = 0;
    for (let row = 0; row < zs.length; row++) {
      for (let col = 0; col < xs.length; col++) {
        const value = heights[row * xs.length + col];
        expect(value).toBe(getCraterHeightModAt(xs[col], zs[row], craters));
        if (value !== 0) nonZero++;
      }
    }
    expect(nonZero).toBeGreaterThan(10000);
  });

  it('adds onto existing heights', () => {
    const crater = createCrater({ centerX: 1, centerZ: -2, radius: 6, freshness: 1 }, params);
    const xs = axis(-20, 20, 41);
    const zs = axis(-20, 20, 41);
    const heights = new Float64Array(xs.length * zs.length).fill(5);
    rasterizeCraters(heights, xs, zs, [crater]);
    for (let row = 0; row < zs.length; row++) {
      for (let col = 0; col < xs.length; col++) {
        expect(heights[row * xs.length + col]).toBe(
          5 + craterHeight(crater, xs[col] - 1, zs[row] + 2)
        );
      }
    }
  });

  it('applies the LOD weight per crater and skips craters below the fade', () => {
    const craters = generateCratersForRegion('0,0', CHUNK, CHUNK, params);
    const xs = axis(-200, 200, 65);
    const zs = axis(-200, 200, 65);
    const spacing = 400 / 64;
    const heights = new Float64Array(xs.length * zs.length);
    rasterizeCraters(heights, xs, zs, craters, spacing);

    for (let row = 0; row < zs.length; row++) {
      for (let col = 0; col < xs.length; col++) {
        let expected = 0;
        for (const crater of craters) {
          const weight = craterLodWeight(crater.radius, spacing);
          if (weight === 0) continue;
          expected +=
            weight * craterHeight(crater, xs[col] - crater.centerX, zs[row] - crater.centerZ);
        }
        expect(heights[row * xs.length + col]).toBe(expected);
      }
    }

    // Craters too small for the grid leave it untouched
    const small = craters.filter((c) => c.radius <= LOD_FADE_START * spacing);
    expect(small.length).toBeGreaterThan(500);
    const untouched = new Float64Array(xs.length * zs.length);
    rasterizeCraters(untouched, xs, zs, small, spacing);
    expect(untouched.every((value) => value === 0)).toBe(true);
  });

  it('ignores degenerate grids and craters outside the grid', () => {
    const crater = createCrater({ centerX: 0, centerZ: 0, radius: 6, freshness: 1 }, params);
    const single = new Float64Array(3);
    rasterizeCraters(single, [0], [0, 1, 2], [crater]);
    rasterizeCraters(single, [0, 1, 2], [0], [crater]);
    expect(Array.from(single)).toEqual([0, 0, 0]);

    const far = createCrater({ centerX: 900, centerZ: 900, radius: 6, freshness: 1 }, params);
    const xs = axis(-20, 20, 9);
    const heights = new Float64Array(81);
    rasterizeCraters(heights, xs, xs, [far]);
    expect(heights.every((value) => value === 0)).toBe(true);
  });
});
