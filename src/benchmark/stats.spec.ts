import { describe, expect, it } from 'vitest';
import { calculateStats, sanitizeIterations } from './stats';

describe('calculateStats', () => {
  it('returns all-zero stats for an empty array (no NaN/undefined)', () => {
    const stats = calculateStats([]);
    expect(stats).toEqual({ mean: 0, min: 0, max: 0, median: 0 });
    expect(Number.isNaN(stats.mean)).toBe(false);
    expect(Number.isNaN(stats.median)).toBe(false);
  });

  it('handles a single sample', () => {
    expect(calculateStats([5])).toEqual({ mean: 5, min: 5, max: 5, median: 5 });
  });

  it('computes mean, min and max', () => {
    const stats = calculateStats([2, 4, 6, 8]);
    expect(stats.mean).toBe(5);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(8);
  });

  it('computes the median of an odd-length array', () => {
    expect(calculateStats([1, 100, 3]).median).toBe(3);
  });

  it('computes the median of an even-length array', () => {
    expect(calculateStats([1, 2, 3, 10]).median).toBe(2.5);
  });

  it('does not depend on input ordering', () => {
    const stats = calculateStats([9, 1, 5]);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(9);
    expect(stats.median).toBe(5);
  });

  it('does not mutate the input array', () => {
    const times = [3, 1, 2];
    calculateStats(times);
    expect(times).toEqual([3, 1, 2]);
  });
});

describe('sanitizeIterations', () => {
  it('passes through valid positive integers', () => {
    expect(sanitizeIterations(3)).toBe(3);
    expect(sanitizeIterations(1)).toBe(1);
    expect(sanitizeIterations(20)).toBe(20);
  });

  it('clamps zero and negative values to 1', () => {
    expect(sanitizeIterations(0)).toBe(1);
    expect(sanitizeIterations(-2)).toBe(1);
    expect(sanitizeIterations(-100)).toBe(1);
  });

  it('floors fractional values', () => {
    expect(sanitizeIterations(2.9)).toBe(2);
    expect(sanitizeIterations(1.1)).toBe(1);
  });

  it('falls back for non-finite values', () => {
    expect(sanitizeIterations(Number.NaN)).toBe(3);
    expect(sanitizeIterations(Number.POSITIVE_INFINITY)).toBe(3);
    expect(sanitizeIterations(Number.NEGATIVE_INFINITY)).toBe(3);
  });

  it('respects a custom fallback', () => {
    expect(sanitizeIterations(Number.NaN, 5)).toBe(5);
  });
});
