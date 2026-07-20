import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { RockManager } from './RockManager';
import { RockBuilder } from './RockBuilder';
import type { RockPlacement } from '../terrain/ChunkWorker';

function identityPlacement(prototypeId = 0): RockPlacement {
  return {
    prototypeId,
    matrices: new Float32Array(new Matrix4().identity().toArray()),
  };
}

describe(RockManager.name, () => {
  // Library generation is expensive - build one manager for all tests
  let manager: RockManager;

  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // librarySize 1 keeps prototype generation fast
    manager = new RockManager(1, 400, 400, [1024, 512, 256, 128, 64, 32, 16, 8, 4], 10, 5000);
  });

  describe('lazy prototype generation', () => {
    function freshManager(librarySize = 1): RockManager {
      return new RockManager(librarySize, 400, 400, [1024, 512, 256, 128, 64, 32, 16, 8, 4], 10, 5000);
    }

    it('does not build any prototype library in the constructor', () => {
      const fresh = freshManager();
      try {
        expect(fresh.isDetailLevelReady(15)).toBe(false);
        expect(fresh.isDetailLevelReady(10)).toBe(false);
        expect(fresh.isDetailLevelReady(7)).toBe(false);
      } finally {
        fresh.dispose();
      }
    });

    it('builds only the requested detail level synchronously on first use', () => {
      const fresh = freshManager(2);
      try {
        const axes = fresh.getStableAxesForDetail(15);
        expect(axes).toHaveLength(2);
        expect(fresh.isDetailLevelReady(15)).toBe(true);
        // Other levels stay lazy until they are needed (or warmed up)
        expect(fresh.isDetailLevelReady(10)).toBe(false);
        expect(fresh.isDetailLevelReady(7)).toBe(false);

        const prototypes = fresh.getPrototypesForDetail(15);
        expect(prototypes).toHaveLength(2);
      } finally {
        fresh.dispose();
      }
    });

    it('does not generate libraries for unknown detail levels', () => {
      const fresh = freshManager();
      try {
        expect(fresh.getPrototypesForDetail(3)).toBeUndefined();
        expect(fresh.getStableAxesForDetail(3)).toBeUndefined();
      } finally {
        fresh.dispose();
      }
    });

    it('produces the same prototypes and stable axes as direct bulk generation', () => {
      const fresh = freshManager(2);
      try {
        const expected = RockBuilder.generateLibrary(2, { detail: 10 });
        const actual = fresh.getPrototypesForDetail(10);
        expect(actual).toHaveLength(2);

        for (let i = 0; i < expected.length; i++) {
          const expectedPositions = expected[i].getAttribute('position').array;
          const actualPositions = actual?.[i].getAttribute('position').array;
          expect(actualPositions).toEqual(expectedPositions);

          const expectedAxis = RockBuilder.calculateStableAxis(expected[i]);
          const actualAxis = fresh.getStableAxesForDetail(10)?.[i];
          expect(actualAxis?.equals(expectedAxis)).toBe(true);
        }
      } finally {
        fresh.dispose();
      }
    });

    it('finishes all detail levels in the background without being asked', async () => {
      const fresh = freshManager();
      try {
        await vi.waitFor(
          () => {
            expect(fresh.isDetailLevelReady(15)).toBe(true);
            expect(fresh.isDetailLevelReady(10)).toBe(true);
            expect(fresh.isDetailLevelReady(7)).toBe(true);
          },
          { timeout: 5000 }
        );
      } finally {
        fresh.dispose();
      }
    });

    it('stops background generation after dispose', async () => {
      const fresh = freshManager();
      fresh.dispose();

      // Give any (cancelled) warmup timer a chance to fire
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fresh.isDetailLevelReady(15)).toBe(false);
      expect(fresh.isDetailLevelReady(10)).toBe(false);
      expect(fresh.isDetailLevelReady(7)).toBe(false);
      expect(fresh.getPrototypesForDetail(15)).toBeUndefined();
    });
  });

  describe('createRockMeshes culling bounds', () => {
    it('expands the initial bounding sphere for curvature using the per-chunk lifetime bound', () => {
      const [mesh] = manager.createRockMeshes([identityPlacement()], 0);
      expect(mesh).toBeDefined();
      expect(mesh.boundingSphere).not.toBeNull();

      // Initial conservative expansion: drop for max distance 4283 + r is
      // ~1835 m, so radius grows by ~918 m - but must stay below the old
      // global bound's ~1936 m growth
      const radius = mesh.boundingSphere?.radius ?? 0;
      expect(radius).toBeGreaterThan(100);
      expect(radius).toBeLessThan(1500);

      mesh.dispose();
    });

    it('tracks meshes and untracks them automatically on dispose', () => {
      const before = manager.getTrackedMeshCount();
      const [mesh] = manager.createRockMeshes([identityPlacement()], 0);
      expect(manager.getTrackedMeshCount()).toBe(before + 1);

      mesh.dispose();
      expect(manager.getTrackedMeshCount()).toBe(before);
    });
  });

  describe('updateCullingBounds', () => {
    it('tightens the sphere to near the base radius when the camera is close', () => {
      const [mesh] = manager.createRockMeshes([identityPlacement()], 0);
      mesh.updateMatrixWorld(true);

      const center = mesh.boundingSphere?.center;
      expect(center).toBeDefined();

      // Camera directly above the rocks: horizontal distance ~0, so the
      // curvature drop is tiny and the sphere should collapse back to
      // roughly its un-inflated size (rock prototypes are meter-scale)
      manager.updateCullingBounds(new Vector3(0, 100, 0));
      expect(mesh.boundingSphere?.radius ?? Infinity).toBeLessThan(10);

      mesh.dispose();
    });

    it('shifts and grows the sphere for a distant camera to cover the shader drop', () => {
      const [mesh] = manager.createRockMeshes([identityPlacement()], 0);
      mesh.updateMatrixWorld(true);

      manager.updateCullingBounds(new Vector3(2000, 100, 0));

      // drop at 2000 m with R=5000 is 400 m: center shifts down ~400 m,
      // radius only grows by half the drop span across the small base sphere
      expect(mesh.boundingSphere?.center.y ?? 0).toBeLessThan(-300);
      expect(mesh.boundingSphere?.radius ?? Infinity).toBeLessThan(50);

      mesh.dispose();
    });

    it('restores the base sphere when curvature is disabled', () => {
      const [mesh] = manager.createRockMeshes([identityPlacement()], 0);
      mesh.updateMatrixWorld(true);

      const material = manager.getMaterial();
      material.setParam('enableCurvature', false);
      try {
        // With curvature off the update restores the exact base sphere
        manager.updateCullingBounds(new Vector3(0, 100, 0));
        const baseCenter = mesh.boundingSphere?.center.clone();
        const baseRadius = mesh.boundingSphere?.radius ?? 0;
        expect(baseCenter).toBeDefined();

        // Re-enable and move far away: the sphere must shift well below base
        material.setParam('enableCurvature', true);
        manager.updateCullingBounds(new Vector3(2000, 100, 0));
        expect(mesh.boundingSphere?.center.y ?? 0).toBeLessThan((baseCenter?.y ?? 0) - 100);

        // Disable again: the base sphere comes back exactly
        material.setParam('enableCurvature', false);
        manager.updateCullingBounds(new Vector3(2000, 100, 0));
        expect(mesh.boundingSphere?.radius).toBe(baseRadius);
        expect(baseCenter && mesh.boundingSphere?.center.equals(baseCenter)).toBe(true);
      } finally {
        material.setParam('enableCurvature', true);
      }

      mesh.dispose();
    });
  });
});
