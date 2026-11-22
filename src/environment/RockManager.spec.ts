import {
  BoxGeometry,
  type BufferGeometry,
  type InstancedMesh,
  Matrix4,
  Object3D,
  Vector3,
} from 'three';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SHADOW_CASTER_LAYER } from '../core/layers';
import type { RockPlacement } from '../terrain/ChunkWorker';
import { RockBuilder } from './RockBuilder';
import { type AsyncPrototypeBuilder, type NearDetailOptions, RockManager } from './RockManager';
import {
  ladderIndexOfDetail,
  ROCK_DETAIL_LADDER,
  ROCK_TIERS,
  rockTriangleBudget,
} from './rockPrototypes';

const LAST_TIER = ROCK_TIERS.length - 1;
const LOD_LEVELS = [1024, 512, 256, 128, 64, 32, 16, 8, 4];

function identityPlacement(prototypeId = 0, tier = LAST_TIER): RockPlacement {
  return {
    prototypeId,
    tier,
    matrices: new Float32Array(new Matrix4().identity().toArray()),
    colors: new Float32Array([1, 1, 1]),
  };
}

/** A prototype builder that records its calls and returns cheap boxes. */
interface FakeBuilder {
  build: (shapeId: number, detail: number) => BufferGeometry;
  calls: { shapeId: number; detail: number }[];
  geometries: BufferGeometry[];
}

function createFakeBuilder(): FakeBuilder {
  const calls: { shapeId: number; detail: number }[] = [];
  const geometries: BufferGeometry[] = [];
  return {
    calls,
    geometries,
    build: (shapeId, detail) => {
      calls.push({ shapeId, detail });
      const geometry = new BoxGeometry(1, 1, 1);
      geometries.push(geometry);
      return geometry;
    },
  };
}

function managerWith(builder: FakeBuilder, librarySize = 2): RockManager {
  return new RockManager(librarySize, 400, 400, LOD_LEVELS, 10, 5000, {
    buildPrototype: builder.build,
  });
}

describe(RockManager.name, () => {
  // One manager with real prototypes for the tests that need real meshes
  let manager: RockManager;

  beforeAll(() => {
    // librarySize 1 keeps prototype generation fast
    manager = new RockManager(1, 400, 400, LOD_LEVELS, 10, 5000);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('prototypes', () => {
    it('does not build any prototype in the constructor', () => {
      const builder = createFakeBuilder();
      const fresh = managerWith(builder);
      try {
        expect(builder.calls).toHaveLength(0);
        expect(fresh.getBuiltPrototypeCount()).toBe(0);
        expect(fresh.isPrototypeReady(0, 0)).toBe(false);
        expect(fresh.getPrototypeCount()).toBe(2 * ROCK_TIERS.length);
        expect(fresh.getTierCount()).toBe(ROCK_TIERS.length);
        expect(fresh.getLibrarySize()).toBe(2);
      } finally {
        fresh.dispose();
      }
    });

    it('builds a requested prototype on the spot, at the detail of its tier, and caches it', () => {
      const builder = createFakeBuilder();
      const fresh = managerWith(builder);
      try {
        const first = fresh.getPrototype(1, 2);
        expect(builder.calls).toEqual([{ shapeId: 1, detail: ROCK_TIERS[2].detail }]);
        expect(fresh.isPrototypeReady(1, 2)).toBe(true);
        expect(fresh.isPrototypeReady(1, 1)).toBe(false);
        expect(fresh.isPrototypeReady(0, 2)).toBe(false);

        expect(fresh.getPrototype(1, 2)).toBe(first);
        expect(builder.calls).toHaveLength(1);
      } finally {
        fresh.dispose();
      }
    });

    it('wraps shape ids around the library and clamps tiers', () => {
      const builder = createFakeBuilder();
      const fresh = managerWith(builder, 3);
      try {
        expect(fresh.getPrototype(4, 0)).toBe(fresh.getPrototype(1, 0));
        expect(fresh.getPrototype(-1, 0)).toBe(fresh.getPrototype(2, 0));
        expect(fresh.getPrototype(0, 99)).toBe(fresh.getPrototype(0, LAST_TIER));
        expect(fresh.getPrototype(0, -5)).toBe(fresh.getPrototype(0, 0));
        // The finest tier is the default
        expect(fresh.getPrototype(0)).toBe(fresh.getPrototype(0, 0));
      } finally {
        fresh.dispose();
      }
    });

    it('builds with RockBuilder by default', () => {
      const actual = manager.getPrototype(0, LAST_TIER);
      const expected = RockBuilder.generate(0, { detail: ROCK_TIERS[LAST_TIER].detail });
      expect(actual?.getAttribute('position').array).toEqual(
        expected.getAttribute('position').array
      );
    });

    it('has nothing to offer with an empty library', () => {
      const builder = createFakeBuilder();
      const fresh = managerWith(builder, 0);
      try {
        expect(fresh.getPrototype(0, 0)).toBeUndefined();
        expect(fresh.createRockMeshes([identityPlacement()])).toEqual([]);
        expect(builder.calls).toHaveLength(0);
      } finally {
        fresh.dispose();
      }
    });

    it('reports the triangle budget of a detail', () => {
      expect(RockManager.getTriangleCount(15)).toBe(rockTriangleBudget(15));
      expect(RockManager.getTriangleCount(1)).toBe(80);
    });
  });

  describe('background warmup', () => {
    it('builds every prototype without being asked, common cheap ones first', async () => {
      const builder = createFakeBuilder();
      const librarySize = 12;
      const fresh = managerWith(builder, librarySize);
      try {
        await vi.waitFor(
          () => {
            expect(fresh.getBuiltPrototypeCount()).toBe(fresh.getPrototypeCount());
          },
          { timeout: 5000 }
        );
        expect(builder.calls).toHaveLength(librarySize * ROCK_TIERS.length);

        // No prototype is built twice
        const keys = new Set(builder.calls.map((call) => `${call.shapeId}@${call.detail}`));
        expect(keys.size).toBe(builder.calls.length);

        // First the shapes every chunk uses, from the cheapest tier up
        const common = ROCK_TIERS.reduce(
          (sum, tier) => sum + Math.min(librarySize, tier.maxShapes),
          0
        );
        expect(builder.calls[0]).toEqual({ shapeId: 0, detail: ROCK_TIERS[LAST_TIER].detail });
        let cursor = 0;
        for (let tier = LAST_TIER; tier >= 0; tier--) {
          for (
            let shapeId = 0;
            shapeId < Math.min(librarySize, ROCK_TIERS[tier].maxShapes);
            shapeId++
          ) {
            expect(builder.calls[cursor++]).toEqual({ shapeId, detail: ROCK_TIERS[tier].detail });
          }
        }
        expect(cursor).toBe(common);
        // Then the rest of the library, again cheapest first
        for (const call of builder.calls.slice(common)) {
          const tier = ROCK_TIERS.findIndex((entry) => entry.detail === call.detail);
          expect(call.shapeId).toBeGreaterThanOrEqual(ROCK_TIERS[tier].maxShapes);
        }
        const restDetails = builder.calls.slice(common).map((call) => call.detail);
        expect(restDetails).toEqual([...restDetails].sort((a, b) => a - b));
      } finally {
        fresh.dispose();
      }
    });

    it('skips prototypes that were already built on demand', async () => {
      const builder = createFakeBuilder();
      const fresh = managerWith(builder, 1);
      try {
        fresh.getPrototype(0, 0);
        await vi.waitFor(() => {
          expect(fresh.getBuiltPrototypeCount()).toBe(ROCK_TIERS.length);
        });
        expect(builder.calls).toHaveLength(ROCK_TIERS.length);
      } finally {
        fresh.dispose();
      }
    });

    it('yields when the time budget of a slice is spent and continues in the next one', async () => {
      const builder = createFakeBuilder();
      let now = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      const slow: FakeBuilder['build'] = (shapeId, detail) => {
        now += 100; // every prototype overruns the slice budget
        return builder.build(shapeId, detail);
      };
      const fresh = new RockManager(1, 400, 400, LOD_LEVELS, 10, 5000, { buildPrototype: slow });
      try {
        await vi.waitFor(() => {
          expect(fresh.getBuiltPrototypeCount()).toBeGreaterThanOrEqual(1);
        });
        // One prototype per slice: the first slice did not run the whole queue
        expect(now).toBeGreaterThanOrEqual(100);
        await vi.waitFor(() => {
          expect(fresh.getBuiltPrototypeCount()).toBe(ROCK_TIERS.length);
        });
        expect(now).toBe(100 * ROCK_TIERS.length);
      } finally {
        fresh.dispose();
        clock.mockRestore();
      }
    });

    it('stops after dispose and releases the prototypes it owns', async () => {
      const builder = createFakeBuilder();
      const fresh = managerWith(builder);
      const geometry = fresh.getPrototype(0, LAST_TIER);
      const disposed = vi.fn();
      geometry?.addEventListener('dispose', disposed);
      fresh.dispose();

      // Give any (cancelled) warmup timer a chance to fire
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(builder.calls).toHaveLength(1);
      expect(disposed).toHaveBeenCalledTimes(1);
      expect(fresh.getBuiltPrototypeCount()).toBe(0);
      expect(fresh.getPrototype(0, 0)).toBeUndefined();
      expect(fresh.createRockMeshes([identityPlacement()])).toEqual([]);
      // A second dispose is harmless
      expect(() => fresh.dispose()).not.toThrow();
    });

    describe('with requestIdleCallback', () => {
      /** Typed stand-in for the browser idle scheduler. */
      class FakeIdleScheduler {
        private nextHandle = 1;
        readonly pending = new Map<number, IdleRequestCallback>();
        readonly cancelled: number[] = [];

        request = (callback: IdleRequestCallback): number => {
          const handle = this.nextHandle++;
          this.pending.set(handle, callback);
          return handle;
        };

        cancel = (handle: number): void => {
          this.cancelled.push(handle);
          this.pending.delete(handle);
        };

        /** Run the pending callback with the given idle times (ms), one per timeRemaining() call. */
        runNext(remaining: number[]): void {
          const [handle, callback] = [...this.pending.entries()][0];
          this.pending.delete(handle);
          const times = [...remaining];
          const deadline: IdleDeadline = {
            didTimeout: false,
            timeRemaining: () => times.shift() ?? 0,
          };
          callback(deadline);
        }
      }

      function install(): FakeIdleScheduler {
        const scheduler = new FakeIdleScheduler();
        vi.stubGlobal('requestIdleCallback', scheduler.request);
        vi.stubGlobal('cancelIdleCallback', scheduler.cancel);
        return scheduler;
      }

      it('builds while idle time remains and reschedules when it runs out', () => {
        const scheduler = install();
        const builder = createFakeBuilder();
        const fresh = managerWith(builder, 1);
        try {
          expect(scheduler.pending.size).toBe(1);
          expect(builder.calls).toHaveLength(0);

          // Idle time for three prototypes, then the deadline is reached
          scheduler.runNext([5, 5, 0.5]);
          expect(builder.calls).toHaveLength(3);
          expect(scheduler.pending.size).toBe(1);

          scheduler.runNext([5, 5, 5, 5]);
          expect(builder.calls).toHaveLength(ROCK_TIERS.length);
          // Everything is built: nothing left to schedule
          expect(scheduler.pending.size).toBe(0);
        } finally {
          fresh.dispose();
        }
      });

      it('cancels the pending idle callback on dispose', () => {
        const scheduler = install();
        const builder = createFakeBuilder();
        const fresh = managerWith(builder, 1);
        fresh.dispose();
        expect(scheduler.cancelled).toHaveLength(1);
        expect(scheduler.pending.size).toBe(0);
        expect(builder.calls).toHaveLength(0);
      });

      it('ignores an idle callback that fires after dispose', () => {
        const scheduler = new FakeIdleScheduler();
        vi.stubGlobal('requestIdleCallback', scheduler.request);
        // A scheduler whose cancel does nothing: the callback still fires
        vi.stubGlobal('cancelIdleCallback', (_handle: number): void => {});
        const builder = createFakeBuilder();
        const fresh = managerWith(builder, 1);
        fresh.dispose();
        scheduler.runNext([5, 5]);
        expect(builder.calls).toHaveLength(0);
      });
    });
  });

  describe('createRockMeshes', () => {
    it('creates one instanced mesh per group from the prototype of its shape and tier', () => {
      const builder = createFakeBuilder();
      const fresh = managerWith(builder, 3);
      try {
        const matrices = new Float32Array(32);
        matrices.set(new Matrix4().makeTranslation(1, 2, 3).toArray(), 0);
        matrices.set(new Matrix4().makeTranslation(4, 5, 6).toArray(), 16);
        const meshes = fresh.createRockMeshes([
          { prototypeId: 2, tier: 1, matrices, colors: new Float32Array([1, 1, 1, 0.9, 0.9, 0.9]) },
          identityPlacement(0, 4),
        ]);
        expect(meshes).toHaveLength(2);
        expect(meshes[0].count).toBe(2);
        expect(meshes[0].geometry).toBe(fresh.getPrototype(2, 1));
        expect(meshes[1].geometry).toBe(fresh.getPrototype(0, 4));
        expect(meshes[0].material).toBe(fresh.getMaterial());
        expect(Array.from(meshes[0].instanceMatrix.array)).toEqual(Array.from(matrices));
        expect(meshes[0].frustumCulled).toBe(true);

        const second = new Matrix4();
        meshes[0].getMatrixAt(1, second);
        expect(new Vector3().setFromMatrixPosition(second).toArray()).toEqual([4, 5, 6]);
        for (const mesh of meshes) {
          mesh.dispose();
        }
      } finally {
        fresh.dispose();
      }
    });

    it('enables the shadow-caster layer on every mesh without leaving the default layer', () => {
      const meshes = manager.createRockMeshes([identityPlacement(0, 4), identityPlacement(0, 3)]);
      expect(meshes).toHaveLength(2);
      for (const mesh of meshes) {
        expect(mesh.layers.isEnabled(SHADOW_CASTER_LAYER)).toBe(true);
        expect(mesh.layers.isEnabled(0)).toBe(true);
        expect(mesh.castShadow).toBe(false);
        expect(mesh.receiveShadow).toBe(false);
        mesh.dispose();
      }
    });

    it('carries the per-instance tint as instanceColor', () => {
      const matrices = new Float32Array(32);
      matrices.set(new Matrix4().identity().toArray(), 0);
      matrices.set(new Matrix4().identity().toArray(), 16);
      const colors = new Float32Array([0.9, 0.88, 0.86, 1.1, 1.08, 1.05]);
      const [mesh] = manager.createRockMeshes([
        { prototypeId: 0, tier: LAST_TIER, matrices, colors },
      ]);
      expect(mesh.instanceColor).not.toBeNull();
      expect(mesh.instanceColor?.itemSize).toBe(3);
      expect(mesh.instanceColor?.count).toBe(2);
      expect(Array.from(mesh.instanceColor?.array ?? [])).toEqual(Array.from(colors));
      mesh.dispose();
    });

    it('renders a group without colors untinted', () => {
      const [mesh] = manager.createRockMeshes([
        {
          prototypeId: 0,
          tier: LAST_TIER,
          matrices: new Float32Array(new Matrix4().toArray()),
          colors: new Float32Array(0),
        },
      ]);
      expect(Array.from(mesh.instanceColor?.array ?? [])).toEqual([1, 1, 1]);
      mesh.dispose();
    });

    it('skips empty groups', () => {
      const meshes = manager.createRockMeshes([
        {
          prototypeId: 0,
          tier: LAST_TIER,
          matrices: new Float32Array(0),
          colors: new Float32Array(0),
        },
      ]);
      expect(meshes).toEqual([]);
    });
  });

  describe('createRockMeshes culling bounds', () => {
    it('expands the initial bounding sphere for curvature using the per-chunk lifetime bound', () => {
      const [mesh] = manager.createRockMeshes([identityPlacement()]);
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
      const [mesh] = manager.createRockMeshes([identityPlacement()]);
      expect(manager.getTrackedMeshCount()).toBe(before + 1);

      mesh.dispose();
      expect(manager.getTrackedMeshCount()).toBe(before);
    });
  });

  describe('updateCullingBounds', () => {
    it('tightens the sphere to near the base radius when the camera is close', () => {
      const [mesh] = manager.createRockMeshes([identityPlacement()]);
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
      const [mesh] = manager.createRockMeshes([identityPlacement()]);
      mesh.updateMatrixWorld(true);

      manager.updateCullingBounds(new Vector3(2000, 100, 0));

      // drop at 2000 m with R=5000 is 400 m: center shifts down ~400 m,
      // radius only grows by half the drop span across the small base sphere
      expect(mesh.boundingSphere?.center.y ?? 0).toBeLessThan(-300);
      expect(mesh.boundingSphere?.radius ?? Infinity).toBeLessThan(50);

      mesh.dispose();
    });

    it('restores the base sphere when curvature is disabled', () => {
      const [mesh] = manager.createRockMeshes([identityPlacement()]);
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

/** Rock placement group of one shape and tier from (x, z, diameter) triples, chunk-local. */
function rocksAt(shapeId: number, tier: number, rocks: [number, number, number][]): RockPlacement {
  const matrices = new Float32Array(rocks.length * 16);
  const colors = new Float32Array(rocks.length * 3);
  rocks.forEach(([x, z, diameter], i) => {
    matrices.set(
      new Matrix4().makeScale(diameter, diameter, diameter).setPosition(x, 0, z).toArray(),
      i * 16
    );
    colors.set([1, 0.9 + i * 0.01, 0.8], i * 3);
  });
  return { prototypeId: shapeId, tier, matrices, colors };
}

/** Async builder whose builds are resolved (or failed) by the test. */
class ControlledAsyncBuilder {
  readonly requests: { shapeId: number; detail: number }[] = [];
  readonly built: BufferGeometry[] = [];
  private resolvers: {
    resolve: (geometry: BufferGeometry) => void;
    reject: (error: Error) => void;
  }[] = [];

  build: AsyncPrototypeBuilder = (shapeId, detail) => {
    this.requests.push({ shapeId, detail });
    return new Promise((resolve, reject) => {
      this.resolvers.push({ resolve, reject });
    });
  };

  /** Resolve every pending build and let the manager see the results. */
  async resolveAll(): Promise<void> {
    for (const { resolve } of this.resolvers.splice(0)) {
      const geometry = new BoxGeometry(1, 1, 1);
      this.built.push(geometry);
      resolve(geometry);
    }
    await flush();
  }

  async rejectAll(): Promise<void> {
    for (const { reject } of this.resolvers.splice(0)) {
      reject(new Error('no luck'));
    }
    await flush();
  }

  get pending(): number {
    return this.resolvers.length;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const FOV = (70 * Math.PI) / 180;
const SCREEN = 1080;
/** World x of the test chunk. */
const CHUNK_X = 400;
/** Size tier (ROCK_TIERS index) of a 2 m rock: detail 3. */
const TWO_METER_TIER = 2;

interface NearSetup {
  manager: RockManager;
  builder: FakeBuilder;
  async: ControlledAsyncBuilder;
  chunk: Object3D;
  meshes: InstancedMesh[];
}

function nearSetup(
  placements: RockPlacement[],
  nearDetail: Partial<NearDetailOptions> = {},
  librarySize = 4
): NearSetup {
  const builder = createFakeBuilder();
  const async = new ControlledAsyncBuilder();
  const manager = new RockManager(librarySize, 400, 400, LOD_LEVELS, 10, 5000, {
    buildPrototype: builder.build,
    buildPrototypeAsync: async.build,
    nearDetail,
  });
  const chunk = new Object3D();
  chunk.position.set(CHUNK_X, 0, 0);
  const meshes = manager.createRockMeshes(placements);
  for (const mesh of meshes) {
    chunk.add(mesh);
  }
  return { manager, builder, async, chunk, meshes };
}

/** The visible near meshes and their instance counts. */
function nearMeshes(manager: RockManager): InstancedMesh[] {
  return manager
    .getNearDetailRoot()
    .children.filter(
      (child): child is InstancedMesh => 'isInstancedMesh' in child && child.visible
    );
}

/** World position of instance i of an instanced mesh. */
function instanceWorld(mesh: InstancedMesh, i: number): Vector3 {
  const matrix = new Matrix4();
  mesh.getMatrixAt(i, matrix);
  mesh.updateWorldMatrix(true, false);
  return new Vector3().setFromMatrixPosition(matrix.premultiply(mesh.matrixWorld));
}

/** Camera on the x axis, `distance` meters from a rock at the chunk origin. */
function cameraAt(distance: number): Vector3 {
  return new Vector3(CHUNK_X + distance, 0, 0);
}

describe(`${RockManager.name} near-camera detail`, () => {
  it('redraws a close rock from a finer mesh once that prototype is built', async () => {
    const { manager, async, meshes } = nearSetup([rocksAt(1, TWO_METER_TIER, [[0, 0, 2]])]);
    try {
      expect(manager.updateNearDetail(cameraAt(3), FOV, SCREEN)).toBe(true);
      // Not built yet: requested off the main thread, the chunk mesh keeps it
      expect(async.requests).toHaveLength(1);
      const wanted = async.requests[0];
      expect(wanted.shapeId).toBe(1);
      expect(wanted.detail).toBeGreaterThanOrEqual(23);
      expect(meshes[0].count).toBe(1);
      expect(nearMeshes(manager)).toHaveLength(0);

      await async.resolveAll();
      expect(manager.isDetailReady(1, wanted.detail)).toBe(true);
      expect(manager.updateNearDetail(cameraAt(3), FOV, SCREEN)).toBe(true);
      expect(meshes[0].count).toBe(0);
      const [near] = nearMeshes(manager);
      expect(near.count).toBe(1);
      expect(near.geometry).toBe(async.built[0]);
      expect(near.layers.isEnabled(SHADOW_CASTER_LAYER)).toBe(true);
      expect(near.material).toBe(manager.getMaterial());
      // Same place, scale and tint as in the chunk mesh
      expect(instanceWorld(near, 0).distanceTo(new Vector3(CHUNK_X, 0, 0))).toBeLessThan(1e-4);
      expect(Array.from(near.instanceColor?.array.slice(0, 3) ?? [])).toEqual(
        Array.from(new Float32Array([1, 0.9, 0.8]))
      );
      const stats = manager.getNearDetailStats();
      expect(stats.refinedRocks).toBe(1);
      expect(stats.meshes).toBe(1);
      expect(stats.triangles).toBe(rockTriangleBudget(wanted.detail));
      expect(stats.baseTriangles).toBe(rockTriangleBudget(ROCK_TIERS[TWO_METER_TIER].detail));

      // Nothing to do while the camera stays put
      expect(manager.updateNearDetail(cameraAt(3.2), FOV, SCREEN)).toBe(false);
    } finally {
      manager.dispose();
    }
  });

  it('re-buckets when the view changes even if the camera does not move', async () => {
    const { manager, async } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])]);
    try {
      manager.updateNearDetail(cameraAt(10), FOV, SCREEN);
      await async.resolveAll();
      manager.updateNearDetail(cameraAt(10), FOV, SCREEN);
      expect(manager.updateNearDetail(cameraAt(10), FOV, SCREEN)).toBe(false);
      expect(manager.updateNearDetail(cameraAt(10), FOV / 2, SCREEN)).toBe(true);
      expect(manager.updateNearDetail(cameraAt(10), FOV / 2, SCREEN * 2)).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it('keeps a rock at its detail inside the hysteresis band and drops it outside', async () => {
    const { manager, async, meshes } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])], {
      pixelsPerSegment: 10,
      hysteresis: 0.15,
    });
    // 1080 px, 70°: 771 px per radian; detail 5 (6 segments) needs 60 px
    // plus 15 %: a 2 m rock gets it from 22 m, keeps it out to 29 m
    const detailFive = ladderIndexOfDetail(5);
    try {
      manager.updateNearDetail(cameraAt(21), FOV, SCREEN);
      expect(async.requests.map((request) => request.detail)).toEqual([5]);
      await async.resolveAll();
      manager.updateNearDetail(cameraAt(21), FOV, SCREEN);
      expect(meshes[0].count).toBe(0);

      // 28 m: 55 px is below 60 but within the margin
      manager.updateNearDetail(cameraAt(28), FOV, SCREEN);
      expect(meshes[0].count).toBe(0);
      expect(nearMeshes(manager)[0].count).toBe(1);
      expect(ROCK_DETAIL_LADDER[detailFive]).toBe(5);

      // 31 m: back into the chunk mesh, tint and matrix restored
      manager.updateNearDetail(cameraAt(31), FOV, SCREEN);
      expect(meshes[0].count).toBe(1);
      expect(nearMeshes(manager)).toHaveLength(0);
      expect(Array.from(meshes[0].instanceMatrix.array.slice(0, 16))).toEqual(
        Array.from(rocksAt(0, TWO_METER_TIER, [[0, 0, 2]]).matrices)
      );
    } finally {
      manager.dispose();
    }
  });

  it('only moves the refined rocks out of a chunk mesh and keeps the others in order', async () => {
    const { manager, async, meshes } = nearSetup([
      rocksAt(2, TWO_METER_TIER, [
        [100, 0, 2],
        [0, 0, 2],
        [-100, 0, 2],
      ]),
    ]);
    try {
      manager.updateNearDetail(cameraAt(4), FOV, SCREEN);
      await async.resolveAll();
      manager.updateNearDetail(cameraAt(4), FOV, SCREEN);
      expect(meshes[0].count).toBe(2);
      expect(instanceWorld(meshes[0], 0).x).toBeCloseTo(CHUNK_X + 100, 4);
      expect(instanceWorld(meshes[0], 1).x).toBeCloseTo(CHUNK_X - 100, 4);
      expect(Array.from(meshes[0].instanceColor?.array.slice(0, 6) ?? [])).toEqual(
        Array.from(new Float32Array([1, 0.9, 0.8, 1, 0.92, 0.8]))
      );
    } finally {
      manager.dispose();
    }
  });

  it('draws the finest detail already built while the wanted one is being built', async () => {
    const { manager, async } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])]);
    try {
      manager.updateNearDetail(cameraAt(21), FOV, SCREEN);
      await async.resolveAll();
      manager.updateNearDetail(cameraAt(21), FOV, SCREEN);
      const coarse = async.built[0];
      expect(nearMeshes(manager)[0].geometry).toBe(coarse);

      // Close up: detail 31 is wanted and requested. Until it arrives the
      // finest prototype already built stands in: detail 15, which the
      // background warmup built for the chunk tiers of big boulders
      manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
      expect(async.pending).toBe(1);
      expect(async.requests[1].detail).toBe(31);
      const [near] = nearMeshes(manager);
      expect(near.geometry).toBe(manager.getPrototype(0, 0));
      expect(near.count).toBe(1);
    } finally {
      manager.dispose();
    }
  });

  it('grows a near mesh when many rocks share its shape and detail', async () => {
    const rocks: [number, number, number][] = [];
    for (let i = 0; i < 40; i++) {
      rocks.push([(i % 8) * 0.5 - 2, Math.floor(i / 8) * 0.5 - 1, 0.4]);
    }
    const { manager, async, meshes } = nearSetup([rocksAt(3, ROCK_TIERS.length - 1, rocks)]);
    try {
      const camera = new Vector3(CHUNK_X, 1.5, 0);
      manager.updateNearDetail(camera, FOV, SCREEN);
      await async.resolveAll();
      manager.updateNearDetail(camera, FOV, SCREEN);
      await async.resolveAll();
      manager.updateNearDetail(camera, FOV, SCREEN);
      const refined = nearMeshes(manager).reduce((sum, mesh) => sum + mesh.count, 0);
      expect(refined).toBeGreaterThan(16);
      expect(refined + meshes[0].count).toBe(40);
    } finally {
      manager.dispose();
    }
  });

  it('puts rocks back when their chunk mesh is hidden or disposed', async () => {
    const { manager, async, meshes } = nearSetup([
      rocksAt(0, TWO_METER_TIER, [[0, 0, 2]]),
      rocksAt(1, TWO_METER_TIER, [[1, 3, 2]]),
    ]);
    try {
      manager.updateNearDetail(cameraAt(5), FOV, SCREEN);
      await async.resolveAll();
      manager.updateNearDetail(cameraAt(5), FOV, SCREEN);
      expect(nearMeshes(manager)).toHaveLength(2);

      meshes[0].visible = false;
      expect(manager.updateNearDetail(cameraAt(5), FOV, SCREEN)).toBe(true);
      expect(meshes[0].count).toBe(1);
      expect(nearMeshes(manager)).toHaveLength(1);

      meshes[1].dispose();
      expect(manager.updateNearDetail(cameraAt(5), FOV, SCREEN)).toBe(true);
      expect(nearMeshes(manager)).toHaveLength(0);
    } finally {
      manager.dispose();
    }
  });

  it('ignores chunk meshes that are not in the scene', async () => {
    const { manager, async, chunk, meshes } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])]);
    try {
      chunk.remove(meshes[0]);
      manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
      expect(async.requests).toHaveLength(0);
    } finally {
      manager.dispose();
    }
  });

  it('raises the pixel target until the refined rocks fit the triangle budget', async () => {
    const { manager, async } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])], {
      maxExtraTriangles: 3000,
    });
    try {
      manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
      await async.resolveAll();
      manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
      const stats = manager.getNearDetailStats();
      expect(stats.pixelsPerSegment).toBeGreaterThan(10);
      expect(stats.refinedRocks).toBe(1);
      expect(stats.triangles - stats.baseTriangles).toBeLessThanOrEqual(3000);
    } finally {
      manager.dispose();
    }
  });

  it('keeps every rock at its chunk mesh when even the coarsest refinement is over budget', () => {
    const { manager, async, meshes } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])], {
      maxExtraTriangles: 1,
    });
    try {
      manager.updateNearDetail(cameraAt(1), FOV, SCREEN);
      expect(async.requests).toHaveLength(0);
      expect(meshes[0].count).toBe(1);
      expect(manager.getNearDetailStats().refinedRocks).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it('bounds the number of near meshes (draw calls)', async () => {
    const { manager, async } = nearSetup(
      [
        rocksAt(0, TWO_METER_TIER, [[0, 0, 2]]),
        rocksAt(1, TWO_METER_TIER, [[0, 4, 2]]),
        rocksAt(2, TWO_METER_TIER, [[0, -4, 2]]),
      ],
      { maxMeshes: 1, maxInFlight: 8 }
    );
    try {
      manager.updateNearDetail(cameraAt(6), FOV, SCREEN);
      await async.resolveAll();
      manager.updateNearDetail(cameraAt(6), FOV, SCREEN);
      expect(manager.getNearDetailStats().meshes).toBeLessThanOrEqual(1);
    } finally {
      manager.dispose();
    }
  });

  it('builds at most maxInFlight prototypes at once', () => {
    const { manager, async } = nearSetup(
      [
        rocksAt(0, TWO_METER_TIER, [[0, 0, 2]]),
        rocksAt(1, TWO_METER_TIER, [[0, 3, 2]]),
        rocksAt(2, TWO_METER_TIER, [[0, -3, 2]]),
      ],
      { maxInFlight: 2 }
    );
    try {
      manager.updateNearDetail(cameraAt(4), FOV, SCREEN);
      expect(manager.getPendingBuildCount()).toBe(2);
      manager.updateNearDetail(cameraAt(5), FOV, SCREEN);
      expect(async.requests).toHaveLength(2);
    } finally {
      manager.dispose();
    }
  });

  it('gives up on a prototype whose build fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { manager, async, meshes } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])]);
    try {
      manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
      await async.rejectAll();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(manager.updateNearDetail(cameraAt(3), FOV, SCREEN)).toBe(true);
      expect(manager.updateNearDetail(cameraAt(4), FOV, SCREEN)).toBe(true);
      // Never requested again; the rock keeps the finest mesh that exists
      expect(async.requests).toHaveLength(1);
      expect(meshes[0].count).toBe(0);
      expect(nearMeshes(manager)[0].geometry).toBe(manager.getPrototype(0, 0));
    } finally {
      manager.dispose();
      warn.mockRestore();
    }
  });

  it('evicts unused fine prototypes beyond the cache size', async () => {
    const { manager, async } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])], {
      cacheSize: 0,
    });
    try {
      manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
      await async.resolveAll();
      const detail = async.requests[0].detail;
      const geometry = async.built[0];
      const disposed = vi.fn();
      geometry.addEventListener('dispose', disposed);
      manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
      // In use: kept
      expect(manager.isDetailReady(0, detail)).toBe(true);

      manager.updateNearDetail(cameraAt(200), FOV, SCREEN);
      expect(manager.isDetailReady(0, detail)).toBe(false);
      expect(disposed).toHaveBeenCalledTimes(1);
      // Chunk-tier prototypes are never evicted
      expect(manager.isPrototypeReady(0, TWO_METER_TIER)).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it('disposes a prototype that arrives after the manager was disposed', async () => {
    const { manager, async } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])]);
    manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
    manager.dispose();
    const disposed = vi.fn();
    const pending = async.resolveAll();
    async.built[0]?.addEventListener('dispose', disposed);
    await pending;
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(manager.updateNearDetail(cameraAt(3), FOV, SCREEN)).toBe(false);
  });

  it('releases its near meshes on dispose', async () => {
    const { manager, async } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])]);
    manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
    await async.resolveAll();
    manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
    const [near] = nearMeshes(manager);
    const disposed = vi.fn();
    near.addEventListener('dispose', disposed);
    manager.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(manager.getNearDetailRoot().children).toHaveLength(0);
  });

  it('does nothing with an empty library', () => {
    const builder = createFakeBuilder();
    const empty = managerWith(builder, 0);
    try {
      expect(empty.updateNearDetail(cameraAt(1), FOV, SCREEN)).toBe(false);
    } finally {
      empty.dispose();
    }
  });

  it('falls back to buildPrototype on a timeout where workers do not exist', async () => {
    const builder = createFakeBuilder();
    const manager = managerWith(builder, 2);
    const chunk = new Object3D();
    chunk.position.set(CHUNK_X, 0, 0);
    for (const mesh of manager.createRockMeshes([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])])) {
      chunk.add(mesh);
    }
    try {
      manager.updateNearDetail(cameraAt(3), FOV, SCREEN);
      await vi.waitFor(() => {
        expect(builder.calls.some((call) => call.detail > ROCK_TIERS[0].detail)).toBe(true);
      });
    } finally {
      manager.dispose();
    }
  });

  it('moves the near-detail root with the camera, in whole meters', () => {
    const { manager } = nearSetup([rocksAt(0, TWO_METER_TIER, [[0, 0, 2]])]);
    try {
      manager.updateNearDetail(new Vector3(12.4, 3.6, -7.5), FOV, SCREEN);
      expect(manager.getNearDetailRoot().position.toArray()).toEqual([12, 4, -7]);
    } finally {
      manager.dispose();
    }
  });
});
