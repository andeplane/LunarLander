import { describe, it, expect } from 'vitest';
import {
  parseGridKey,
  craterHeightProfile,
  getCraterHeightModAt,
  generateCratersForRegion,
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
