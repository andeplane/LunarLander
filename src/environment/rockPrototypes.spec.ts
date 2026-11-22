import { describe, expect, it } from 'vitest';
import {
  hashToUnit,
  ladderIndexForPixels,
  ladderIndexOfDetail,
  meshTierForLod,
  ROCK_DETAIL_LADDER,
  ROCK_LOD_SHAPE_LIMIT,
  ROCK_PIXELS_PER_SEGMENT,
  ROCK_TIERS,
  type RockArchetype,
  rockArchetype,
  rockHeightRatio,
  rockShapeFor,
  rockTriangleBudget,
  shapeCountFor,
  sizeTierForDiameter,
} from './rockPrototypes';

const LAST_TIER = ROCK_TIERS.length - 1;

describe('ROCK_TIERS', () => {
  it('is ordered from the finest mesh for the biggest rocks to the cheapest for the smallest', () => {
    for (let tier = 1; tier < ROCK_TIERS.length; tier++) {
      expect(ROCK_TIERS[tier].detail).toBeLessThan(ROCK_TIERS[tier - 1].detail);
      expect(ROCK_TIERS[tier].minDiameter).toBeLessThan(ROCK_TIERS[tier - 1].minDiameter);
    }
    expect(ROCK_TIERS[LAST_TIER].minDiameter).toBe(0);
  });

  it('bounds a chunk to 45 draw calls', () => {
    const total = ROCK_TIERS.reduce((sum, tier) => sum + tier.maxShapes, 0);
    expect(total).toBeLessThanOrEqual(45);
  });

  it('keeps rocks under a meter between 60 and 200 triangles and big boulders in the thousands', () => {
    for (const diameter of [0.33, 0.5, 0.75, 0.99]) {
      const triangles = rockTriangleBudget(ROCK_TIERS[sizeTierForDiameter(diameter)].detail);
      expect(triangles).toBeGreaterThanOrEqual(60);
      expect(triangles).toBeLessThanOrEqual(200);
    }
    expect(rockTriangleBudget(ROCK_TIERS[sizeTierForDiameter(2)].detail)).toBe(320);
    expect(rockTriangleBudget(ROCK_TIERS[sizeTierForDiameter(4)].detail)).toBe(1280);
    expect(rockTriangleBudget(ROCK_TIERS[sizeTierForDiameter(8)].detail)).toBe(5120);
  });
});

describe('ROCK_DETAIL_LADDER', () => {
  it('is strictly ascending and holds every chunk tier detail', () => {
    for (let i = 1; i < ROCK_DETAIL_LADDER.length; i++) {
      expect(ROCK_DETAIL_LADDER[i]).toBeGreaterThan(ROCK_DETAIL_LADDER[i - 1]);
    }
    for (const tier of ROCK_TIERS) {
      expect(ladderIndexOfDetail(tier.detail)).toBeGreaterThanOrEqual(0);
    }
    expect(ladderIndexOfDetail(4)).toBe(-1);
  });

  it('steps by at most about 2.3x in triangles and tops out above 40 000', () => {
    for (let i = 1; i < ROCK_DETAIL_LADDER.length; i++) {
      const ratio =
        rockTriangleBudget(ROCK_DETAIL_LADDER[i]) / rockTriangleBudget(ROCK_DETAIL_LADDER[i - 1]);
      expect(ratio).toBeLessThan(2.3);
    }
    expect(rockTriangleBudget(ROCK_DETAIL_LADDER[ROCK_DETAIL_LADDER.length - 1])).toBeGreaterThan(
      40000
    );
  });
});

describe(ladderIndexForPixels.name, () => {
  /** Projected size (pixels) of a rock on a 1080 px tall, 70° view. */
  const pixelsOf = (diameter: number, distance: number): number =>
    (diameter / distance) * (1080 / (2 * Math.tan((35 * Math.PI) / 180)));
  const trianglesFor = (pixels: number, minIndex = 0): number =>
    rockTriangleBudget(
      ROCK_DETAIL_LADDER[ladderIndexForPixels(pixels, ROCK_PIXELS_PER_SEGMENT, minIndex)]
    );

  it('picks the finest detail whose segments still cover the pixel target', () => {
    expect(ladderIndexForPixels(0, 10, 0)).toBe(0);
    // detail 2 needs 3 segments of 10 px
    expect(ladderIndexForPixels(29, 10, 0)).toBe(0);
    expect(ladderIndexForPixels(30, 10, 0)).toBe(1);
    expect(ladderIndexForPixels(1e9, 10, 0)).toBe(ROCK_DETAIL_LADDER.length - 1);
  });

  it('never goes below the minimum index', () => {
    expect(ladderIndexForPixels(0, 10, 4)).toBe(4);
  });

  it('gives a 0.4 m pebble seen from 2 m at least 500 triangles', () => {
    expect(trianglesFor(pixelsOf(0.4, 2))).toBeGreaterThanOrEqual(500);
  });

  it('gives a boulder filling the screen well over 10 000 triangles', () => {
    expect(trianglesFor(1000)).toBeGreaterThan(20000);
    // A meter-sized rock half a screen across: several thousand
    expect(trianglesFor(500)).toBeGreaterThan(4000);
  });
});

describe(rockTriangleBudget.name, () => {
  it('is 20·(detail+1)²', () => {
    expect(rockTriangleBudget(0)).toBe(20);
    expect(rockTriangleBudget(1)).toBe(80);
    expect(rockTriangleBudget(15)).toBe(5120);
  });
});

describe(sizeTierForDiameter.name, () => {
  it('picks the tier whose diameter range holds the rock', () => {
    expect(sizeTierForDiameter(12)).toBe(0);
    expect(sizeTierForDiameter(6)).toBe(0);
    expect(sizeTierForDiameter(5.99)).toBe(1);
    expect(sizeTierForDiameter(3)).toBe(1);
    expect(sizeTierForDiameter(2.99)).toBe(2);
    expect(sizeTierForDiameter(1.2)).toBe(2);
    expect(sizeTierForDiameter(1.19)).toBe(3);
    expect(sizeTierForDiameter(0.6)).toBe(3);
    expect(sizeTierForDiameter(0.59)).toBe(4);
    expect(sizeTierForDiameter(0)).toBe(4);
  });
});

describe(meshTierForLod.name, () => {
  it('drops one tier per chunk LOD down to the cheapest', () => {
    expect(meshTierForLod(0, 0)).toBe(0);
    expect(meshTierForLod(0, 1)).toBe(1);
    expect(meshTierForLod(2, 1)).toBe(3);
    expect(meshTierForLod(0, 4)).toBe(LAST_TIER);
    expect(meshTierForLod(3, 9)).toBe(LAST_TIER);
  });

  it('treats negative LODs as LOD 0', () => {
    expect(meshTierForLod(1, -3)).toBe(1);
  });
});

describe(shapeCountFor.name, () => {
  it('uses the tier limit on near chunks', () => {
    for (let tier = 0; tier < ROCK_TIERS.length; tier++) {
      expect(shapeCountFor(tier, 0, 30)).toBe(ROCK_TIERS[tier].maxShapes);
      expect(shapeCountFor(tier, 2, 30)).toBe(ROCK_TIERS[tier].maxShapes);
    }
  });

  it('is capped by the library size and never drops below one', () => {
    expect(shapeCountFor(0, 0, 4)).toBe(4);
    expect(shapeCountFor(0, 0, 0)).toBe(1);
  });

  it('shrinks with chunk LOD and reuses the last entry beyond the table', () => {
    expect(shapeCountFor(0, 3, 30)).toBe(6);
    expect(shapeCountFor(0, 4, 30)).toBe(3);
    expect(shapeCountFor(0, 5, 30)).toBe(2);
    expect(shapeCountFor(0, 6, 30)).toBe(1);
    expect(shapeCountFor(0, 20, 30)).toBe(ROCK_LOD_SHAPE_LIMIT[ROCK_LOD_SHAPE_LIMIT.length - 1]);
    expect(shapeCountFor(0, -1, 30)).toBe(ROCK_TIERS[0].maxShapes);
  });
});

describe(rockShapeFor.name, () => {
  it('gives small rocks the same fixed set of shapes in every chunk', () => {
    const seen = new Set<number>();
    for (const chunkHash of [0, 7, 123456]) {
      for (let i = 0; i < 100; i++) {
        seen.add(rockShapeFor(LAST_TIER, 0, 30, chunkHash, i / 100));
      }
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('gives big boulders a per-chunk window over the whole library', () => {
    const shapesOf = (chunkHash: number): Set<number> => {
      const shapes = new Set<number>();
      for (let i = 0; i < 200; i++) {
        shapes.add(rockShapeFor(0, 0, 30, chunkHash, i / 200));
      }
      return shapes;
    };
    const a = shapesOf(3);
    const b = shapesOf(25);
    expect(a.size).toBe(ROCK_TIERS[0].maxShapes);
    expect(b.size).toBe(ROCK_TIERS[0].maxShapes);
    expect([...a].sort((x, y) => x - y)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // The window wraps around the end of the library
    expect(b.has(29)).toBe(true);
    expect(b.has(0)).toBe(true);
    for (const shape of b) {
      expect(shape).toBeGreaterThanOrEqual(0);
      expect(shape).toBeLessThan(30);
    }
  });

  it('falls back to the first shapes on far chunks so they share draw calls', () => {
    for (let i = 0; i < 50; i++) {
      expect(rockShapeFor(0, 4, 30, 17, i / 50)).toBeLessThan(3);
      expect(rockShapeFor(0, 6, 30, 17, i / 50)).toBe(0);
    }
  });

  it('never exceeds the shape count, even for a unit of exactly 1', () => {
    expect(rockShapeFor(LAST_TIER, 0, 30, 0, 1)).toBe(ROCK_TIERS[LAST_TIER].maxShapes - 1);
    expect(rockShapeFor(2, 0, 3, 0, 0.999)).toBe(2);
  });
});

describe(hashToUnit.name, () => {
  it('is deterministic and stays in [0, 1)', () => {
    for (let i = -50; i < 200; i++) {
      const value = hashToUnit(i);
      expect(value).toBe(hashToUnit(i));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('spreads consecutive integers', () => {
    const values = new Set<number>();
    for (let i = 0; i < 100; i++) {
      values.add(Math.floor(hashToUnit(i) * 10));
    }
    expect(values.size).toBe(10);
  });
});

describe(rockArchetype.name, () => {
  it('covers every family within the first eight shapes, blocks most often', () => {
    const counts: Record<RockArchetype, number> = { block: 0, slab: 0, wedge: 0, round: 0 };
    for (let shape = 0; shape < 8; shape++) {
      counts[rockArchetype(shape)]++;
    }
    expect(counts.block).toBe(3);
    expect(counts.slab).toBe(2);
    expect(counts.wedge).toBe(2);
    expect(counts.round).toBe(1);
  });

  it('cycles and accepts negative or fractional ids', () => {
    expect(rockArchetype(8)).toBe(rockArchetype(0));
    expect(rockArchetype(-1)).toBe(rockArchetype(7));
    expect(rockArchetype(2.7)).toBe(rockArchetype(2));
  });
});

describe(rockHeightRatio.name, () => {
  it('keeps every shape lower than it is wide, slabs the flattest', () => {
    for (let shape = 0; shape < 60; shape++) {
      const ratio = rockHeightRatio(shape);
      expect(ratio).toBe(rockHeightRatio(shape));
      if (rockArchetype(shape) === 'slab') {
        expect(ratio).toBeGreaterThanOrEqual(0.26);
        expect(ratio).toBeLessThanOrEqual(0.4);
      } else {
        expect(ratio).toBeGreaterThanOrEqual(0.55);
        expect(ratio).toBeLessThanOrEqual(0.85);
      }
    }
  });
});
