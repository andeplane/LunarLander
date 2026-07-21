import { describe, it, expect } from 'vitest';
import { LANDER_CONFIG } from './config';
import { gradeLanding, scoreLanding } from './scoring';
import type { MissionParams, TouchdownStats } from './types';

const T = LANDER_CONFIG.touchdown;
const S = LANDER_CONFIG.scoring;

/** A flawless on-pad touchdown; override per test. */
function stats(overrides: Partial<TouchdownStats> = {}): TouchdownStats {
  return {
    maxVerticalSpeed: 0.5,
    maxDriftSpeed: 0,
    maxTiltDeg: 0,
    slopeDeg: 0,
    distanceToPadCenter: 0,
    onPad: true,
    siteQuality: 1,
    fuelFraction: 0.5,
    usedHoverHold: false,
    usedBellyCam: false,
    bodyContact: false,
    tippedOver: false,
    ...overrides,
  };
}

/** Mission-0-like params; override per test. */
function mission(overrides: Partial<MissionParams> = {}): MissionParams {
  return {
    index: 0,
    seed: 1,
    spawnDistance: 500,
    spawnAltitudeAGL: 300,
    spawnHorizontalSpeed: 12,
    spawnDescentRate: 15,
    spawnBearingError: 0,
    padRadius: 10,
    padMultiplier: 1,
    fuelMarginFactor: 2.2,
    ...overrides,
  };
}

describe('gradeLanding', () => {
  // Note: bounce/worst-case semantics are the CALLER's responsibility —
  // TouchdownStats must already carry the worst (max) v↓/drift/tilt over
  // every leg-contact instant in the grading window. gradeLanding only
  // sees the accumulated maxima.

  it('grades a flawless touchdown as perfect', () => {
    expect(gradeLanding(stats())).toBe('perfect');
  });

  it('grades exactly at the perfect thresholds as perfect (inclusive)', () => {
    expect(
      gradeLanding(
        stats({
          maxVerticalSpeed: T.perfectVSpeed,
          maxDriftSpeed: T.perfectDrift,
          maxTiltDeg: T.perfectTiltDeg,
        })
      )
    ).toBe('perfect');
  });

  it('drops to good when any single metric exceeds its perfect limit', () => {
    expect(
      gradeLanding(stats({ maxVerticalSpeed: T.perfectVSpeed + 0.001 }))
    ).toBe('good');
    expect(gradeLanding(stats({ maxDriftSpeed: T.perfectDrift + 0.001 }))).toBe(
      'good'
    );
    expect(gradeLanding(stats({ maxTiltDeg: T.perfectTiltDeg + 0.001 }))).toBe(
      'good'
    );
  });

  it('perfect requires slope within the Good slope limit', () => {
    // Perfect v/drift/tilt but slope beyond good → not perfect, not good
    expect(gradeLanding(stats({ slopeDeg: T.goodSlopeDeg }))).toBe('perfect');
    expect(gradeLanding(stats({ slopeDeg: T.goodSlopeDeg + 0.001 }))).toBe(
      'hard'
    );
  });

  it('grades exactly at the good thresholds as good (inclusive)', () => {
    expect(
      gradeLanding(
        stats({
          maxVerticalSpeed: T.goodVSpeed,
          maxDriftSpeed: T.goodDrift,
          maxTiltDeg: T.goodTiltDeg,
          slopeDeg: T.goodSlopeDeg,
        })
      )
    ).toBe('good');
  });

  it('drops to hard when any single metric exceeds its good limit', () => {
    expect(gradeLanding(stats({ maxVerticalSpeed: T.goodVSpeed + 0.001 }))).toBe(
      'hard'
    );
    expect(gradeLanding(stats({ maxDriftSpeed: T.goodDrift + 0.001 }))).toBe(
      'hard'
    );
    expect(gradeLanding(stats({ maxTiltDeg: T.goodTiltDeg + 0.001 }))).toBe(
      'hard'
    );
    expect(gradeLanding(stats({ slopeDeg: T.goodSlopeDeg + 0.001 }))).toBe(
      'hard'
    );
  });

  it('grades exactly at hardFactor × good limits as hard (inclusive)', () => {
    expect(
      gradeLanding(
        stats({
          maxVerticalSpeed: T.goodVSpeed * T.hardFactor,
          maxDriftSpeed: T.goodDrift * T.hardFactor,
          maxTiltDeg: T.goodTiltDeg * T.hardFactor,
          slopeDeg: T.goodSlopeDeg * T.hardFactor,
        })
      )
    ).toBe('hard');
  });

  it('crashes when any single impact metric exceeds hardFactor × good limit', () => {
    expect(
      gradeLanding(stats({ maxVerticalSpeed: T.goodVSpeed * T.hardFactor + 0.001 }))
    ).toBe('crash');
    expect(
      gradeLanding(stats({ maxDriftSpeed: T.goodDrift * T.hardFactor + 0.001 }))
    ).toBe('crash');
    expect(
      gradeLanding(stats({ maxTiltDeg: T.goodTiltDeg * T.hardFactor + 0.001 }))
    ).toBe('crash');
  });

  it('steep terrain can never crash a stable landing — it caps the grade at hard', () => {
    // The craft came to rest upright on its legs: physics already proved
    // survival. Arbitrarily steep sampled slope only downgrades to hard.
    expect(
      gradeLanding(stats({ slopeDeg: T.goodSlopeDeg * T.hardFactor + 0.001 }))
    ).toBe('hard');
    expect(gradeLanding(stats({ slopeDeg: 45 }))).toBe('hard');
    // ...but slope beyond the Good limit still blocks Good/Perfect
    expect(gradeLanding(stats({ slopeDeg: T.goodSlopeDeg + 0.001 }))).toBe('hard');
  });

  it('crashes on body contact even with perfect metrics', () => {
    expect(gradeLanding(stats({ bodyContact: true }))).toBe('crash');
  });

  it('crashes on tip-over even with perfect metrics', () => {
    expect(gradeLanding(stats({ tippedOver: true }))).toBe('crash');
  });

  it('grades a worst-case bounce hit, not the final rest state', () => {
    // The caller recorded a 3.5 m/s re-hit during the grading window
    expect(gradeLanding(stats({ maxVerticalSpeed: 3.5 }))).toBe('hard');
  });
});

describe('scoreLanding', () => {
  describe('crash', () => {
    it('zeroes every component, the total, and the stars', () => {
      const score = scoreLanding(
        stats({ bodyContact: true, fuelFraction: 1, onPad: true }),
        mission({ padMultiplier: 3 })
      );
      expect(score.grade).toBe('crash');
      expect(score.touchdownPoints).toBe(0);
      expect(score.softness).toBe(0);
      expect(score.precision).toBe(0);
      expect(score.fuelBonus).toBe(0);
      expect(score.base).toBe(0);
      expect(score.instrumentsBonus).toBe(0);
      expect(score.total).toBe(0);
      expect(score.stars).toBe(0);
    });
  });

  describe('touchdown points', () => {
    it('awards 500 for good and perfect, 200 for hard', () => {
      expect(scoreLanding(stats(), mission()).touchdownPoints).toBe(500);
      expect(
        scoreLanding(stats({ maxVerticalSpeed: 2 }), mission()).touchdownPoints
      ).toBe(500); // good
      expect(
        scoreLanding(stats({ maxVerticalSpeed: 4 }), mission()).touchdownPoints
      ).toBe(200); // hard
    });
  });

  describe('softness', () => {
    it('is 0 at the good v-speed limit', () => {
      expect(
        scoreLanding(stats({ maxVerticalSpeed: T.goodVSpeed }), mission())
          .softness
      ).toBe(0);
    });

    it('is max at the best v-speed and clamps below it', () => {
      expect(
        scoreLanding(
          stats({ maxVerticalSpeed: S.softnessBestVSpeed }),
          mission()
        ).softness
      ).toBe(S.softnessMax);
      expect(
        scoreLanding(stats({ maxVerticalSpeed: 0.1 }), mission()).softness
      ).toBe(S.softnessMax);
    });

    it('interpolates linearly between the endpoints', () => {
      // 1.75 m/s is the midpoint of 0.5..3.0 → half of 300
      expect(
        scoreLanding(stats({ maxVerticalSpeed: 1.75 }), mission()).softness
      ).toBeCloseTo(S.softnessMax / 2, 10);
    });

    it('clamps to 0 for hard landings beyond the good limit', () => {
      expect(
        scoreLanding(stats({ maxVerticalSpeed: 5 }), mission()).softness
      ).toBe(0);
    });
  });

  describe('precision', () => {
    it('on-pad: max at the pad center, 0 at the pad edge', () => {
      const m = mission({ padRadius: 10 });
      expect(
        scoreLanding(stats({ distanceToPadCenter: 0 }), m).precision
      ).toBe(S.precisionMaxOnPad);
      expect(
        scoreLanding(stats({ distanceToPadCenter: 10 }), m).precision
      ).toBe(0);
      expect(
        scoreLanding(stats({ distanceToPadCenter: 5 }), m).precision
      ).toBeCloseTo(S.precisionMaxOnPad / 2, 10);
    });

    it('on-pad: clamps to 0 beyond the pad radius', () => {
      expect(
        scoreLanding(
          stats({ distanceToPadCenter: 15 }),
          mission({ padRadius: 10 })
        ).precision
      ).toBe(0);
    });

    it('off-pad: scales site quality by the off-pad cap', () => {
      const off = { onPad: false, distanceToPadCenter: 100 };
      expect(
        scoreLanding(stats({ ...off, siteQuality: 1 }), mission()).precision
      ).toBe(S.precisionMaxOffPad);
      expect(
        scoreLanding(stats({ ...off, siteQuality: 0.5 }), mission()).precision
      ).toBe(S.precisionMaxOffPad / 2);
      expect(
        scoreLanding(stats({ ...off, siteQuality: 0 }), mission()).precision
      ).toBe(0);
    });

    it('off-pad: clamps site quality to 0..1', () => {
      const off = { onPad: false, distanceToPadCenter: 100 };
      expect(
        scoreLanding(stats({ ...off, siteQuality: 1.5 }), mission()).precision
      ).toBe(S.precisionMaxOffPad);
      expect(
        scoreLanding(stats({ ...off, siteQuality: -0.5 }), mission()).precision
      ).toBe(0);
    });
  });

  describe('fuel bonus', () => {
    it('is proportional to remaining fuel and clamps to 0..1', () => {
      expect(scoreLanding(stats({ fuelFraction: 1 }), mission()).fuelBonus).toBe(
        S.fuelBonusMax
      );
      expect(
        scoreLanding(stats({ fuelFraction: 0.5 }), mission()).fuelBonus
      ).toBe(S.fuelBonusMax / 2);
      expect(scoreLanding(stats({ fuelFraction: 0 }), mission()).fuelBonus).toBe(
        0
      );
      expect(
        scoreLanding(stats({ fuelFraction: 1.2 }), mission()).fuelBonus
      ).toBe(S.fuelBonusMax);
      expect(
        scoreLanding(stats({ fuelFraction: -0.1 }), mission()).fuelBonus
      ).toBe(0);
    });
  });

  describe('order of operations', () => {
    it('total = round(base × padMult × assistMult) + instrumentsBonus', () => {
      // Perfect on-pad landing: base = 500 + 300 + 300 + 150 = 1250
      const score = scoreLanding(
        stats({ usedHoverHold: true }),
        mission({ padMultiplier: 3 })
      );
      expect(score.base).toBe(1250);
      expect(score.padMultiplier).toBe(3);
      expect(score.assistMultiplier).toBe(S.hoverHoldMultiplier);
      expect(score.instrumentsBonus).toBe(S.instrumentsBonus);
      expect(score.total).toBe(Math.round(1250 * 3 * 0.8) + 100); // 3100
    });

    it('adds the instruments bonus after the multipliers, unscaled', () => {
      const score = scoreLanding(
        stats({ usedHoverHold: true }),
        mission({ padMultiplier: 3 })
      );
      expect(
        score.total -
          Math.round(score.base * score.padMultiplier * score.assistMultiplier)
      ).toBe(S.instrumentsBonus);
    });

    it('does not apply the pad multiplier off-pad', () => {
      const score = scoreLanding(
        stats({ onPad: false, distanceToPadCenter: 50 }),
        mission({ padMultiplier: 3 })
      );
      expect(score.padMultiplier).toBe(1);
    });

    it('applies the assist multiplier only when hover-hold was used', () => {
      expect(scoreLanding(stats(), mission()).assistMultiplier).toBe(1);
      expect(
        scoreLanding(stats({ usedHoverHold: true }), mission()).assistMultiplier
      ).toBe(S.hoverHoldMultiplier);
    });

    it('withholds the instruments bonus when the belly cam was used', () => {
      const score = scoreLanding(stats({ usedBellyCam: true }), mission());
      expect(score.instrumentsBonus).toBe(0);
    });

    it('withholds the instruments bonus on a hard landing', () => {
      const score = scoreLanding(stats({ maxVerticalSpeed: 4 }), mission());
      expect(score.grade).toBe('hard');
      expect(score.instrumentsBonus).toBe(0);
    });

    it('grants the instruments bonus for good and perfect landings', () => {
      expect(scoreLanding(stats(), mission()).instrumentsBonus).toBe(
        S.instrumentsBonus
      );
      const good = scoreLanding(stats({ maxVerticalSpeed: 2 }), mission());
      expect(good.grade).toBe('good');
      expect(good.instrumentsBonus).toBe(S.instrumentsBonus);
    });
  });

  describe('stars', () => {
    // Star thresholds apply to base alone: ≥600 ★, ≥900 ★★, ≥1150 ★★★

    it('awards 0 stars below the one-star threshold', () => {
      // base = 500 + 0 + 0 + 75 = 575
      const score = scoreLanding(
        stats({
          maxVerticalSpeed: T.goodVSpeed,
          onPad: false,
          siteQuality: 0,
          fuelFraction: 0.25,
        }),
        mission()
      );
      expect(score.base).toBe(575);
      expect(score.stars).toBe(0);
    });

    it('awards 1 star exactly at the threshold (inclusive)', () => {
      // base = 500 + 0 + 100 + 0 = 600
      const score = scoreLanding(
        stats({
          maxVerticalSpeed: T.goodVSpeed,
          onPad: false,
          siteQuality: 0.5,
          fuelFraction: 0,
        }),
        mission()
      );
      expect(score.base).toBe(600);
      expect(score.stars).toBe(1);
    });

    it('awards 2 stars exactly at the threshold (inclusive)', () => {
      // base = 500 + 150 + 100 + 150 = 900
      const score = scoreLanding(
        stats({
          maxVerticalSpeed: 1.75,
          onPad: false,
          siteQuality: 0.5,
          fuelFraction: 0.5,
        }),
        mission()
      );
      expect(score.base).toBe(900);
      expect(score.stars).toBe(2);
    });

    it('awards 1 star just below the two-star threshold', () => {
      // base = 500 + 150 + 100 + ~149.7 < 900
      const score = scoreLanding(
        stats({
          maxVerticalSpeed: 1.75,
          onPad: false,
          siteQuality: 0.5,
          fuelFraction: 0.499,
        }),
        mission()
      );
      expect(score.base).toBeLessThan(900);
      expect(score.stars).toBe(1);
    });

    it('awards 3 stars exactly at the threshold (inclusive)', () => {
      // base = 500 + 300 + 200 + 150 = 1150
      const score = scoreLanding(
        stats({ onPad: false, siteQuality: 1, fuelFraction: 0.5 }),
        mission()
      );
      expect(score.base).toBe(1150);
      expect(score.stars).toBe(3);
    });

    it('awards 2 stars just below the three-star threshold', () => {
      const score = scoreLanding(
        stats({ onPad: false, siteQuality: 1, fuelFraction: 0.4995 }),
        mission()
      );
      expect(score.base).toBeLessThan(1150);
      expect(score.stars).toBe(2);
    });

    it('is unaffected by the assist multiplier', () => {
      // base ≈ 620 (≥600) but total after ×0.8 lands below 600 — still 1 star
      const score = scoreLanding(
        stats({
          maxVerticalSpeed: T.goodVSpeed,
          onPad: false,
          siteQuality: 0.6,
          fuelFraction: 0,
          usedHoverHold: true,
          usedBellyCam: true,
        }),
        mission()
      );
      expect(score.base).toBeGreaterThanOrEqual(600);
      expect(score.total).toBeLessThan(600);
      expect(score.stars).toBe(1);
    });

    it('is unaffected by the pad multiplier and instruments bonus', () => {
      // base = 575 (<600) but total is inflated ×3 + 100 — still 0 stars
      const score = scoreLanding(
        stats({
          maxVerticalSpeed: 2.999,
          distanceToPadCenter: 10,
          fuelFraction: 0.25,
        }),
        mission({ padMultiplier: 3 })
      );
      expect(score.base).toBeLessThan(600);
      expect(score.total).toBeGreaterThan(1500);
      expect(score.stars).toBe(0);
    });
  });
});
