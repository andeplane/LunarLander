import { describe, it, expect } from 'vitest';
import {
  isBallMoving,
  shouldDespawnBall,
  clampSpawnY,
  LINEAR_SPEED_THRESHOLD,
  ANGULAR_SPEED_THRESHOLD,
} from './BallUtils';

const zero = { x: 0, y: 0, z: 0 };

describe('isBallMoving', () => {
  it('returns false when both linear and angular velocity are zero', () => {
    expect(isBallMoving(zero, zero)).toBe(false);
  });

  it('returns true when linear speed exceeds the threshold', () => {
    expect(isBallMoving({ x: 0, y: -0.5, z: 0 }, zero)).toBe(true);
  });

  it('returns true when only angular speed exceeds the threshold', () => {
    // A ball spinning in place must still be considered moving
    expect(isBallMoving(zero, { x: 0, y: 0, z: 1.0 })).toBe(true);
  });

  it('returns false when both speeds are below their thresholds', () => {
    const tinyLin = { x: LINEAR_SPEED_THRESHOLD / 2, y: 0, z: 0 };
    const tinyAng = { x: 0, y: ANGULAR_SPEED_THRESHOLD / 2, z: 0 };
    expect(isBallMoving(tinyLin, tinyAng)).toBe(false);
  });

  it('returns false at exactly the threshold (strictly greater required)', () => {
    expect(
      isBallMoving({ x: LINEAR_SPEED_THRESHOLD, y: 0, z: 0 }, zero)
    ).toBe(false);
    expect(
      isBallMoving(zero, { x: ANGULAR_SPEED_THRESHOLD, y: 0, z: 0 })
    ).toBe(false);
  });

  it('combines velocity components when measuring speed', () => {
    // Each component is below the threshold, but the magnitude is above it
    const v = 0.8 * LINEAR_SPEED_THRESHOLD;
    expect(isBallMoving({ x: v, y: v, z: v }, zero)).toBe(true);
  });

  it('respects custom thresholds', () => {
    const linvel = { x: 0.5, y: 0, z: 0 };
    expect(isBallMoving(linvel, zero, 1.0, 1.0)).toBe(false);
    expect(isBallMoving(linvel, zero, 0.1, 1.0)).toBe(true);
  });
});

describe('shouldDespawnBall', () => {
  it('despawns a ball below the kill altitude', () => {
    expect(shouldDespawnBall({ x: 0, y: -50.1, z: 0 }, -50)).toBe(true);
  });

  it('keeps a ball at or above the kill altitude', () => {
    expect(shouldDespawnBall({ x: 0, y: -50, z: 0 }, -50)).toBe(false);
    expect(shouldDespawnBall({ x: 0, y: 10, z: 0 }, -50)).toBe(false);
  });

  it('ignores horizontal position', () => {
    expect(shouldDespawnBall({ x: 1e6, y: 0, z: -1e6 }, -50)).toBe(false);
  });
});

describe('clampSpawnY', () => {
  it('raises a spawn point that is beneath the terrain surface', () => {
    // Camera looking down: spawn 2 m ahead can end up below the heightfield
    expect(clampSpawnY(1.0, 5.0, 0.3)).toBe(5.3);
  });

  it('keeps a spawn point that is already above the terrain', () => {
    expect(clampSpawnY(10.0, 5.0, 0.3)).toBe(10.0);
  });

  it('returns the desired height unchanged when terrain height is unknown', () => {
    expect(clampSpawnY(-3.0, null, 0.3)).toBe(-3.0);
  });

  it('handles negative terrain heights', () => {
    expect(clampSpawnY(-10.0, -2.0, 0.3)).toBe(-1.7);
  });
});
