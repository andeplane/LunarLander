import { describe, it, expect } from 'vitest';
import { LANDER_CONFIG } from './config';
import { fuelCapacityForMission, missionParamsForIndex } from './mission';

/** Indices covered by the ramp assertions. */
const INDICES = Array.from({ length: 31 }, (_, i) => i);

describe('missionParamsForIndex', () => {
  it('is deterministic: same index → deep-equal params', () => {
    expect(missionParamsForIndex(0)).toEqual(missionParamsForIndex(0));
    expect(missionParamsForIndex(7)).toEqual(missionParamsForIndex(7));
    expect(missionParamsForIndex(23)).toEqual(missionParamsForIndex(23));
  });

  it('produces distinct params for different indices', () => {
    const a = missionParamsForIndex(3);
    const b = missionParamsForIndex(4);
    expect(a).not.toEqual(b);
    expect(a.seed).not.toBe(b.seed);
  });

  it('records the index it was generated from', () => {
    for (const i of [0, 5, 12]) {
      expect(missionParamsForIndex(i).index).toBe(i);
    }
  });

  it('starts mission 0 at the ADR-0004 baseline', () => {
    const m = missionParamsForIndex(0);
    expect(m.spawnDistance).toBeGreaterThan(450); // ~500 ± jitter
    expect(m.spawnDistance).toBeLessThan(550);
    expect(m.spawnAltitudeAGL).toBeGreaterThan(270); // ~300 ± jitter
    expect(m.spawnAltitudeAGL).toBeLessThan(330);
    expect(m.spawnHorizontalSpeed).toBeGreaterThan(10); // ~12 ± jitter
    expect(m.spawnHorizontalSpeed).toBeLessThan(14);
    expect(m.spawnDescentRate).toBeGreaterThan(13); // ~15 ± jitter
    expect(m.spawnDescentRate).toBeLessThan(17);
    expect(m.spawnBearingError).toBe(0); // ramp starts at exactly 0
    expect(m.padRadius).toBe(10); // pad diameter 20 m
    expect(m.padMultiplier).toBe(1);
    expect(m.fuelMarginFactor).toBeCloseTo(2.2, 10);
  });

  it('stays inside the asymptotic bounds at every index', () => {
    for (const i of INDICES) {
      const m = missionParamsForIndex(i);
      expect(m.spawnDistance).toBeLessThan(800 * 1.08); // asymptote + jitter
      expect(m.spawnAltitudeAGL).toBeLessThan(400 * 1.06);
      expect(m.spawnHorizontalSpeed).toBeLessThan(20 * 1.1);
      expect(m.spawnDescentRate).toBeLessThan(18 * 1.1);
      expect(Math.abs(m.spawnBearingError)).toBeLessThan(0.4);
      expect(m.padRadius).toBeGreaterThan(5); // never reaches the limit
      expect(m.padRadius).toBeLessThanOrEqual(10);
      expect(m.padMultiplier).toBeGreaterThanOrEqual(1);
      expect(m.padMultiplier).toBeLessThan(3);
      expect(m.fuelMarginFactor).toBeGreaterThan(1.4);
      expect(m.fuelMarginFactor).toBeLessThanOrEqual(2.2);
    }
  });

  it('ramps difficulty monotonically over indices 0..30', () => {
    let prev = missionParamsForIndex(0);
    for (const i of INDICES.slice(1)) {
      const m = missionParamsForIndex(i);
      // Pads shrink, pay more, and fuel margins tighten — never the reverse
      expect(m.padRadius).toBeLessThanOrEqual(prev.padRadius);
      expect(m.padMultiplier).toBeGreaterThanOrEqual(prev.padMultiplier);
      expect(m.fuelMarginFactor).toBeLessThanOrEqual(prev.fuelMarginFactor);
      prev = m;
    }
  });
});

describe('fuelCapacityForMission', () => {
  it('is positive and never exceeds the tank size at any index', () => {
    for (const i of INDICES) {
      const capacity = fuelCapacityForMission(missionParamsForIndex(i));
      expect(capacity).toBeGreaterThan(0);
      expect(capacity).toBeLessThanOrEqual(LANDER_CONFIG.fuelMass);
    }
  });

  it('gives a substantial tank even on the hardest missions', () => {
    // The ramp is asymptotic — missions must never become impossible
    for (const i of INDICES) {
      const capacity = fuelCapacityForMission(missionParamsForIndex(i));
      expect(capacity).toBeGreaterThan(LANDER_CONFIG.fuelMass / 2);
    }
  });

  it('scales with the mission margin factor', () => {
    for (const i of [0, 10, 25]) {
      const m = missionParamsForIndex(i);
      const tighter = { ...m, fuelMarginFactor: m.fuelMarginFactor / 2 };
      expect(fuelCapacityForMission(tighter)).toBeLessThan(
        fuelCapacityForMission(m)
      );
    }
  });

  it('applies a non-increasing margin factor over indices 0..30', () => {
    let prevMargin = missionParamsForIndex(0).fuelMarginFactor;
    for (const i of INDICES.slice(1)) {
      const margin = missionParamsForIndex(i).fuelMarginFactor;
      expect(margin).toBeLessThanOrEqual(prevMargin);
      prevMargin = margin;
    }
  });
});
