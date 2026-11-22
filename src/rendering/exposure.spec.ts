import { describe, expect, it } from 'vitest';
import { exposureForSun, HIGH_SUN_EXPOSURE, LOW_SUN_EXPOSURE, NIGHT_EXPOSURE } from './exposure';

describe('exposureForSun', () => {
  it('stops down under a high sun', () => {
    expect(exposureForSun(0.9, 1)).toBeCloseTo(HIGH_SUN_EXPOSURE);
    expect(exposureForSun(1, 1)).toBeCloseTo(HIGH_SUN_EXPOSURE);
  });

  it('opens up for a low sun', () => {
    expect(exposureForSun(0.05, 1)).toBeCloseTo(LOW_SUN_EXPOSURE);
  });

  it('changes monotonically in between', () => {
    let previous = exposureForSun(0, 1);
    for (let s = 0.05; s <= 1; s += 0.05) {
      const current = exposureForSun(s, 1);
      expect(current).toBeLessThanOrEqual(previous);
      previous = current;
    }
  });

  it('uses the night exposure once the sun is down, blending through sunset', () => {
    expect(exposureForSun(-0.4, 0)).toBeCloseTo(NIGHT_EXPOSURE);
    const dusk = exposureForSun(0.02, 0.5);
    expect(dusk).toBeGreaterThan(LOW_SUN_EXPOSURE);
    expect(dusk).toBeLessThan(NIGHT_EXPOSURE);
  });

  it('clamps an out-of-range fade', () => {
    expect(exposureForSun(0.5, 2)).toBeCloseTo(exposureForSun(0.5, 1));
    expect(exposureForSun(0.5, -1)).toBeCloseTo(NIGHT_EXPOSURE);
  });
});
