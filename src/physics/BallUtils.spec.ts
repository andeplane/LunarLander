import { describe, it, expect } from 'vitest';
import {
  isBallMoving,
  shouldDespawnBall,
  clampSpawnY,
  lerpVec3,
  slerpQuat,
  interpolateTransform,
  LINEAR_SPEED_THRESHOLD,
  ANGULAR_SPEED_THRESHOLD,
  type QuatLike,
  type TransformSnapshot,
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

const identity: QuatLike = { x: 0, y: 0, z: 0, w: 1 };

/** Quaternion for a rotation of `angle` radians about the Y axis. */
function yRotation(angle: number): QuatLike {
  return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
}

function quatLength(q: QuatLike): number {
  return Math.hypot(q.x, q.y, q.z, q.w);
}

describe('lerpVec3', () => {
  const a = { x: 1, y: 2, z: 3 };
  const b = { x: 5, y: -2, z: 7 };

  it('returns the endpoints at alpha 0 and 1', () => {
    expect(lerpVec3(a, b, 0)).toEqual(a);
    expect(lerpVec3(a, b, 1)).toEqual(b);
  });

  it('returns the midpoint at alpha 0.5', () => {
    expect(lerpVec3(a, b, 0.5)).toEqual({ x: 3, y: 0, z: 5 });
  });

  it('interpolates each component independently', () => {
    const result = lerpVec3(a, b, 0.25);
    expect(result.x).toBeCloseTo(2, 10);
    expect(result.y).toBeCloseTo(1, 10);
    expect(result.z).toBeCloseTo(4, 10);
  });
});

describe('slerpQuat', () => {
  it('returns the endpoints at alpha 0 and 1', () => {
    const b = yRotation(Math.PI / 2);
    const at0 = slerpQuat(identity, b, 0);
    const at1 = slerpQuat(identity, b, 1);
    expect(at0.y).toBeCloseTo(0, 10);
    expect(at0.w).toBeCloseTo(1, 10);
    expect(at1.y).toBeCloseTo(b.y, 10);
    expect(at1.w).toBeCloseTo(b.w, 10);
  });

  it('halves a 90 degree rotation at alpha 0.5', () => {
    const b = yRotation(Math.PI / 2);
    const mid = slerpQuat(identity, b, 0.5);
    const expected = yRotation(Math.PI / 4);
    expect(mid.x).toBeCloseTo(expected.x, 10);
    expect(mid.y).toBeCloseTo(expected.y, 10);
    expect(mid.z).toBeCloseTo(expected.z, 10);
    expect(mid.w).toBeCloseTo(expected.w, 10);
  });

  it('always returns a unit quaternion', () => {
    const b = yRotation(2.5);
    for (const alpha of [0, 0.25, 0.5, 0.75, 1]) {
      expect(quatLength(slerpQuat(identity, b, alpha))).toBeCloseTo(1, 10);
    }
  });

  it('takes the shortest path when endpoints are on opposite hemispheres', () => {
    // -b represents the same rotation as b; slerp must not swing the long
    // way around through a large arc
    const b = yRotation(Math.PI / 2);
    const negB: QuatLike = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    const mid = slerpQuat(identity, negB, 0.5);
    const expected = yRotation(Math.PI / 4);
    expect(Math.abs(mid.y)).toBeCloseTo(Math.abs(expected.y), 10);
    expect(Math.abs(mid.w)).toBeCloseTo(Math.abs(expected.w), 10);
  });

  it('falls back to normalized lerp for nearly identical rotations', () => {
    const b = yRotation(1e-5);
    const mid = slerpQuat(identity, b, 0.5);
    expect(quatLength(mid)).toBeCloseTo(1, 10);
    expect(mid.y).toBeCloseTo(b.y / 2, 8);
  });

  it('returns identity for degenerate zero-length input', () => {
    const zeroQuat: QuatLike = { x: 0, y: 0, z: 0, w: 0 };
    expect(slerpQuat(zeroQuat, zeroQuat, 0.5)).toEqual(identity);
  });
});

describe('interpolateTransform', () => {
  const prev: TransformSnapshot = {
    position: { x: 0, y: 10, z: 0 },
    rotation: identity,
  };
  const curr: TransformSnapshot = {
    position: { x: 2, y: 8, z: -4 },
    rotation: yRotation(Math.PI / 2),
  };

  it('returns the previous transform at alpha 0', () => {
    const t = interpolateTransform(prev, curr, 0);
    expect(t.position).toEqual(prev.position);
    expect(t.rotation.w).toBeCloseTo(1, 10);
  });

  it('returns the current transform at alpha 1', () => {
    const t = interpolateTransform(prev, curr, 1);
    expect(t.position).toEqual(curr.position);
    expect(t.rotation.y).toBeCloseTo(curr.rotation.y, 10);
    expect(t.rotation.w).toBeCloseTo(curr.rotation.w, 10);
  });

  it('blends position linearly and rotation spherically at alpha 0.5', () => {
    const t = interpolateTransform(prev, curr, 0.5);
    expect(t.position).toEqual({ x: 1, y: 9, z: -2 });
    const expected = yRotation(Math.PI / 4);
    expect(t.rotation.y).toBeCloseTo(expected.y, 10);
    expect(t.rotation.w).toBeCloseTo(expected.w, 10);
  });

  it('clamps alpha so it never extrapolates', () => {
    expect(interpolateTransform(prev, curr, -0.5).position).toEqual(prev.position);
    expect(interpolateTransform(prev, curr, 1.5).position).toEqual(curr.position);
  });

  it('does not mutate its inputs', () => {
    interpolateTransform(prev, curr, 0.5);
    expect(prev.position).toEqual({ x: 0, y: 10, z: 0 });
    expect(curr.position).toEqual({ x: 2, y: 8, z: -4 });
  });
});
