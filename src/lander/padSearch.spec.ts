import { describe, it, expect } from 'vitest';
import alea from 'alea';
import { evaluateDisc, findLandingPad, siteQualityAt } from './padSearch';
import type { TerrainHeightSampler } from '../terrain/heightSampler';

/** Synthetic sampler from an analytic height function. */
function makeSampler(heightFn: (x: number, z: number) => number): TerrainHeightSampler {
  return {
    heightAt: heightFn,
    slopeAt: (x, z, baselineM = 1.5) => {
      const h = baselineM / 2;
      const ddx = (heightFn(x + h, z) - heightFn(x - h, z)) / baselineM;
      const ddz = (heightFn(x, z + h) - heightFn(x, z - h)) / baselineM;
      return (Math.atan(Math.hypot(ddx, ddz)) * 180) / Math.PI;
    },
  };
}

const flat = makeSampler(() => 5);
/** A 6 m-radius, 1.5 m-deep crater bowl at (30, 0), flat elsewhere. */
const cratered = makeSampler((x, z) => {
  const d = Math.hypot(x - 30, z);
  if (d >= 6) return 0;
  const t = d / 6;
  return -1.5 * (1 - t * t);
});
/** Constant 20% grade everywhere (≈11.3°). */
const sloped = makeSampler((x, _z) => x * 0.2);

function search(sampler: TerrainHeightSampler, overrides?: Partial<Parameters<typeof findLandingPad>[0]>) {
  return findLandingPad({
    sampler,
    centerX: 0,
    centerZ: 0,
    searchRadius: 120,
    padRadius: 10,
    maxSlopeDeg: 6,
    maxHeightSpread: 2,
    rocks: [],
    rng: alea('pad-test'),
    ...overrides,
  });
}

describe('evaluateDisc', () => {
  it('reports zero slope and spread on flat terrain', () => {
    const result = evaluateDisc(flat, 0, 0, 10);
    expect(result.maxSlopeDeg).toBe(0);
    expect(result.heightSpread).toBe(0);
  });

  it('detects a small crater inside the disc (dense sampling)', () => {
    const result = evaluateDisc(cratered, 30, 0, 10);
    expect(result.maxSlopeDeg).toBeGreaterThan(6);
    expect(result.heightSpread).toBeGreaterThan(1);
  });
});

describe('findLandingPad', () => {
  it('accepts flat terrain at the center immediately', () => {
    const pad = search(flat);
    expect(pad).not.toBeNull();
    expect(pad?.x).toBe(0);
    expect(pad?.z).toBe(0);
    expect(pad?.y).toBe(5);
    expect(pad?.quality).toBeCloseTo(1, 5);
  });

  it('avoids a crater-covered center by moving the pad', () => {
    const pad = findLandingPad({
      sampler: cratered,
      centerX: 30,
      centerZ: 0,
      searchRadius: 120,
      padRadius: 10,
      maxSlopeDeg: 6,
      maxHeightSpread: 2,
      rocks: [],
      rng: alea('pad-test'),
    });
    expect(pad).not.toBeNull();
    // The chosen disc must not include the crater (center is at 30,0 r=6)
    const dist = Math.hypot((pad?.x ?? 0) - 30, pad?.z ?? 0);
    expect(dist).toBeGreaterThan(10);
  });

  it('rejects everything on terrain steeper than the slope limit', () => {
    expect(search(sloped)).toBeNull();
  });

  it('excludes discs containing blocking rocks and ignores small ones', () => {
    // A 2 m boulder exactly at the center; flat terrain otherwise
    const withRock = search(flat, {
      rocks: [{ x: 0, z: 0, diameter: 2 }],
      searchRadius: 40,
    });
    expect(withRock).not.toBeNull();
    const dist = Math.hypot(withRock?.x ?? 0, withRock?.z ?? 0);
    expect(dist).toBeGreaterThan(10); // pushed off-center

    // Sub-threshold rocks (< 1 m) do not block
    const withPebble = search(flat, {
      rocks: [{ x: 0, z: 0, diameter: 0.5 }],
    });
    expect(withPebble?.x).toBe(0);
  });

  it('is deterministic for the same seed', () => {
    const a = search(cratered, { rng: alea('seed-42'), centerX: 25 });
    const b = search(cratered, { rng: alea('seed-42'), centerX: 25 });
    expect(a).toEqual(b);
  });
});

describe('siteQualityAt', () => {
  it('is 1 on flat ground and lower on rough ground', () => {
    expect(siteQualityAt(flat, 0, 0)).toBe(1);
    const inCrater = siteQualityAt(cratered, 27, 0);
    expect(inCrater).toBeLessThan(0.8);
    expect(inCrater).toBeGreaterThanOrEqual(0);
  });
});
