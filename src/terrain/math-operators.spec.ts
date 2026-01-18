import { describe, it, expect } from 'vitest';
import { mapRangeClamped, mapRangeSmooth, closeTo, smoothAbs, smoothPingpong } from './math-operators';

describe('mapRangeClamped', () => {
  it.each([
    [0.5, 0, 1, 0, 100, 50],    // midpoint mapping
    [0, 0, 1, 0, 100, 0],       // at a1
    [1, 0, 1, 0, 100, 100],     // at a2
    [-0.5, 0, 1, 0, 100, 0],    // below range, clamped to b1
    [1.5, 0, 1, 0, 100, 100],   // above range, clamped to b2
    [5, 0, 10, 100, 200, 150],  // different range
  ])('mapRangeClamped(%d, %d, %d, %d, %d) should return %d', (val, a1, a2, b1, b2, expected) => {
    expect(mapRangeClamped(val, a1, a2, b1, b2)).toBeCloseTo(expected);
  });
});

describe('mapRangeSmooth', () => {
  it.each([
    [0, 0, 1, 0, 100, 0],       // at edge0
    [1, 0, 1, 0, 100, 100],     // at edge1
    [0.5, 0, 1, 0, 100, 50],    // midpoint (smoothstep at 0.5 = 0.5)
  ])('mapRangeSmooth(%d, %d, %d, %d, %d) should return %d', (val, a1, a2, b1, b2, expected) => {
    expect(mapRangeSmooth(val, a1, a2, b1, b2)).toBeCloseTo(expected);
  });

  it('should produce smooth transition', () => {
    // Values near edges should be smoothly approaching
    const nearA1 = mapRangeSmooth(0.1, 0, 1, 0, 100);
    const nearA2 = mapRangeSmooth(0.9, 0, 1, 0, 100);
    
    expect(nearA1).toBeGreaterThan(0);
    expect(nearA1).toBeLessThan(20);
    expect(nearA2).toBeGreaterThan(80);
    expect(nearA2).toBeLessThan(100);
  });
});

describe('closeTo', () => {
  it.each([
    [1, 1, 0.01, true],           // exact match
    [1, 1.005, 0.01, true],       // within default epsilon
    [1, 1.02, 0.01, false],       // outside default epsilon
    [1, 1.05, 0.1, true],         // within custom epsilon
    [0, 0.009, undefined, true],  // near zero, within default
    [-1, -1.005, 0.01, true],     // negative numbers
  ])('closeTo(%d, %d, %s) should return %s', (a, b, epsilon, expected) => {
    if (epsilon === undefined) {
      expect(closeTo(a, b)).toBe(expected);
    } else {
      expect(closeTo(a, b, epsilon)).toBe(expected);
    }
  });
});

describe('smoothAbs', () => {
  it('should approximate Math.abs for large values', () => {
    expect(smoothAbs(10)).toBeCloseTo(10, 1);
    expect(smoothAbs(-10)).toBeCloseTo(10, 1);
    expect(smoothAbs(100)).toBeCloseTo(100, 1);
    expect(smoothAbs(-100)).toBeCloseTo(100, 1);
  });

  it('should be smooth (non-zero) at x=0', () => {
    // Unlike Math.abs(0) = 0, smoothAbs(0) = sqrt(epsilon) > 0
    expect(smoothAbs(0)).toBeGreaterThan(0);
    expect(smoothAbs(0, 0.01)).toBeCloseTo(0.1, 2);
  });

  it('should be symmetric', () => {
    expect(smoothAbs(5)).toBe(smoothAbs(-5));
    expect(smoothAbs(0.1)).toBe(smoothAbs(-0.1));
  });

  it('should respect custom epsilon', () => {
    const smallEpsilon = smoothAbs(0, 0.0001);
    const largeEpsilon = smoothAbs(0, 1);
    expect(smallEpsilon).toBeLessThan(largeEpsilon);
  });
});

describe('smoothPingpong', () => {
  it('should return 0 at x=0', () => {
    expect(smoothPingpong(0)).toBeCloseTo(0, 5);
  });

  it('should return length at x=length', () => {
    expect(smoothPingpong(1, 1)).toBeCloseTo(1, 5);
    expect(smoothPingpong(5, 5)).toBeCloseTo(5, 5);
  });

  it('should return 0 at x=2*length (one full period)', () => {
    expect(smoothPingpong(2, 1)).toBeCloseTo(0, 5);
    expect(smoothPingpong(10, 5)).toBeCloseTo(0, 5);
  });

  it('should be periodic', () => {
    const length = 1;
    const period = length * 2;
    
    expect(smoothPingpong(0.5, length)).toBeCloseTo(smoothPingpong(0.5 + period, length), 5);
    expect(smoothPingpong(1.3, length)).toBeCloseTo(smoothPingpong(1.3 + period * 3, length), 5);
  });

  it('should handle negative values', () => {
    // Function should still be periodic and bounded
    const result = smoothPingpong(-0.5, 1);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('should stay in range [0, length]', () => {
    const length = 5;
    for (let x = -10; x <= 10; x += 0.7) {
      const result = smoothPingpong(x, length);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(length);
    }
  });
});
