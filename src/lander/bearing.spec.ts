import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bearingRelativeToHeading, normalizeAngle, worldBearing } from './bearing';

function forwardAfterYaw(heading: number): THREE.Vector3 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, heading, 0, 'YXZ'));
  return new THREE.Vector3(0, 0, -1).applyQuaternion(q);
}

describe('bearing', () => {
  it('normalizes into (-π, π]', () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(0.5)).toBeCloseTo(0.5);
  });

  it('world bearing: 0 along -Z, +π/2 along +X', () => {
    expect(worldBearing(0, -1)).toBeCloseTo(0);
    expect(worldBearing(1, 0)).toBeCloseTo(Math.PI / 2);
  });

  it('velocity along the nose reads as straight ahead for every heading', () => {
    for (const h of [0, 0.7, -1.3, 2.5, -3, Math.PI]) {
      const fwd = forwardAfterYaw(h);
      expect(bearingRelativeToHeading(fwd.x, fwd.z, h)).toBeCloseTo(0, 6);
    }
  });

  it('a target to the right of the nose reads +π/2', () => {
    for (const h of [0, 1.1, -2.2]) {
      const fwd = forwardAfterYaw(h);
      // Right = forward rotated -90° about +Y (clockwise from above)
      const right = fwd.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      expect(bearingRelativeToHeading(right.x, right.z, h)).toBeCloseTo(Math.PI / 2, 6);
    }
  });
});
