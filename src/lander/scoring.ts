/**
 * Pure landing grading + scoring functions (ADR-0004 §2/§3).
 *
 * Grading operates on worst-case touchdown metrics. Accumulating those
 * worst-case values over the grading window (first leg contact → 1 s of
 * stability) is the CALLER's job: `TouchdownStats.maxVerticalSpeed`,
 * `maxDriftSpeed`, and `maxTiltDeg` must already be the maxima over every
 * leg-contact instant in the window, so a bounce that re-hits at 3.5 m/s
 * grades as that 3.5 m/s hit. These functions never see individual contacts.
 *
 * All thresholds and point values come from LANDER_CONFIG — never hardcoded.
 */

import { LANDER_CONFIG } from './config';
import type {
  LandingGrade,
  MissionParams,
  ScoreBreakdown,
  TouchdownStats,
} from './types';

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * Grade a landing from worst-case touchdown metrics (ADR-0004 §2).
 *
 * Thresholds are inclusive: exactly at a limit earns the better grade.
 *
 * - Crash: body contact, tip-over, or an impact metric (v↓, drift, tilt)
 *   beyond hardFactor × Good limits. Terrain slope can NEVER cause a crash:
 *   the physics already simulates tipping — a craft that came to rest
 *   upright on its legs survived by definition, and grading it "crashed"
 *   because the sampled ground is steep would contradict what the player
 *   just watched. Steep ground instead caps the grade at Hard.
 * - Hard: within hardFactor × Good limits but beyond at least one Good
 *   limit (slope included).
 * - Good: within all Good limits (v↓, drift, tilt, slope).
 * - Perfect: within Perfect limits (v↓, drift, tilt) AND Good's slope limit
 *   (there is no separate perfect-slope threshold).
 */
export function gradeLanding(stats: TouchdownStats): LandingGrade {
  const t = LANDER_CONFIG.touchdown;

  if (stats.bodyContact || stats.tippedOver) return 'crash';

  const impactsWithinGoodTimes = (factor: number): boolean =>
    stats.maxVerticalSpeed <= t.goodVSpeed * factor &&
    stats.maxDriftSpeed <= t.goodDrift * factor &&
    stats.maxTiltDeg <= t.goodTiltDeg * factor;

  if (!impactsWithinGoodTimes(t.hardFactor)) return 'crash';
  if (!impactsWithinGoodTimes(1) || stats.slopeDeg > t.goodSlopeDeg) return 'hard';

  if (
    stats.maxVerticalSpeed <= t.perfectVSpeed &&
    stats.maxDriftSpeed <= t.perfectDrift &&
    stats.maxTiltDeg <= t.perfectTiltDeg
    // slope ≤ goodSlopeDeg already guaranteed by withinGoodTimes(1)
  ) {
    return 'perfect';
  }
  return 'good';
}

/**
 * Score a landing (ADR-0004 §3). One formula, fixed order of operations:
 *
 *   base  = touchdownPoints + softness + precision + fuelBonus   // max 1400
 *   total = round(base × padMultiplier × assistMultiplier) + instrumentsBonus
 *   stars = f(base)  — multipliers and the instruments bonus never affect
 *                      stars; assist users can still earn ★★★.
 *
 * A crash zeroes every component, the total, and the stars.
 */
export function scoreLanding(
  stats: TouchdownStats,
  mission: MissionParams
): ScoreBreakdown {
  const s = LANDER_CONFIG.scoring;
  const t = LANDER_CONFIG.touchdown;
  const grade = gradeLanding(stats);

  if (grade === 'crash') {
    return {
      grade,
      touchdownPoints: 0,
      softness: 0,
      precision: 0,
      fuelBonus: 0,
      base: 0,
      padMultiplier: 1,
      assistMultiplier: 1,
      instrumentsBonus: 0,
      total: 0,
      stars: 0,
    };
  }

  const touchdownPoints =
    grade === 'hard' ? s.touchdownHard : s.touchdownGood;

  // Softness: linear from goodVSpeed (0 pts) down to softnessBestVSpeed
  // (max pts), clamped at both ends.
  const softness =
    clamp01(
      (t.goodVSpeed - stats.maxVerticalSpeed) /
        (t.goodVSpeed - s.softnessBestVSpeed)
    ) * s.softnessMax;

  // Precision: on-pad by distance from center (center → max, edge → 0);
  // off-pad by site quality (0 rough .. 1 flat), capped lower.
  const precision = stats.onPad
    ? clamp01(1 - stats.distanceToPadCenter / mission.padRadius) *
      s.precisionMaxOnPad
    : clamp01(stats.siteQuality) * s.precisionMaxOffPad;

  const fuelBonus = clamp01(stats.fuelFraction) * s.fuelBonusMax;

  const base = touchdownPoints + softness + precision + fuelBonus;

  // The pad multiplier only applies when the lander rests on the pad.
  const padMultiplier = stats.onPad ? mission.padMultiplier : 1;
  const assistMultiplier = stats.usedHoverHold ? s.hoverHoldMultiplier : 1;
  // Instruments-only bonus requires a clean (good or better) landing.
  const instrumentsBonus =
    !stats.usedBellyCam && (grade === 'good' || grade === 'perfect')
      ? s.instrumentsBonus
      : 0;

  const total =
    Math.round(base * padMultiplier * assistMultiplier) + instrumentsBonus;

  const [oneStar, twoStars, threeStars] = s.starThresholds;
  const stars =
    base >= threeStars ? 3 : base >= twoStars ? 2 : base >= oneStar ? 1 : 0;

  return {
    grade,
    touchdownPoints,
    softness,
    precision,
    fuelBonus,
    base,
    padMultiplier,
    assistMultiplier,
    instrumentsBonus,
    total,
    stars,
  };
}
