/**
 * Deterministic mission generation and the difficulty ramp (ADR-0004 §1/§4).
 *
 * Every parameter is a continuous, asymptotic function of the mission index:
 * difficulty approaches (but never reaches) a hard ceiling, so no mission is
 * ever impossible. A small seeded jitter (alea, same PRNG family as terrain)
 * makes consecutive missions feel distinct while the same index always
 * produces identical parameters — retry re-seeds identically.
 *
 * The three score-economy parameters (padRadius, padMultiplier,
 * fuelMarginFactor) carry NO jitter so their difficulty progression is
 * strictly monotonic over the mission index.
 */

import alea from 'alea';
import { LANDER_CONFIG } from './config';
import type { MissionParams } from './types';

interface Ramp {
  /** Value at mission index 0 */
  start: number;
  /** Asymptotic limit as index → ∞ (never reached) */
  end: number;
  /** e-folding constant: index at which ~63% of the ramp is applied */
  k: number;
}

/** end + (start − end)·e^(−index/k): start at index 0, asymptote to end. */
function ramp(index: number, r: Ramp): number {
  return r.end + (r.start - r.end) * Math.exp(-index / r.k);
}

/** Difficulty ramp endpoints (ADR-0004 §4). */
const RAMPS = {
  /** Spawn moves farther out */
  spawnDistance: { start: 500, end: 800, k: 10 },
  /** …and higher up */
  spawnAltitudeAGL: { start: 300, end: 400, k: 12 },
  /** Initial velocities grow modestly */
  spawnHorizontalSpeed: { start: 12, end: 20, k: 12 },
  spawnDescentRate: { start: 15, end: 18, k: 12 },
  /** Initial velocity stops pointing straight at the pad (max |error|, rad) */
  spawnBearingError: { start: 0, end: 0.4, k: 10 },
  /** Pad diameter 20 m → 10 m, i.e. radius 10 m → 5 m */
  padRadius: { start: 10, end: 5, k: 10 },
  /** Smaller pads pay more (shown on the beacon, Atari-style) */
  padMultiplier: { start: 1, end: 3, k: 10 },
  /** Fuel capacity margin over the perfect-descent cost */
  fuelMarginFactor: { start: 2.2, end: 1.4, k: 8 },
} as const satisfies Record<string, Ramp>;

/** ± jitter fraction applied to the spawn-state parameters. */
const JITTER = {
  spawnDistance: 0.08,
  spawnAltitudeAGL: 0.06,
  spawnHorizontalSpeed: 0.1,
  spawnDescentRate: 0.1,
} as const;

/**
 * Deterministic per-mission parameters. Same index → same params, always
 * (the PRNG is seeded from the index alone; draw order is fixed).
 */
export function missionParamsForIndex(index: number): MissionParams {
  const rng = alea('lander-mission', index);
  const seed = rng.uint32();
  /** Multiplicative jitter in [1 − frac, 1 + frac] */
  const jitter = (frac: number) => 1 + frac * (2 * rng() - 1);

  const spawnDistance =
    ramp(index, RAMPS.spawnDistance) * jitter(JITTER.spawnDistance);
  const spawnAltitudeAGL =
    ramp(index, RAMPS.spawnAltitudeAGL) * jitter(JITTER.spawnAltitudeAGL);
  const spawnHorizontalSpeed =
    ramp(index, RAMPS.spawnHorizontalSpeed) *
    jitter(JITTER.spawnHorizontalSpeed);
  const spawnDescentRate =
    ramp(index, RAMPS.spawnDescentRate) * jitter(JITTER.spawnDescentRate);

  // Bearing error: magnitude between 50% and 100% of the ramped maximum,
  // random sign. Exactly 0 at index 0 (the ramp starts at 0).
  const bearingMax = ramp(index, RAMPS.spawnBearingError);
  // `+ 0` normalizes the -0 produced by a negative sign at index 0
  const spawnBearingError =
    bearingMax * (0.5 + 0.5 * rng()) * (rng() < 0.5 ? -1 : 1) + 0;

  return {
    index,
    seed,
    spawnDistance,
    spawnAltitudeAGL,
    spawnHorizontalSpeed,
    spawnDescentRate,
    spawnBearingError,
    padRadius: ramp(index, RAMPS.padRadius),
    padMultiplier: ramp(index, RAMPS.padMultiplier),
    fuelMarginFactor: ramp(index, RAMPS.fuelMarginFactor),
  };
}

/** Reference constant-rate descent speed for the fuel model (m/s). */
const NOMINAL_DESCENT_RATE = 4;
/** Δv budget for the final flare: arrest the nominal descent to a soft
 * touch (~1 m/s) with a little maneuvering slack. */
const FLARE_DELTA_V = 3;

/**
 * Fuel capacity (kg) = perfect-descent cost × mission margin factor,
 * clamped to the tank size (ADR-0004 §4 owns capacity; ADR-0002's
 * "≈120 s of hover" is only the mission-1 ballpark).
 *
 * Perfect-descent cost model (analytic, deliberately simple — the margin
 * factor absorbs its error):
 *
 * Near hover, thrust ≈ m·g, so fuel flow per unit of delivered Δv is
 * constant: hover throttle = m·g / maxThrust, hover burn = throttle ×
 * maxBurnRate, and holding altitude for t seconds "spends" Δv = g·t.
 * Hence  fuelPerΔv = hoverBurn / g = m · maxBurnRate / maxThrust  (kg per
 * m/s). The reference mass is dryMass: a perfect descent ends near dry, so
 * this modestly under-estimates flow early in the descent — absorbed by the
 * margin factor.
 *
 * Δv budget for the reference profile:
 *  1. brake the spawn descent rate down to the nominal ~4 m/s descent,
 *  2. gravity losses while descending spawnAltitudeAGL at that nominal
 *     rate (thrust ≈ weight the whole way): g × (altitude / rate),
 *  3. kill the initial horizontal speed (tilt-to-translate; the vertical
 *     projection loss at ≤25° tilt is small and absorbed by the margin),
 *  4. a fixed final-flare allowance.
 */
export function fuelCapacityForMission(mission: MissionParams): number {
  const c = LANDER_CONFIG;

  const fuelPerDeltaV = (c.dryMass * c.maxBurnRate) / c.maxThrust; // kg per m/s

  const brakeDescent = Math.max(
    0,
    mission.spawnDescentRate - NOMINAL_DESCENT_RATE
  );
  const gravityLoss =
    c.gravity * (mission.spawnAltitudeAGL / NOMINAL_DESCENT_RATE);
  const brakeHorizontal = mission.spawnHorizontalSpeed;

  const deltaV = brakeDescent + gravityLoss + brakeHorizontal + FLARE_DELTA_V;
  const perfectDescentCost = deltaV * fuelPerDeltaV;

  return Math.min(perfectDescentCost * mission.fuelMarginFactor, c.fuelMass);
}
