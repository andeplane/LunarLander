/**
 * Camera exposure that follows the lighting, like a photographer would set
 * it: stopped down under a high sun so the ground keeps its texture instead
 * of washing out, opened up for the long shadows of a low sun, and opened
 * further at night so earthshine and stars stay readable.
 */
export const NIGHT_EXPOSURE = 1.4;
export const LOW_SUN_EXPOSURE = 1.25;
export const HIGH_SUN_EXPOSURE = 0.8;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * @param sunElevationSin Sine of the sun's elevation above the local horizon
 *   (the y component of the unit vector towards the sun)
 * @param sunHorizonFade 0 when the sun is fully below the horizon, 1 when fully up
 */
export function exposureForSun(sunElevationSin: number, sunHorizonFade: number): number {
  const height = smoothstep(0.08, 0.75, sunElevationSin);
  const day = LOW_SUN_EXPOSURE + (HIGH_SUN_EXPOSURE - LOW_SUN_EXPOSURE) * height;
  const fade = Math.min(Math.max(sunHorizonFade, 0), 1);
  return NIGHT_EXPOSURE + (day - NIGHT_EXPOSURE) * fade;
}
