import { describe, it, expect } from 'vitest';
import { Sphere, Vector3 } from 'three';
import {
  applyCurvatureDropToSphere,
  curvatureDrop,
  curvatureDropRange,
  maxLoadedChunkDistance,
} from './curvatureBounds';

describe('curvatureBounds', () => {
  describe('curvatureDrop', () => {
    it('matches the shader formula d^2 / (2R)', () => {
      expect(curvatureDrop(0, 5000)).toBe(0);
      expect(curvatureDrop(1000, 5000)).toBeCloseTo(100);
      expect(curvatureDrop(4283, 5000)).toBeCloseTo((4283 * 4283) / 10000);
    });
  });

  describe('curvatureDropRange', () => {
    it('clamps the near distance at zero when the camera is inside the sphere', () => {
      const range = curvatureDropRange(50, 200, 5000);
      expect(range.dropMin).toBe(0);
      expect(range.dropMax).toBeCloseTo(curvatureDrop(250, 5000));
    });

    it('bounds the drop of every point within the sphere', () => {
      const planetRadius = 5000;
      const centerDistance = 1200;
      const radius = 283;
      const range = curvatureDropRange(centerDistance, radius, planetRadius);

      // Sample horizontal distances of points inside the sphere
      for (const offset of [-radius, -radius / 2, 0, radius / 2, radius]) {
        const drop = curvatureDrop(centerDistance + offset, planetRadius);
        expect(drop).toBeGreaterThanOrEqual(range.dropMin - 1e-9);
        expect(drop).toBeLessThanOrEqual(range.dropMax + 1e-9);
      }
    });

    it('is near-zero for chunks close to the camera (culling stays tight)', () => {
      // A 400 m chunk right under the camera: drop range must stay in meters,
      // not the ~1.9 km global inflation that disabled culling
      const range = curvatureDropRange(0, 283, 5000);
      expect(range.dropMax).toBeLessThan(10);
    });
  });

  describe('maxLoadedChunkDistance', () => {
    it('is the pruning-radius center distance plus half the chunk diagonal', () => {
      const expected = 10 * 400 + Math.sqrt(400 * 400 + 400 * 400) / 2;
      expect(maxLoadedChunkDistance(10, 400, 400)).toBeCloseTo(expected);
    });

    it('uses the larger dimension for non-square chunks', () => {
      const expected = 5 * 300 + Math.sqrt(100 * 100 + 300 * 300) / 2;
      expect(maxLoadedChunkDistance(5, 100, 300)).toBeCloseTo(expected);
    });

    it('is tighter than the old global grid-diagonal bound', () => {
      const renderDistance = 10;
      const width = 400;
      const depth = 400;
      const oldGlobalBound = Math.sqrt(
        ((renderDistance + 1) * width) ** 2 + ((renderDistance + 1) * depth) ** 2
      );
      expect(maxLoadedChunkDistance(renderDistance, width, depth)).toBeLessThan(oldGlobalBound);
    });
  });

  describe('applyCurvatureDropToSphere', () => {
    it('contains every base-sphere point dropped by any amount in the range', () => {
      const baseCenter = new Vector3(10, 5, -20);
      const baseRadius = 30;
      const range = { dropMin: 12, dropMax: 48 };

      const sphere = new Sphere();
      applyCurvatureDropToSphere(sphere, baseCenter, baseRadius, range);

      expect(sphere.center.x).toBe(baseCenter.x);
      expect(sphere.center.z).toBe(baseCenter.z);
      expect(sphere.center.y).toBeCloseTo(baseCenter.y - (12 + 48) / 2);
      expect(sphere.radius).toBeCloseTo(baseRadius + (48 - 12) / 2);

      // Property check: sample points on the base sphere surface, apply drops
      const point = new Vector3();
      for (const [dx, dy, dz] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0.577, 0.577, 0.577],
      ] as const) {
        for (const drop of [range.dropMin, (range.dropMin + range.dropMax) / 2, range.dropMax]) {
          point
            .set(dx, dy, dz)
            .multiplyScalar(baseRadius)
            .add(baseCenter);
          point.y -= drop;
          expect(sphere.containsPoint(point)).toBe(true);
        }
      }
    });

    it('reduces to the base sphere when the drop range is empty', () => {
      const baseCenter = new Vector3(1, 2, 3);
      const sphere = new Sphere();
      applyCurvatureDropToSphere(sphere, baseCenter, 5, { dropMin: 0, dropMax: 0 });
      expect(sphere.center.equals(baseCenter)).toBe(true);
      expect(sphere.radius).toBe(5);
    });
  });
});
