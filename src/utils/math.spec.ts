import { describe, it, expect } from 'vitest';
import { clamp, lerp, smoothstep, degToRad, radToDeg, distance2D } from './math';

describe('clamp', () => {
  it.each([
    [5, 0, 10, 5],      // value within range
    [-5, 0, 10, 0],     // value below min
    [15, 0, 10, 10],    // value above max
    [0, 0, 10, 0],      // value equals min
    [10, 0, 10, 10],    // value equals max
    [-5, -10, -1, -5],  // negative range, value within
  ])('clamp(%d, %d, %d) should return %d', (value, min, max, expected) => {
    expect(clamp(value, min, max)).toBe(expected);
  });
});

describe('lerp', () => {
  it.each([
    [0, 10, 0, 0],       // t=0 returns a
    [0, 10, 1, 10],      // t=1 returns b
    [0, 10, 0.5, 5],     // t=0.5 returns midpoint
    [0, 10, 0.25, 2.5],  // t=0.25
    [-10, 10, 0.5, 0],   // negative to positive range
    [10, 0, 0.5, 5],     // reversed range
  ])('lerp(%d, %d, %d) should return %d', (a, b, t, expected) => {
    expect(lerp(a, b, t)).toBe(expected);
  });
});

describe('smoothstep', () => {
  it.each([
    [0, 1, -0.5, 0],   // below edge0
    [0, 1, 0, 0],      // at edge0
    [0, 1, 0.5, 0.5],  // midpoint
    [0, 1, 1, 1],      // at edge1
    [0, 1, 1.5, 1],    // above edge1
  ])('smoothstep(%d, %d, %d) should return %d', (edge0, edge1, x, expected) => {
    expect(smoothstep(edge0, edge1, x)).toBe(expected);
  });

  it('should produce smooth curve between edges', () => {
    // Smoothstep has zero derivative at edges
    const result = smoothstep(0, 1, 0.5);
    expect(result).toBe(0.5);
    
    // Check that values near edges are smoothly approaching
    const nearEdge0 = smoothstep(0, 1, 0.1);
    const nearEdge1 = smoothstep(0, 1, 0.9);
    expect(nearEdge0).toBeGreaterThan(0);
    expect(nearEdge0).toBeLessThan(0.2);
    expect(nearEdge1).toBeGreaterThan(0.8);
    expect(nearEdge1).toBeLessThan(1);
  });
});

describe('degToRad', () => {
  it.each([
    [0, 0],
    [90, Math.PI / 2],
    [180, Math.PI],
    [360, 2 * Math.PI],
    [-90, -Math.PI / 2],
  ])('degToRad(%d) should return %d', (degrees, expected) => {
    expect(degToRad(degrees)).toBeCloseTo(expected);
  });
});

describe('radToDeg', () => {
  it.each([
    [0, 0],
    [Math.PI / 2, 90],
    [Math.PI, 180],
    [2 * Math.PI, 360],
    [-Math.PI / 2, -90],
  ])('radToDeg(%d) should return %d', (radians, expected) => {
    expect(radToDeg(radians)).toBeCloseTo(expected);
  });
});

describe('distance2D', () => {
  it.each([
    [0, 0, 0, 0, 0],         // same point
    [0, 0, 3, 4, 5],         // 3-4-5 triangle
    [0, 0, 1, 0, 1],         // horizontal
    [0, 0, 0, 1, 1],         // vertical
    [-1, -1, 1, 1, Math.sqrt(8)], // diagonal through origin
  ])('distance2D(%d, %d, %d, %d) should return %d', (x1, z1, x2, z2, expected) => {
    expect(distance2D(x1, z1, x2, z2)).toBeCloseTo(expected);
  });
});
