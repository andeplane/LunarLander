import { describe, it, expect } from 'vitest';
import { FbmNoiseBuilder, createFbmNoise, normalizeFbmRange, debugMinMax, type FbmArgs } from './noise';

describe('FbmNoiseBuilder', () => {
  it('should build noise function with default values', () => {
    const noise = new FbmNoiseBuilder().build();
    const value = noise(0, 0);
    expect(typeof value).toBe('number');
    expect(Number.isFinite(value)).toBe(true);
  });

  it('should allow chaining configuration', () => {
    const builder = new FbmNoiseBuilder()
      .octaves(4)
      .seed(123)
      .gain(0.5)
      .frequency(0.1)
      .amplitude(1)
      .lacunarity(2)
      .offset(0.5);
    
    const noise = builder.build();
    expect(typeof noise(1, 1)).toBe('number');
  });

  it('should produce deterministic results with same seed', () => {
    const noise1 = new FbmNoiseBuilder().seed(42).build();
    const noise2 = new FbmNoiseBuilder().seed(42).build();
    
    expect(noise1(10, 20)).toBe(noise2(10, 20));
    expect(noise1(0.5, 0.7)).toBe(noise2(0.5, 0.7));
  });

  it('should produce different results with different seeds', () => {
    const noise1 = new FbmNoiseBuilder().seed(42).build();
    const noise2 = new FbmNoiseBuilder().seed(123).build();
    
    // Different seeds should produce different values (very unlikely to be equal)
    expect(noise1(10, 20)).not.toBe(noise2(10, 20));
  });
});

describe('createFbmNoise', () => {
  const defaultArgs: FbmArgs = {
    octaves: 4,
    lacunarity: 2,
    frequency: 0.1,
    amplitude: 1,
    gain: 0.5,
    smoothLowerPlanes: 0,
    seed: 42,
  };

  it('should create a noise function', () => {
    const noise = createFbmNoise(defaultArgs);
    expect(typeof noise).toBe('function');
    expect(typeof noise(0, 0)).toBe('number');
  });

  it('should be continuous (small input changes produce small output changes)', () => {
    const noise = createFbmNoise(defaultArgs);
    
    const value1 = noise(0, 0);
    const value2 = noise(0.001, 0.001);
    
    // Small input change should produce small output change
    expect(Math.abs(value1 - value2)).toBeLessThan(0.1);
  });

  it('should apply smoothLowerPlanes offset', () => {
    const noOffset = createFbmNoise({ ...defaultArgs, smoothLowerPlanes: 0 });
    const withOffset = createFbmNoise({ ...defaultArgs, smoothLowerPlanes: 0.5 });
    
    const point = [100, 200];
    const valueNoOffset = noOffset(point[0], point[1]);
    const valueWithOffset = withOffset(point[0], point[1]);
    
    // With offset should be shifted by exactly 0.5
    expect(valueWithOffset - valueNoOffset).toBeCloseTo(0.5);
  });

  it('should respect octaves parameter', () => {
    const lowOctaves = createFbmNoise({ ...defaultArgs, octaves: 1 });
    const highOctaves = createFbmNoise({ ...defaultArgs, octaves: 8 });
    
    // Both should produce valid numbers
    expect(Number.isFinite(lowOctaves(5, 5))).toBe(true);
    expect(Number.isFinite(highOctaves(5, 5))).toBe(true);
  });
});

describe('normalizeFbmRange', () => {
  it('should map -0.4 to 0', () => {
    expect(normalizeFbmRange(-0.4)).toBeCloseTo(0);
  });

  it('should map 0.9 to 1', () => {
    expect(normalizeFbmRange(0.9)).toBeCloseTo(1);
  });

  it('should map midpoint correctly', () => {
    // Midpoint between -0.4 and 0.9 is 0.25
    expect(normalizeFbmRange(0.25)).toBeCloseTo(0.5);
  });

  it('should handle values outside expected range', () => {
    // These may extrapolate beyond [0, 1]
    const below = normalizeFbmRange(-0.5);
    const above = normalizeFbmRange(1.0);
    
    expect(Number.isFinite(below)).toBe(true);
    expect(Number.isFinite(above)).toBe(true);
  });
});

describe('debugMinMax', () => {
  it.each([
    [0, -0.5, 0.5, 0],       // within range
    [-0.6, -0.5, 0.5, -0.4], // below lower threshold
    [0.6, -0.5, 0.5, 0.4],   // above upper threshold
    [-0.5, -0.5, 0.5, 0],    // at lower boundary
    [0.5, -0.5, 0.5, 0],     // at upper boundary
  ])('debugMinMax(%d, %d, %d) should return %d', (value, checkBelow, checkAbove, expected) => {
    expect(debugMinMax(value, checkBelow, checkAbove)).toBe(expected);
  });
});
