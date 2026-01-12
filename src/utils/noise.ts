import { createNoise2D } from 'simplex-noise';

/**
 * Noise utilities for procedural generation
 * Provides multi-octave fractal noise functions
 */

let noise2D: ((x: number, y: number) => number) | null = null;

/**
 * Initialize noise with seed
 */
export function initializeNoise(seed: number): void {
  noise2D = createNoise2D(() => seed);
}

/**
 * Get 2D noise value
 */
export function getNoise2D(x: number, y: number): number {
  if (!noise2D) {
    initializeNoise(12345); // Default seed
  }
  return noise2D!(x, y);
}

/**
 * Multi-octave fractal noise
 */
export function fractalNoise(
  x: number,
  z: number,
  octaves: number,
  persistence: number,
  lacunarity: number,
  scale: number
): number {
  let total = 0;
  let frequency = 1;
  let amplitude = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    total += getNoise2D(x * frequency / scale, z * frequency / scale) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }

  return total / maxValue;
}
