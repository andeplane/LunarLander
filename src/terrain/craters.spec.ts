import { describe, it, expect } from 'vitest';
import {
  parseGridKey,
  craterHeightProfile,
  getCraterHeightModAt,
  generateCratersForRegion,
  applyCratersToHeightBuffer,
  type Crater,
  type CraterParams,
} from './craters';

describe('parseGridKey', () => {
  it.each([
    ['0,0', [0, 0]],
    ['1,2', [1, 2]],
    ['-1,-2', [-1, -2]],
    ['100,-50', [100, -50]],
  ])('parseGridKey("%s") should return %j', (gridKey, expected) => {
    expect(parseGridKey(gridKey)).toEqual(expected);
  });
});

describe('craterHeightProfile', () => {
  const baseCrater: Crater = {
    centerX: 0,
    centerZ: 0,
    radius: 10,
    depth: 2,
    rimHeight: 0.5,
    rimOuterRadius: 12,
    floorFlatness: 0,
    wobbleAmplitude: 0, // No wobble for predictable tests
    wobbleSeed: 42,
  };

  it('should return 0 outside crater influence', () => {
    const result = craterHeightProfile(15, 0, baseCrater);
    expect(result).toBe(0);
  });

  it('should return negative value (depression) inside crater', () => {
    const result = craterHeightProfile(0, 0, baseCrater);
    expect(result).toBeLessThan(0);
  });

  it('should return maximum depression at center', () => {
    const atCenter = craterHeightProfile(0, 0, baseCrater);
    const nearCenter = craterHeightProfile(2, 0, baseCrater);
    
    expect(atCenter).toBeLessThan(nearCenter);
    expect(atCenter).toBeCloseTo(-baseCrater.depth, 1);
  });

  it('should return positive value (rim) in rim zone', () => {
    // Rim is between radius (10) and rimOuterRadius (12)
    const result = craterHeightProfile(11, 0, baseCrater);
    expect(result).toBeGreaterThan(0);
  });

  it('should have smooth transition from bowl to rim', () => {
    const inBowl = craterHeightProfile(9, 0, baseCrater);
    const atEdge = craterHeightProfile(10, 0, baseCrater);
    const inRim = craterHeightProfile(11, 0, baseCrater);

    // Bowl should be negative, edge near zero, rim positive
    expect(inBowl).toBeLessThan(0);
    // At exact edge, should be close to 0
    expect(Math.abs(atEdge)).toBeLessThan(0.5);
    expect(inRim).toBeGreaterThan(0);
  });

  it('should match the analytic parabola exactly when floorFlatness is 0', () => {
    for (const distance of [0, 1, 2.5, 5, 7.5, 9, 9.99]) {
      const normalizedDist = distance / baseCrater.radius;
      const expected = -baseCrater.depth * (1 - normalizedDist * normalizedDist);
      expect(craterHeightProfile(distance, 0, baseCrater)).toBeCloseTo(expected, 12);
    }
  });

  describe('wobble regression (single-noise-evaluation refactor)', () => {
    // Golden values captured from the implementation that evaluated the rim
    // wobble noise separately for radius and rimOuterRadius. The refactored
    // code evaluates the wobble once and scales both radii, which must be
    // numerically identical since the wobble depends only on angle + seed.
    const wobblyCrater: Crater = {
      centerX: 0,
      centerZ: 0,
      radius: 10,
      depth: 2,
      rimHeight: 0.5,
      rimOuterRadius: 12,
      floorFlatness: 0,
      wobbleAmplitude: 0.05,
      wobbleSeed: 1234,
    };

    // [distance, angle, expected height]
    const goldenSamples: Array<[number, number, number]> = [
      [0, 0, -2],
      [0, 1.5, -2],
      [2.5, 0, -1.8757326068488842],
      [2.5, 0.7, -1.8704185145956733],
      [2.5, -2.1, -1.8779485504161324],
      [5, 0, -1.5029304273955373],
      [5, 1.5, -1.510071888774854],
      [5, 2.9, -1.474247203695584],
      [7.5, 0.7, -0.8337666313610599],
      [7.5, 3.14, -0.8916140225055438],
      [9, 0, -0.38949458476154053],
      [9, -2.1, -0.4182132133930747],
      // Near the wobbled bowl edge: sign depends on the wobble at each angle
      [9.9, 0, -0.05128844756146411],
      [9.9, 0.7, 0.06250625161899229],
      [9.9, 2.9, 0.11806002817004037],
      [10.1, 0, 0.055147549807839466],
      [10.1, 1.5, -0.000897334956914575],
      [10.1, 2.9, 0.2658130206985408],
      // Rim zone
      [11, 0, 0.4993572982585299],
      [11, 0.7, 0.4755837257012183],
      [11, 3.14, 0.4959056890483071],
      // Near the wobbled rim outer edge: some angles are already outside
      [11.9, 0, 0.10517701255681208],
      [11.9, 0.7, 0],
      [11.9, -2.1, 0.18492990333632278],
      // Fully outside
      [13, 0, 0],
      [20, 1.5, 0],
    ];

    it.each(goldenSamples)(
      'craterHeightProfile(%f, %f) should equal the pre-refactor value %f',
      (distance, angle, expected) => {
        expect(craterHeightProfile(distance, angle, wobblyCrater)).toBeCloseTo(expected, 12);
      }
    );
  });

  describe('floorFlatness', () => {
    const craterWithFlatness = (floorFlatness: number): Crater => ({
      ...baseCrater,
      floorFlatness,
    });

    it.each([[0], [0.25], [0.5], [0.75], [1]])(
      'profile should be continuous across the whole crater for floorFlatness = %f',
      (floorFlatness) => {
        const crater = craterWithFlatness(floorFlatness);
        // Scan from center to beyond the rim in fine steps; adjacent samples
        // must never jump by more than the max slope of the profile allows.
        // Max slope magnitude inside the bowl is 2 * depth / radius (parabola
        // at the rim, steeper when remapped for a flat floor), rim slope is
        // pi * rimHeight / rimWidth. Use a generous bound of 4x the step.
        const step = 0.001;
        const maxSlope = Math.max(
          (4 * crater.depth) / crater.radius,
          (Math.PI * crater.rimHeight) / (crater.rimOuterRadius - crater.radius)
        );
        const maxJump = maxSlope * step * 4;

        let prev = craterHeightProfile(0, 0, crater);
        for (let d = step; d <= crater.rimOuterRadius + 1; d += step) {
          const h = craterHeightProfile(d, 0, crater);
          expect(Math.abs(h - prev)).toBeLessThan(maxJump);
          prev = h;
        }
      }
    );

    it.each([[0.25], [0.5], [0.75], [1]])(
      'should not have a height step at half radius for floorFlatness = %f (regression)',
      (floorFlatness) => {
        // The old blend formula had a discontinuity at normalizedDist = 0.5
        // of size 0.25 * depth * (1 - floorFlatness).
        const crater = craterWithFlatness(floorFlatness);
        const epsilon = 1e-9;
        const justInside = craterHeightProfile(crater.radius * 0.5 - epsilon, 0, crater);
        const justOutside = craterHeightProfile(crater.radius * 0.5 + epsilon, 0, crater);
        expect(Math.abs(justInside - justOutside)).toBeLessThan(1e-6);
      }
    );

    it('should produce a flat floor over the inner half radius when floorFlatness = 1', () => {
      const crater = craterWithFlatness(1);
      for (const distance of [0, 1, 2.5, 4, 4.99]) {
        expect(craterHeightProfile(distance, 0, crater)).toBeCloseTo(-crater.depth, 12);
      }
      // Beyond the flat region the bowl must rise towards the rim
      expect(craterHeightProfile(7.5, 0, crater)).toBeGreaterThan(-crater.depth);
      expect(craterHeightProfile(9.99, 0, crater)).toBeCloseTo(0, 1);
    });

    it('should reach zero depth at the crater radius for all floorFlatness values', () => {
      for (const floorFlatness of [0, 0.5, 1]) {
        const crater = craterWithFlatness(floorFlatness);
        expect(craterHeightProfile(crater.radius, 0, crater)).toBeCloseTo(0, 12);
      }
    });

    it('should keep full depth at the center for all floorFlatness values', () => {
      for (const floorFlatness of [0, 0.5, 1]) {
        const crater = craterWithFlatness(floorFlatness);
        expect(craterHeightProfile(0, 0, crater)).toBeCloseTo(-crater.depth, 12);
      }
    });

    it('should widen the deep floor monotonically as floorFlatness increases', () => {
      // At a fixed point inside the bowl, more floor flatness means the
      // profile stays closer to full depth (more negative or equal).
      const distance = 4;
      let prev = craterHeightProfile(distance, 0, craterWithFlatness(0));
      for (const floorFlatness of [0.25, 0.5, 0.75, 1]) {
        const h = craterHeightProfile(distance, 0, craterWithFlatness(floorFlatness));
        expect(h).toBeLessThanOrEqual(prev);
        prev = h;
      }
    });
  });
});

describe('getCraterHeightModAt', () => {
  const createSimpleCrater = (x: number, z: number, radius: number): Crater => ({
    centerX: x,
    centerZ: z,
    radius,
    depth: 2,
    rimHeight: 0.5,
    rimOuterRadius: radius * 1.2,
    floorFlatness: 0,
    wobbleAmplitude: 0,
    wobbleSeed: 42,
  });

  it('should return 0 when no craters', () => {
    expect(getCraterHeightModAt(0, 0, [])).toBe(0);
  });

  it('should return depression inside crater', () => {
    const crater = createSimpleCrater(0, 0, 10);
    const result = getCraterHeightModAt(0, 0, [crater]);
    expect(result).toBeLessThan(0);
  });

  it('should return rim height outside crater but within rim', () => {
    const crater = createSimpleCrater(0, 0, 10);
    // Rim outer is at 12, so 11 should be in rim zone
    const result = getCraterHeightModAt(11, 0, [crater]);
    expect(result).toBeGreaterThan(0);
  });

  it('should return 0 completely outside crater', () => {
    const crater = createSimpleCrater(0, 0, 10);
    // Far outside both crater and rim
    const result = getCraterHeightModAt(100, 100, [crater]);
    expect(result).toBe(0);
  });

  it('should use deepest depression when craters overlap', () => {
    const crater1 = createSimpleCrater(0, 0, 10);
    const crater2 = createSimpleCrater(5, 0, 10);
    
    // At the overlap point, should use the deeper depression
    const singleCrater = getCraterHeightModAt(2.5, 0, [crater1]);
    const overlapping = getCraterHeightModAt(2.5, 0, [crater1, crater2]);
    
    // Overlapping should be at least as deep (more negative or equal)
    expect(overlapping).toBeLessThanOrEqual(singleCrater);
  });
});

describe('applyCratersToHeightBuffer', () => {
  const crater: Crater = {
    centerX: 0,
    centerZ: 0,
    radius: 10,
    depth: 2,
    rimHeight: 0.5,
    rimOuterRadius: 12,
    floorFlatness: 0,
    wobbleAmplitude: 0.05,
    wobbleSeed: 1234,
  };

  const makeBuffer = (points: Array<[number, number, number]>): Float32Array => {
    const positions = new Float32Array(points.length * 3);
    points.forEach(([x, y, z], i) => {
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    });
    return positions;
  };

  it('should leave the buffer unchanged when there are no craters', () => {
    const positions = makeBuffer([[0, 5, 0], [3, 7, -2]]);
    const original = positions.slice();
    applyCratersToHeightBuffer(positions, 400, 400, []);
    expect(positions).toEqual(original);
  });

  it('should modify only the Y component and only for vertices in range', () => {
    const positions = makeBuffer([
      [0, 5, 0],    // crater center: depression
      [11, 5, 0],   // rim zone: raised
      [100, 5, 100], // far outside: untouched
    ]);
    applyCratersToHeightBuffer(positions, 400, 400, [crater]);

    // X and Z untouched
    expect(positions[0]).toBe(0);
    expect(positions[2]).toBe(0);
    expect(positions[3]).toBe(11);
    expect(positions[5]).toBe(0);

    // Center vertex lowered, rim vertex raised, far vertex untouched
    expect(positions[1]).toBeLessThan(5);
    expect(positions[4]).toBeGreaterThan(5);
    expect(positions[7]).toBe(5);
  });

  it('should apply the same modification as getCraterHeightModAt at each vertex', () => {
    const points: Array<[number, number, number]> = [];
    for (let x = -15; x <= 15; x += 3) {
      for (let z = -15; z <= 15; z += 3) {
        points.push([x, 1, z]);
      }
    }
    const positions = makeBuffer(points);
    applyCratersToHeightBuffer(positions, 400, 400, [crater]);

    points.forEach(([x, y, z], i) => {
      const expected = y + getCraterHeightModAt(x, z, [crater]);
      expect(positions[i * 3 + 1]).toBeCloseTo(expected, 5);
    });
  });
});

describe('generateCratersForRegion', () => {
  const baseParams: CraterParams = {
    seed: 42,
    density: 100,
    minRadius: 5,
    maxRadius: 50,
    powerLawExponent: -2.2,
    depthRatio: 0.15,
    rimHeight: 0.3,
    rimWidth: 0.2,
    floorFlatness: 0,
  };

  it('should generate craters deterministically (same seed = same craters)', () => {
    const craters1 = generateCratersForRegion('0,0', 400, 400, baseParams);
    const craters2 = generateCratersForRegion('0,0', 400, 400, baseParams);
    
    expect(craters1.length).toBe(craters2.length);
    if (craters1.length > 0) {
      expect(craters1[0].centerX).toBe(craters2[0].centerX);
      expect(craters1[0].centerZ).toBe(craters2[0].centerZ);
      expect(craters1[0].radius).toBe(craters2[0].radius);
    }
  });

  it('should generate different craters for different chunks', () => {
    const craters1 = generateCratersForRegion('0,0', 400, 400, baseParams);
    const craters2 = generateCratersForRegion('10,10', 400, 400, baseParams);
    
    // Different chunks should generally have different crater positions
    // (there's a tiny chance they're identical, but very unlikely)
    if (craters1.length > 0 && craters2.length > 0) {
      const samePosition = craters1[0].centerX === craters2[0].centerX && 
                           craters1[0].centerZ === craters2[0].centerZ;
      expect(samePosition).toBe(false);
    }
  });

  it('should generate craters with radii within specified range', () => {
    const craters = generateCratersForRegion('0,0', 400, 400, baseParams);
    
    for (const crater of craters) {
      expect(crater.radius).toBeGreaterThanOrEqual(baseParams.minRadius);
      expect(crater.radius).toBeLessThanOrEqual(baseParams.maxRadius);
    }
  });

  it('should calculate rim properties correctly', () => {
    const craters = generateCratersForRegion('0,0', 400, 400, baseParams);
    
    for (const crater of craters) {
      // Rim outer radius should be radius * (1 + rimWidth)
      const expectedRimOuter = crater.radius * (1 + baseParams.rimWidth);
      expect(crater.rimOuterRadius).toBeCloseTo(expectedRimOuter, 5);
      
      // Depth should be radius * depthRatio * 2
      const expectedDepth = crater.radius * baseParams.depthRatio * 2;
      expect(crater.depth).toBeCloseTo(expectedDepth, 5);
    }
  });

  it('should return empty array when density is 0', () => {
    const zeroDensityParams = { ...baseParams, density: 0 };
    const craters = generateCratersForRegion('0,0', 400, 400, zeroDensityParams);
    expect(craters.length).toBe(0);
  });
});
