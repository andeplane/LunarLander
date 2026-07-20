/**
 * Pure statistics helpers for the benchmark harness.
 *
 * Kept free of DOM/three.js dependencies so the math can be unit tested.
 */

export interface BenchmarkStats {
  mean: number;
  min: number;
  max: number;
  median: number;
}

/**
 * Calculate statistics from an array of times.
 *
 * Returns all-zero stats for an empty input instead of NaN/undefined,
 * so an aborted or zero-iteration run still renders sane numbers.
 */
export function calculateStats(times: number[]): BenchmarkStats {
  if (times.length === 0) {
    return { mean: 0, min: 0, max: 0, median: 0 };
  }

  const sorted = [...times].sort((a, b) => a - b);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  return { mean, min, max, median };
}

/**
 * Normalize a user-provided iteration count.
 *
 * - Non-finite values (NaN from an empty input, Infinity) fall back to `fallback`.
 * - Fractional values are floored.
 * - Values below 1 (including negatives, which slip through `value || fallback`
 *   guards) are clamped to 1 so benchmark loops always run at least once.
 */
export function sanitizeIterations(value: number, fallback = 3): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}
