import { MathUtils } from "three";


export function mapRangeClamped(val: number, a1: number, a2: number, b1: number, b2: number) {
  return MathUtils.clamp(MathUtils.mapLinear(val, a1, a2, b1, b2), b1, b2);
}

export function mapRangeSmooth(val: number, a1: number, a2: number, b1: number, b2: number) {
  return MathUtils.mapLinear(MathUtils.smoothstep(val, a1, a2), 0, 1, b1, b2);

}

export function closeTo(a: number, b: number, epsilon: number = 0.01) {
    return Math.abs(a - b) < epsilon;
}

/**
 * Smooth approximation of Math.abs() that is differentiable everywhere.
 * Uses sqrt(x*x + epsilon) to avoid the sharp corner at x=0.
 * 
 * @param x - Input value
 * @param epsilon - Smoothness parameter (smaller = sharper, default: 0.01)
 * @returns Smooth absolute value approximation
 */
export function smoothAbs(x: number, epsilon: number = 0.01): number {
    return Math.sqrt(x * x + epsilon);
}

/**
 * Smooth approximation of pingpong() that creates a smooth triangle wave.
 * Uses a sine-based function to avoid sharp peaks/valleys.
 * 
 * @param x - Input value
 * @param length - Maximum value (default: 1)
 * @returns Smooth pingpong value in range [0, length]
 */
export function smoothPingpong(x: number, length: number = 1): number {
    // Normalize x to [0, 2*length] range
    const period = length * 2;
    const normalized = ((x % period) + period) % period;
    
    // Create smooth triangle wave using sine
    // This approximates a triangle wave but with smooth transitions
    return length * (1 - Math.cos(Math.PI * normalized / length)) / 2;
}
