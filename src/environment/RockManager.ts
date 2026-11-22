import {
  type BufferGeometry,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Vector3,
} from 'three';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';
import { SHADOW_CASTER_LAYER } from '../core/layers';
import { MoonMaterial } from '../shaders/MoonMaterial';
import {
  applyCurvatureDropToSphere,
  curvatureDrop,
  curvatureDropRange,
  maxLoadedChunkDistance,
} from '../terrain/curvatureBounds';
import type { RockPlacement } from '../terrain/rockPlacement';
import { RockBuilder } from './RockBuilder';
import {
  ladderIndexForPixels,
  ladderIndexOfDetail,
  ROCK_DETAIL_LADDER,
  ROCK_PIXELS_PER_SEGMENT,
  ROCK_TIERS,
  rockTriangleBudget,
} from './rockPrototypes';
import {
  createRockPrototypeWorkerClient,
  type RockPrototypeWorkerClient,
} from './rockPrototypeWorker';

/**
 * Base (un-inflated) bounding sphere of a tracked rock mesh, in mesh-local
 * space, used to recompute curvature-aware culling bounds each frame.
 */
interface TrackedBounds {
  center: Vector3;
  radius: number;
}

/** One prototype mesh still to be built by the background warmup. */
interface WarmupItem {
  tier: number;
  shapeId: number;
}

/** Builds a prototype without blocking the caller. */
export type AsyncPrototypeBuilder = (shapeId: number, detail: number) => Promise<BufferGeometry>;

/**
 * Dependencies that tests replace with typed fakes.
 */
export interface RockManagerDeps {
  /** Builds the prototype mesh of a shape at an icosphere detail (default: RockBuilder.generate). */
  buildPrototype?: (shapeId: number, detail: number) => BufferGeometry;
  /**
   * Builds the fine near-camera prototypes without blocking a frame
   * (default: a Web Worker; where workers do not exist, buildPrototype on a
   * zero timeout).
   */
  buildPrototypeAsync?: AsyncPrototypeBuilder;
  /** Near-camera detail tuning (see NEAR_DETAIL_DEFAULTS). */
  nearDetail?: Partial<NearDetailOptions>;
}

/** Tuning of the near-camera detail refinement. */
export interface NearDetailOptions {
  /** Target on-screen pixels per icosphere segment across a rock. */
  pixelsPerSegment: number;
  /** Relative projected-size margin before a rock changes detail. */
  hysteresis: number;
  /** Camera travel (meters) that triggers re-bucketing. */
  rebucketDistance: number;
  /** Most triangles the refined rocks may add over their chunk meshes. */
  maxExtraTriangles: number;
  /** Most refined (shape, detail) meshes, i.e. extra draw calls. */
  maxMeshes: number;
  /** Most fine prototypes being built at once. */
  maxInFlight: number;
  /** Fine prototypes kept for reuse beyond the ones in use. */
  cacheSize: number;
}

export const NEAR_DETAIL_DEFAULTS: NearDetailOptions = {
  pixelsPerSegment: ROCK_PIXELS_PER_SEGMENT,
  hysteresis: 0.15,
  rebucketDistance: 0.75,
  maxExtraTriangles: 600000,
  maxMeshes: 32,
  maxInFlight: 2,
  cacheSize: 48,
};

/**
 * A placement group of a chunk (one base InstancedMesh) and its per-rock
 * near-detail state.
 */
interface RockGroup {
  readonly mesh: InstancedMesh;
  readonly shapeId: number;
  /** Ladder index of the chunk mesh tier. */
  readonly baseIndex: number;
  readonly count: number;
  /** Source instance matrices and tints, in placement order. */
  readonly matrices: Float32Array;
  readonly colors: Float32Array;
  /** Largest rock diameter in the group (meters). */
  readonly maxDiameter: number;
  /** Base bounding sphere of the chunk mesh (null if it has none). */
  readonly bounds: TrackedBounds | null;
  /** Detail each rock should have (ladder index, with hysteresis), lazily allocated. */
  levels: Uint8Array | null;
  /** Detail each rock is drawn with (ladder index), lazily allocated. */
  drawn: Uint8Array | null;
  /** Rocks drawn by near meshes instead of the base mesh. */
  promoted: number;
  /** Whether a rock changed mesh since the chunk mesh was last compacted. */
  changed: boolean;
}

/** A pooled near-camera mesh: the refined rocks of one (shape, detail). */
interface NearMesh {
  mesh: InstancedMesh;
  readonly key: number;
  capacity: number;
  readonly bounds: TrackedBounds;
}

/** Numbers of the last near-detail re-bucketing, for diagnostics and tests. */
export interface NearDetailStats {
  /** Rocks drawn from a finer mesh than their chunk's. */
  refinedRocks: number;
  /** Near meshes drawn (extra draw calls). */
  meshes: number;
  /** Triangles of the refined rocks at the detail they should have (built or not). */
  triangles: number;
  /** Triangles the same rocks would have had at their chunk mesh tier. */
  baseTriangles: number;
  /** Pixels-per-segment target actually used (raised when over budget). */
  pixelsPerSegment: number;
}

// Scratch vector to avoid per-frame allocations in updateCullingBounds
const _worldCenter = new Vector3();

/** Time budget (ms) per warmup slice when requestIdleCallback is unavailable. */
const WARMUP_BUDGET_MS = 8;
/** Minimum idle time (ms) we require before doing another unit of warmup work. */
const IDLE_TIME_FLOOR_MS = 1;
/** Near meshes start with room for this many rocks and double when full. */
const NEAR_MESH_MIN_CAPACITY = 16;
/** Rounds the budget search may raise the pixels-per-segment target. */
const BUDGET_ROUNDS = 6;

const LADDER_TRIANGLES: readonly number[] = ROCK_DETAIL_LADDER.map(rockTriangleBudget);

/** Default AsyncPrototypeBuilder: a lazily started Web Worker. */
function createDefaultAsyncBuilder(
  buildPrototype: (shapeId: number, detail: number) => BufferGeometry
): { build: AsyncPrototypeBuilder; dispose: () => void } {
  if (typeof Worker === 'undefined') {
    return {
      build: (shapeId, detail) =>
        new Promise((resolve) => {
          setTimeout(() => resolve(buildPrototype(shapeId, detail)), 0);
        }),
      dispose: () => {},
    };
  }
  /* v8 ignore start -- needs a browser */
  let client: RockPrototypeWorkerClient | null = null;
  return {
    build: (shapeId, detail) => {
      client ??= createRockPrototypeWorkerClient(
        new Worker(new URL('./rockPrototypeWorker.ts', import.meta.url), { type: 'module' })
      );
      return client.build(shapeId, detail);
    },
    dispose: () => {
      client?.dispose();
      client = null;
    },
  };
  /* v8 ignore stop */
}

/**
 * RockManager owns the rock prototype meshes and turns worker-computed
 * placements into InstancedMeshes.
 *
 * Prototypes are identified by (shape id, icosphere detail), see
 * rockPrototypes.ts. The tier of an instance group is chosen by the
 * placement code from the rock's size and the chunk LOD: big boulders get
 * the fine tiers, the many small rocks a mesh of around a hundred
 * triangles, and every chunk LOD drops one tier.
 *
 * Chunk tiers are far too coarse for rocks right in front of the camera,
 * so updateNearDetail() refines those: every few decimeters of camera
 * travel it re-buckets the rocks near the camera by projected size, moves
 * the ones that deserve a finer mesh out of their chunk's InstancedMesh
 * (by compacting its instance buffer and lowering its count) and draws
 * them from pooled near meshes, one per (shape, detail), under a triangle
 * and draw-call budget, with hysteresis against flicker.
 *
 * Building all chunk-tier prototypes takes a while, so nothing is built in
 * the constructor. They are built one at a time during idle time
 * (requestIdleCallback with a setTimeout fallback), cheap and common ones
 * first, and any prototype requested before the warmup reached it is built
 * on the spot. The fine near-camera prototypes (up to ~46 000 triangles)
 * are built only when needed, off the main thread, and kept in a small
 * cache. Generation is seeded per shape, so the order of building never
 * changes the result.
 */
export class RockManager {
  // Prototype meshes keyed by ladder index * librarySize + shapeId
  private prototypes: Map<number, BufferGeometry> = new Map();
  // Keys of prototypes the chunk meshes use: never evicted
  private pinned: Set<number> = new Set();
  // Prototypes the background warmup has not reached yet, in build order
  private warmupQueue: WarmupItem[] = [];
  private warmupCursor = 0;
  // Pending idle-callback/timeout handle for the background warmup, if any
  private warmupHandle: number | ReturnType<typeof setTimeout> | null = null;
  private warmupUsesIdleCallback = false;
  private disposed = false;
  // Live rock meshes and their base bounding spheres, so per-frame culling
  // bounds can be tightened from the actual camera distance. Entries remove
  // themselves when a mesh is disposed (Chunk.clearRockMeshes / dispose).
  private trackedMeshes: Map<InstancedMesh, TrackedBounds> = new Map();
  private material: MoonMaterial;
  private librarySize: number;
  private chunkWidth: number;
  private chunkDepth: number;
  private renderDistance: number;
  private planetRadius: number;
  private buildPrototype: (shapeId: number, detail: number) => BufferGeometry;
  private buildPrototypeAsync: AsyncPrototypeBuilder;
  private disposeAsyncBuilder: () => void;

  // Near-camera detail state
  private readonly nearOptions: NearDetailOptions;
  private readonly nearRoot = new Group();
  private readonly groups: Map<InstancedMesh, RockGroup> = new Map();
  private readonly nearMeshes: Map<number, NearMesh> = new Map();
  private promotedGroups: RockGroup[] = [];
  private nextPromotedGroups: RockGroup[] = [];
  private nearDirty = true;
  private readonly lastRebucketCamera = new Vector3(Number.NaN, 0, 0);
  private lastPixelsPerRadian = 0;
  private readonly pendingBuilds: Set<number> = new Set();
  private readonly failedBuilds: Set<number> = new Set();
  private readonly lastUsed: Map<number, number> = new Map();
  private rebucketCount = 0;
  private readonly nearStats: NearDetailStats = {
    refinedRocks: 0,
    meshes: 0,
    triangles: 0,
    baseTriangles: 0,
    pixelsPerSegment: ROCK_PIXELS_PER_SEGMENT,
  };
  // Re-bucketing scratch (grown on demand, never shrunk)
  private candidateGroups: RockGroup[] = [];
  // Per candidate: index into candidateGroups, rock index, projected size, level
  private candidateGroup = new Int32Array(256);
  private candidateInstance = new Int32Array(256);
  private candidatePixels = new Float32Array(256);
  private candidateLevel = new Uint8Array(256);
  private candidateCount = 0;
  private keyStamp = new Uint32Array(0);
  private keyCount = new Int32Array(0);
  private stamp = 0;

  /**
   * Upper bound of the triangle count of a prototype at an icosphere detail.
   * Formula: 20 * (detail + 1)^2
   */
  static getTriangleCount(detail: number): number {
    return rockTriangleBudget(detail);
  }

  /**
   * Create a RockManager.
   *
   * @param librarySize - Number of distinct rock shapes (default: 30)
   * @param chunkWidth - Chunk width in meters (default: 100)
   * @param chunkDepth - Chunk depth in meters (default: 100)
   * @param _lodLevels - Terrain LOD resolution levels (unused: rock detail follows rock size and LOD index)
   * @param renderDistance - Maximum chunks to load in each direction (default: 20)
   * @param planetRadius - Planet radius for curvature calculations (default: 5000)
   * @param deps - Replaceable dependencies (tests)
   */
  constructor(
    librarySize: number = 30,
    chunkWidth: number = 100,
    chunkDepth: number = 100,
    _lodLevels: number[] = [1024, 512, 256, 128, 64, 32, 16, 8, 4],
    renderDistance: number = 20,
    planetRadius: number = DEFAULT_PLANET_RADIUS,
    deps: RockManagerDeps = {}
  ) {
    this.librarySize = Math.max(0, Math.floor(librarySize));
    this.chunkWidth = chunkWidth;
    this.chunkDepth = chunkDepth;
    this.renderDistance = renderDistance;
    this.planetRadius = planetRadius;
    this.buildPrototype =
      deps.buildPrototype ?? ((shapeId, detail) => RockBuilder.generate(shapeId, { detail }));
    if (deps.buildPrototypeAsync) {
      this.buildPrototypeAsync = deps.buildPrototypeAsync;
      this.disposeAsyncBuilder = () => {};
    } else {
      const fallback = createDefaultAsyncBuilder(this.buildPrototype);
      this.buildPrototypeAsync = fallback.build;
      this.disposeAsyncBuilder = fallback.dispose;
    }
    this.nearOptions = { ...NEAR_DETAIL_DEFAULTS, ...deps.nearDetail };

    // Near meshes carry their own world offset; the root follows the camera
    // in whole meters so instance matrices stay small and precise
    this.nearRoot.name = 'rock-near-detail';
    this.nearRoot.matrixAutoUpdate = false;

    // Create shared material for all rocks with curvature support
    // Use MoonMaterial so rocks match terrain appearance
    this.material = new MoonMaterial({ variant: 'rock' });
    this.material.setParam('enableColorVariation', true); // Match terrain
    this.material.setParam('enableCurvature', true);
    this.material.setParam('planetRadius', planetRadius);

    this.warmupQueue = RockManager.createWarmupQueue(this.librarySize);
    this.scheduleWarmup();
  }

  /**
   * Order in which the background warmup builds prototypes: first the shapes
   * every chunk uses (cheapest tier first, they are needed by the first
   * chunk on screen and cost next to nothing), then the rest of the library
   * from the cheapest tier to the finest.
   */
  private static createWarmupQueue(librarySize: number): WarmupItem[] {
    const queue: WarmupItem[] = [];
    for (let tier = ROCK_TIERS.length - 1; tier >= 0; tier--) {
      const common = Math.min(librarySize, ROCK_TIERS[tier].maxShapes);
      for (let shapeId = 0; shapeId < common; shapeId++) {
        queue.push({ tier, shapeId });
      }
    }
    for (let tier = ROCK_TIERS.length - 1; tier >= 0; tier--) {
      for (
        let shapeId = Math.min(librarySize, ROCK_TIERS[tier].maxShapes);
        shapeId < librarySize;
        shapeId++
      ) {
        queue.push({ tier, shapeId });
      }
    }
    return queue;
  }

  /** Number of detail tiers (see ROCK_TIERS). */
  getTierCount(): number {
    return ROCK_TIERS.length;
  }

  private wrapShape(shapeId: number): number {
    return ((Math.floor(shapeId) % this.librarySize) + this.librarySize) % this.librarySize;
  }

  private static clampTier(tier: number): number {
    return Math.min(ROCK_TIERS.length - 1, Math.max(0, Math.floor(tier)));
  }

  private keyFor(ladderIndex: number, shape: number): number {
    return ladderIndex * this.librarySize + shape;
  }

  /** Whether a prototype has been built already. Exposed for tests/diagnostics. */
  isPrototypeReady(shapeId: number, tier: number): boolean {
    const ladderIndex = ladderIndexOfDetail(ROCK_TIERS[RockManager.clampTier(tier)].detail);
    return this.prototypes.has(this.keyFor(ladderIndex, shapeId));
  }

  /** Whether the prototype of a shape at an icosphere detail has been built. */
  isDetailReady(shapeId: number, detail: number): boolean {
    const ladderIndex = ladderIndexOfDetail(detail);
    return ladderIndex >= 0 && this.prototypes.has(this.keyFor(ladderIndex, shapeId));
  }

  /** Number of prototypes built so far. Exposed for tests/diagnostics. */
  getBuiltPrototypeCount(): number {
    return this.prototypes.size;
  }

  /** Total number of prototypes the warmup builds: every shape at every tier. */
  getPrototypeCount(): number {
    return this.librarySize * ROCK_TIERS.length;
  }

  /**
   * Get the prototype mesh of a shape at a detail tier, building it first if
   * the background warmup has not reached it yet.
   *
   * @param shapeId - Shape id (wraps around the library size)
   * @param tier - Detail tier, 0 = finest (clamped to the available tiers)
   * @returns The shared geometry, or undefined for an empty library or after dispose
   */
  getPrototype(shapeId: number, tier: number = 0): BufferGeometry | undefined {
    if (this.disposed || this.librarySize === 0) {
      return undefined;
    }
    const shape = this.wrapShape(shapeId);
    const detail = ROCK_TIERS[RockManager.clampTier(tier)].detail;
    const key = this.keyFor(ladderIndexOfDetail(detail), shape);
    let geometry = this.prototypes.get(key);
    if (!geometry) {
      geometry = this.buildPrototype(shape, detail);
      this.prototypes.set(key, geometry);
    }
    this.pinned.add(key);
    return geometry;
  }

  /**
   * Schedule the next background warmup slice via requestIdleCallback,
   * falling back to setTimeout where unavailable (e.g. Safari, node tests).
   */
  private scheduleWarmup(): void {
    if (
      this.disposed ||
      this.warmupHandle !== null ||
      this.warmupCursor >= this.warmupQueue.length
    ) {
      return;
    }
    if (typeof requestIdleCallback === 'function') {
      this.warmupUsesIdleCallback = true;
      this.warmupHandle = requestIdleCallback((deadline) => {
        this.warmupHandle = null;
        this.runWarmupSlice(deadline);
      });
    } else {
      this.warmupUsesIdleCallback = false;
      this.warmupHandle = setTimeout(() => {
        this.warmupHandle = null;
        this.runWarmupSlice();
      }, 0);
    }
  }

  /**
   * Build prototypes until the idle deadline (or fallback time budget) is
   * exhausted, then reschedule if anything remains.
   */
  private runWarmupSlice(deadline?: IdleDeadline): void {
    if (this.disposed) {
      return;
    }
    const sliceEnd = performance.now() + WARMUP_BUDGET_MS;
    while (this.warmupCursor < this.warmupQueue.length) {
      const item = this.warmupQueue[this.warmupCursor++];
      this.getPrototype(item.shapeId, item.tier);
      const outOfTime = deadline
        ? deadline.timeRemaining() <= IDLE_TIME_FLOOR_MS
        : performance.now() >= sliceEnd;
      if (outOfTime) {
        this.scheduleWarmup();
        return;
      }
    }
  }

  /** Cancel any scheduled background warmup slice. */
  private cancelWarmup(): void {
    if (this.warmupHandle === null) {
      return;
    }
    if (this.warmupUsesIdleCallback && typeof this.warmupHandle === 'number') {
      cancelIdleCallback(this.warmupHandle);
    } else {
      clearTimeout(this.warmupHandle);
    }
    this.warmupHandle = null;
  }

  /** Stable placement transforms, including rocks promoted to a finer display mesh. */
  getPlacementMatrices(mesh: InstancedMesh): Float32Array | undefined {
    return this.groups.get(mesh)?.matrices;
  }

  /**
   * Create InstancedMesh objects from worker-computed placement data: one
   * mesh (one draw call) per placement group.
   *
   * Each mesh carries a per-instance tint (instanceColor) and is enabled on
   * the shadow-caster layer so rocks appear in the sun shadow map.
   *
   * @param placements - Rock placement groups from the chunk worker
   * @returns Array of InstancedMesh (one per non-empty group)
   */
  createRockMeshes(placements: readonly RockPlacement[]): InstancedMesh[] {
    const meshes: InstancedMesh[] = [];

    for (const placement of placements) {
      const { prototypeId, tier, matrices, colors } = placement;

      // Each Matrix4 is 16 floats
      const instanceCount = Math.floor(matrices.length / 16);
      if (instanceCount === 0) {
        continue;
      }
      const geometry = this.getPrototype(prototypeId, tier);
      if (!geometry) {
        continue;
      }

      const mesh = new InstancedMesh(geometry, this.material, instanceCount);
      mesh.instanceMatrix.array.set(matrices.subarray(0, instanceCount * 16));
      mesh.instanceMatrix.needsUpdate = true;

      // Per-rock tint; a group without (complete) colors renders untinted
      const tint = new Float32Array(instanceCount * 3);
      if (colors.length >= tint.length) {
        tint.set(colors.subarray(0, tint.length));
      } else {
        tint.fill(1);
      }
      mesh.instanceColor = new InstancedBufferAttribute(tint, 3);

      // Rocks cast sun shadows: the shadow camera only renders this layer
      mesh.layers.enable(SHADOW_CASTER_LAYER);

      // Compute bounding sphere for frustum culling
      mesh.computeBoundingSphere();

      if (mesh.boundingSphere) {
        // Remember the base (un-inflated) sphere so updateCullingBounds() can
        // recompute a tight curvature-aware sphere from the actual camera
        // distance each frame
        const base: TrackedBounds = {
          center: mesh.boundingSphere.center.clone(),
          radius: mesh.boundingSphere.radius,
        };
        mesh.userData.placementBounds = base;
        this.trackMesh(mesh, base);

        // Until the first updateCullingBounds() call, expand conservatively for
        // the vertex shader curvature drop using this chunk's own lifetime
        // distance bound (the chunk is pruned once it leaves render distance),
        // not the old global grid-diagonal worst case that disabled culling
        if (this.material.getParam('enableCurvature')) {
          const maxDistance =
            maxLoadedChunkDistance(this.renderDistance, this.chunkWidth, this.chunkDepth) +
            base.radius;
          applyCurvatureDropToSphere(mesh.boundingSphere, base.center, base.radius, {
            dropMin: 0,
            dropMax: curvatureDrop(maxDistance, this.planetRadius),
          });
        }
      }

      mesh.frustumCulled = true;

      this.trackGroup(mesh, prototypeId, tier, matrices, tint);
      meshes.push(mesh);
    }

    return meshes;
  }

  /**
   * Track a mesh for per-frame culling bound updates. The entry is removed
   * automatically when the mesh is disposed (InstancedMesh.dispose dispatches
   * a 'dispose' event), so chunk unloads need no extra bookkeeping here.
   */
  private trackMesh(mesh: InstancedMesh, base: TrackedBounds): void {
    this.trackedMeshes.set(mesh, base);
    const onDispose = (): void => {
      mesh.removeEventListener('dispose', onDispose);
      this.trackedMeshes.delete(mesh);
    };
    mesh.addEventListener('dispose', onDispose);
  }

  /** Register a chunk placement group for near-camera refinement. */
  private trackGroup(
    mesh: InstancedMesh,
    prototypeId: number,
    tier: number,
    matrices: Float32Array,
    tint: Float32Array
  ): void {
    const count = mesh.count;
    let maxDiameter = 0;
    for (let i = 0; i < count; i++) {
      maxDiameter = Math.max(maxDiameter, rockDiameter(matrices, i * 16));
    }
    mesh.userData.maxRockDiameter = maxDiameter;
    const group: RockGroup = {
      mesh,
      shapeId: this.wrapShape(prototypeId),
      baseIndex: ladderIndexOfDetail(ROCK_TIERS[RockManager.clampTier(tier)].detail),
      count,
      // The placement's buffers are ours (transferred from the worker); the
      // tint is copied because the mesh's own buffer gets compacted
      matrices,
      colors: tint.slice(),
      maxDiameter,
      bounds: this.trackedMeshes.get(mesh) ?? null,
      levels: null,
      drawn: null,
      promoted: 0,
      changed: false,
    };
    this.groups.set(mesh, group);
    this.nearDirty = true;
    const onDispose = (): void => {
      mesh.removeEventListener('dispose', onDispose);
      this.groups.delete(mesh);
      if (group.promoted > 0) {
        this.nearDirty = true;
      }
    };
    mesh.addEventListener('dispose', onDispose);
  }

  /**
   * Get the number of rock meshes currently tracked for culling updates.
   * Exposed for tests/diagnostics.
   */
  getTrackedMeshCount(): number {
    return this.trackedMeshes.size;
  }

  /**
   * Object holding the near-camera meshes. Add it to the scene once
   * (ChunkManager does).
   */
  getNearDetailRoot(): Group {
    return this.nearRoot;
  }

  /** Numbers of the last near-detail re-bucketing. */
  getNearDetailStats(): Readonly<NearDetailStats> {
    return this.nearStats;
  }

  /**
   * Refine the rocks near the camera: re-bucket them by projected size when
   * the camera has moved `rebucketDistance`, the view changed, a chunk group
   * holding refined rocks was hidden or disposed, new groups arrived, or a
   * fine prototype finished building. Otherwise this costs a few
   * comparisons. Call once per frame after the chunk meshes' visibility is
   * final (ChunkManager.update).
   *
   * @param cameraPosition - World-space camera position
   * @param fovRadians - Vertical field of view
   * @param screenHeight - Viewport height in pixels
   * @returns Whether anything drawn changed (a render is needed)
   */
  updateNearDetail(cameraPosition: Vector3, fovRadians: number, screenHeight: number): boolean {
    if (this.disposed || this.librarySize === 0) {
      return false;
    }
    const pixelsPerRadian = screenHeight / (2 * Math.tan(fovRadians / 2));
    const moved = this.lastRebucketCamera.distanceToSquared(cameraPosition);
    const threshold = this.nearOptions.rebucketDistance;
    if (
      !this.nearDirty &&
      moved < threshold * threshold &&
      Math.abs(pixelsPerRadian - this.lastPixelsPerRadian) <= 1e-6 * pixelsPerRadian &&
      !this.promotedGroupHidden()
    ) {
      return false;
    }
    this.rebucket(cameraPosition, pixelsPerRadian);
    return true;
  }

  /** Whether a group holding refined rocks stopped being drawn. */
  private promotedGroupHidden(): boolean {
    for (const group of this.promotedGroups) {
      if (!group.mesh.visible || group.mesh.parent === null) {
        return true;
      }
    }
    return false;
  }

  private ensureCandidateCapacity(needed: number): void {
    if (needed <= this.candidateInstance.length) {
      return;
    }
    const size = Math.max(needed, this.candidateInstance.length * 2);
    const group = new Int32Array(size);
    group.set(this.candidateGroup);
    const instance = new Int32Array(size);
    instance.set(this.candidateInstance);
    const pixels = new Float32Array(size);
    pixels.set(this.candidatePixels);
    const level = new Uint8Array(size);
    level.set(this.candidateLevel);
    this.candidateGroup = group;
    this.candidateInstance = instance;
    this.candidatePixels = pixels;
    this.candidateLevel = level;
  }

  /** Re-bucket the rocks near the camera into chunk and near meshes. */
  private rebucket(camera: Vector3, pixelsPerRadian: number): void {
    const options = this.nearOptions;
    this.nearDirty = false;
    this.lastRebucketCamera.copy(camera);
    this.lastPixelsPerRadian = pixelsPerRadian;
    this.rebucketCount++;
    const keyTotal = ROCK_DETAIL_LADDER.length * this.librarySize;
    if (this.keyStamp.length < keyTotal) {
      this.keyStamp = new Uint32Array(keyTotal);
      this.keyCount = new Int32Array(keyTotal);
    }

    // 1. Candidates: rocks of visible groups that deserve a finer mesh
    // (projected size above the first refinement step, with margin), plus
    // every rock that is refined now
    const slack = 1 + options.hysteresis;
    const minSegment = options.pixelsPerSegment / slack;
    this.candidateCount = 0;
    this.candidateGroups.length = 0;
    this.nextPromotedGroups.length = 0;
    for (const group of this.groups.values()) {
      const mesh = group.mesh;
      const parent = mesh.parent;
      const bounds = group.bounds;
      let near = false;
      if (
        mesh.visible &&
        parent !== null &&
        bounds &&
        group.baseIndex < ROCK_DETAIL_LADDER.length - 1
      ) {
        // Farthest distance at which the group's largest rock is refined;
        // chunk meshes sit at their chunk object's position, so the group
        // sphere is found without touching any world matrix
        const step = ROCK_DETAIL_LADDER[group.baseIndex + 1] + 1;
        const reach = (group.maxDiameter * pixelsPerRadian) / (step * minSegment) + bounds.radius;
        const dx = parent.position.x + bounds.center.x - camera.x;
        const dy = parent.position.y + bounds.center.y - camera.y;
        const dz = parent.position.z + bounds.center.z - camera.z;
        near = dx * dx + dy * dy + dz * dz <= reach * reach;
      }
      if (!near) {
        if (group.promoted > 0) {
          this.restoreGroup(group);
        }
        continue;
      }
      mesh.updateWorldMatrix(true, false);
      const world = mesh.matrixWorld.elements;
      // Rocks at their chunk tier only become candidates once big enough to
      // be refined; refined ones stay candidates until they drop back
      const firstStep =
        (ROCK_DETAIL_LADDER[group.baseIndex + 1] + 1) * options.pixelsPerSegment * slack;
      const matrices = group.matrices;
      const levels = group.levels;
      const groupIndex = this.candidateGroups.length;
      for (let i = 0; i < group.count; i++) {
        const o = i * 16;
        const dx = world[12] + matrices[o + 12] - camera.x;
        const dy = world[13] + matrices[o + 13] - camera.y;
        const dz = world[14] + matrices[o + 14] - camera.z;
        const distance = Math.max(0.05, Math.sqrt(dx * dx + dy * dy + dz * dz));
        const pixels = (rockDiameter(matrices, o) * pixelsPerRadian) / distance;
        if (pixels < firstStep && (levels === null || levels[i] === group.baseIndex)) {
          continue;
        }
        const c = this.candidateCount++;
        this.ensureCandidateCapacity(this.candidateCount);
        this.candidateGroup[c] = groupIndex;
        this.candidateInstance[c] = i;
        this.candidatePixels[c] = pixels;
      }
      if (this.candidateCount > 0 && this.candidateGroup[this.candidateCount - 1] === groupIndex) {
        this.candidateGroups.push(group);
      } else if (group.promoted > 0) {
        this.restoreGroup(group);
      }
    }

    // 2. Levels with hysteresis; raise the pixel target until the extra
    // triangles and near meshes fit the budget
    let pixelsPerSegment = options.pixelsPerSegment;
    let extra = 0;
    let meshCount = 0;
    let refined = 0;
    let triangles = 0;
    let baseTriangles = 0;
    for (let round = 0; round < BUDGET_ROUNDS; round++) {
      this.stamp++;
      extra = 0;
      meshCount = 0;
      refined = 0;
      triangles = 0;
      baseTriangles = 0;
      for (let c = 0; c < this.candidateCount; c++) {
        const group = this.candidateGroups[this.candidateGroup[c]];
        const i = this.candidateInstance[c];
        const pixels = this.candidatePixels[c];
        const previous = group.levels ? group.levels[i] : group.baseIndex;
        const up = ladderIndexForPixels(pixels / slack, pixelsPerSegment, group.baseIndex);
        const down = ladderIndexForPixels(pixels * slack, pixelsPerSegment, group.baseIndex);
        const level = previous < up ? up : previous > down ? down : previous;
        this.candidateLevel[c] = level;
        if (level > group.baseIndex) {
          refined++;
          triangles += LADDER_TRIANGLES[level];
          baseTriangles += LADDER_TRIANGLES[group.baseIndex];
          const key = this.keyFor(level, group.shapeId);
          if (this.keyStamp[key] !== this.stamp) {
            this.keyStamp[key] = this.stamp;
            meshCount++;
          }
        }
      }
      extra = triangles - baseTriangles;
      if (extra <= options.maxExtraTriangles && meshCount <= options.maxMeshes) {
        break;
      }
      if (round === BUDGET_ROUNDS - 1) {
        // Still over budget: keep every rock at its chunk mesh
        for (let c = 0; c < this.candidateCount; c++) {
          this.candidateLevel[c] = this.candidateGroups[this.candidateGroup[c]].baseIndex;
        }
        refined = 0;
        triangles = 0;
        baseTriangles = 0;
        meshCount = 0;
        break;
      }
      pixelsPerSegment *= 1.35;
    }

    // 3. Resolve what can be drawn now (finest built prototype at or below
    // the wanted level, requesting the wanted one) and count near rocks
    this.stamp++;
    const usedKeys = this.stamp;
    for (let c = 0; c < this.candidateCount; c++) {
      const group = this.candidateGroups[this.candidateGroup[c]];
      const i = this.candidateInstance[c];
      if (group.levels === null || group.drawn === null) {
        group.levels = new Uint8Array(group.count).fill(group.baseIndex);
        group.drawn = new Uint8Array(group.count).fill(group.baseIndex);
      }
      const before = group.drawn[i];
      const level = this.candidateLevel[c];
      group.levels[i] = level;
      let drawn = level;
      while (drawn > group.baseIndex && !this.prototypes.has(this.keyFor(drawn, group.shapeId))) {
        drawn--;
      }
      if (drawn !== level) {
        this.requestPrototype(group.shapeId, level);
      }
      group.drawn[i] = drawn;
      if (drawn !== before) {
        group.changed = true;
      }
      if (drawn > group.baseIndex) {
        const key = this.keyFor(drawn, group.shapeId);
        if (this.keyStamp[key] !== usedKeys) {
          this.keyStamp[key] = usedKeys;
          this.keyCount[key] = 0;
        }
        this.keyCount[key]++;
      }
    }

    // 4. Size the near meshes, then refill them and compact the chunk meshes
    const anchorX = Math.round(camera.x);
    const anchorY = Math.round(camera.y);
    const anchorZ = Math.round(camera.z);
    this.nearRoot.position.set(anchorX, anchorY, anchorZ);
    this.nearRoot.updateMatrix();
    for (const near of this.nearMeshes.values()) {
      near.mesh.count = 0;
    }
    for (let key = 0; key < keyTotal; key++) {
      if (this.keyStamp[key] === usedKeys) {
        this.prepareNearMesh(key, this.keyCount[key]);
        this.lastUsed.set(key, this.rebucketCount);
      }
    }
    for (const group of this.candidateGroups) {
      this.writeGroup(group, anchorX, anchorY, anchorZ);
    }
    for (const near of this.nearMeshes.values()) {
      const mesh = near.mesh;
      mesh.visible = mesh.count > 0;
      if (mesh.count > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          mesh.instanceColor.needsUpdate = true;
        }
        mesh.computeBoundingSphere();
        if (mesh.boundingSphere) {
          near.bounds.center.copy(mesh.boundingSphere.center);
          near.bounds.radius = mesh.boundingSphere.radius;
        }
      }
    }

    const swap = this.promotedGroups;
    this.promotedGroups = this.nextPromotedGroups;
    this.nextPromotedGroups = swap;
    const stats = this.nearStats;
    stats.refinedRocks = refined;
    stats.meshes = this.countVisibleNearMeshes();
    stats.triangles = triangles;
    stats.baseTriangles = baseTriangles;
    stats.pixelsPerSegment = pixelsPerSegment;
    this.evictPrototypes();
  }

  private countVisibleNearMeshes(): number {
    let count = 0;
    for (const near of this.nearMeshes.values()) {
      if (near.mesh.visible) {
        count++;
      }
    }
    return count;
  }

  /** Make sure the near mesh of a key exists with room for `needed` rocks. */
  private prepareNearMesh(key: number, needed: number): void {
    const existing = this.nearMeshes.get(key);
    if (existing && existing.capacity >= needed) {
      return;
    }
    let capacity = existing ? existing.capacity : NEAR_MESH_MIN_CAPACITY;
    while (capacity < needed) {
      capacity *= 2;
    }
    const geometry = this.prototypes.get(key);
    if (!geometry) {
      return;
    }
    if (existing) {
      this.nearRoot.remove(existing.mesh);
      existing.mesh.dispose();
    }
    const mesh = new InstancedMesh(geometry, this.material, capacity);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.layers.enable(SHADOW_CASTER_LAYER);
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.count = 0;
    mesh.visible = false;
    const bounds: TrackedBounds = { center: new Vector3(), radius: 0 };
    this.trackMesh(mesh, bounds);
    this.nearRoot.add(mesh);
    this.nearMeshes.set(key, { mesh, key, capacity, bounds });
  }

  /**
   * Rewrite a candidate group: rocks at their chunk tier are compacted into
   * the chunk mesh, refined rocks are appended to their near mesh.
   */
  private writeGroup(group: RockGroup, anchorX: number, anchorY: number, anchorZ: number): void {
    const drawn = group.drawn;
    if (drawn === null) {
      return;
    }
    const mesh = group.mesh;
    const target = mesh.instanceMatrix.array;
    const tint = mesh.instanceColor?.array;
    const world = mesh.matrixWorld.elements;
    const offsetX = world[12] - anchorX;
    const offsetY = world[13] - anchorY;
    const offsetZ = world[14] - anchorZ;
    const compact = group.changed;
    group.changed = false;
    let kept = 0;
    let promoted = 0;
    for (let i = 0; i < group.count; i++) {
      const from = i * 16;
      if (drawn[i] === group.baseIndex) {
        if (!compact) {
          kept++;
          continue;
        }
        const to = kept * 16;
        for (let k = 0; k < 16; k++) {
          target[to + k] = group.matrices[from + k];
        }
        if (tint) {
          tint[kept * 3] = group.colors[i * 3];
          tint[kept * 3 + 1] = group.colors[i * 3 + 1];
          tint[kept * 3 + 2] = group.colors[i * 3 + 2];
        }
        kept++;
        continue;
      }
      const near = this.nearMeshes.get(this.keyFor(drawn[i], group.shapeId));
      if (!near) {
        continue;
      }
      promoted++;
      const nearMesh = near.mesh;
      const slot = nearMesh.count++;
      const matrix = nearMesh.instanceMatrix.array;
      const to = slot * 16;
      for (let k = 0; k < 16; k++) {
        matrix[to + k] = group.matrices[from + k];
      }
      matrix[to + 12] += offsetX;
      matrix[to + 13] += offsetY;
      matrix[to + 14] += offsetZ;
      const colors = nearMesh.instanceColor?.array;
      if (colors) {
        colors[slot * 3] = group.colors[i * 3];
        colors[slot * 3 + 1] = group.colors[i * 3 + 1];
        colors[slot * 3 + 2] = group.colors[i * 3 + 2];
      }
    }
    if (compact) {
      mesh.count = kept;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        mesh.instanceColor.needsUpdate = true;
      }
    }
    group.promoted = promoted;
    if (promoted > 0) {
      this.nextPromotedGroups.push(group);
    } else {
      group.levels = null;
      group.drawn = null;
    }
  }

  /** Put every rock of a group back into its chunk mesh. */
  private restoreGroup(group: RockGroup): void {
    group.levels = null;
    group.drawn = null;
    group.promoted = 0;
    group.changed = false;
    const mesh = group.mesh;
    mesh.instanceMatrix.array.set(group.matrices.subarray(0, group.count * 16));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) {
      mesh.instanceColor.array.set(group.colors);
      mesh.instanceColor.needsUpdate = true;
    }
    mesh.count = group.count;
  }

  /** Start building a fine prototype off the main thread, if not already. */
  private requestPrototype(shapeId: number, ladderIndex: number): void {
    const key = this.keyFor(ladderIndex, shapeId);
    if (
      this.prototypes.has(key) ||
      this.pendingBuilds.has(key) ||
      this.failedBuilds.has(key) ||
      this.pendingBuilds.size >= this.nearOptions.maxInFlight
    ) {
      return;
    }
    this.pendingBuilds.add(key);
    this.buildPrototypeAsync(shapeId, ROCK_DETAIL_LADDER[ladderIndex]).then(
      (geometry) => {
        this.pendingBuilds.delete(key);
        if (this.disposed || this.prototypes.has(key)) {
          geometry.dispose();
          return;
        }
        this.prototypes.set(key, geometry);
        this.lastUsed.set(key, this.rebucketCount);
        this.nearDirty = true;
      },
      (error: unknown) => {
        this.pendingBuilds.delete(key);
        this.failedBuilds.add(key);
        // Retrying would fail the same way; the rock keeps a coarser mesh
        console.warn('Rock prototype build failed', error);
        this.nearDirty = true;
      }
    );
  }

  /** Number of fine prototypes being built. Exposed for tests/diagnostics. */
  getPendingBuildCount(): number {
    return this.pendingBuilds.size;
  }

  /**
   * Drop the least recently used fine prototypes (and their near meshes)
   * beyond the cache size. Prototypes of chunk meshes and of near meshes in
   * use are kept.
   */
  private evictPrototypes(): void {
    const excess = this.prototypes.size - this.pinned.size - this.nearOptions.cacheSize;
    if (excess <= 0) {
      return;
    }
    const evictable: number[] = [];
    for (const key of this.prototypes.keys()) {
      const near = this.nearMeshes.get(key);
      if (!this.pinned.has(key) && !(near && near.mesh.count > 0)) {
        evictable.push(key);
      }
    }
    evictable.sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
    for (const key of evictable.slice(0, excess)) {
      const near = this.nearMeshes.get(key);
      if (near) {
        this.nearRoot.remove(near.mesh);
        near.mesh.dispose();
        this.nearMeshes.delete(key);
      }
      this.prototypes.get(key)?.dispose();
      this.prototypes.delete(key);
      this.lastUsed.delete(key);
    }
  }

  /**
   * Recompute each live rock mesh's bounding sphere from the current camera
   * position so frustum culling stays effective under the curvature shader.
   *
   * The vertex shader drops geometry by distance-from-camera squared, so the
   * required sphere inflation depends on where the camera is right now. Using
   * the actual per-mesh camera distance keeps nearby chunks' spheres tight
   * (they get almost no drop) instead of inflating every sphere by the global
   * worst case, which effectively disabled rock culling.
   *
   * Call once per frame (ChunkManager.update) after curvature params are synced.
   */
  updateCullingBounds(cameraPosition: Vector3): void {
    if (this.trackedMeshes.size === 0) {
      return;
    }

    const enableCurvature = this.material.getParam('enableCurvature');
    const planetRadius = this.material.getParam('planetRadius') || this.planetRadius;

    for (const [mesh, base] of this.trackedMeshes) {
      if (!mesh.boundingSphere) {
        continue;
      }

      if (!enableCurvature) {
        // No curvature: restore the exact base sphere
        mesh.boundingSphere.center.copy(base.center);
        mesh.boundingSphere.radius = base.radius;
        continue;
      }

      // World-space sphere center (meshes only ever carry translations from
      // their parent chunk LOD object or the near-detail root)
      mesh.updateWorldMatrix(true, false);
      _worldCenter.copy(base.center).applyMatrix4(mesh.matrixWorld);

      const dx = cameraPosition.x - _worldCenter.x;
      const dz = cameraPosition.z - _worldCenter.z;
      const horizontalDistance = Math.sqrt(dx * dx + dz * dz);

      const range = curvatureDropRange(horizontalDistance, base.radius, planetRadius);
      applyCurvatureDropToSphere(mesh.boundingSphere, base.center, base.radius, range);
    }
  }

  /**
   * Get the number of rock prototypes in the library.
   * Needed by ChunkWorker to assign prototypeIds.
   */
  getLibrarySize(): number {
    return this.librarySize;
  }

  /**
   * Get the shared rock material.
   */
  getMaterial(): MoonMaterial {
    return this.material;
  }

  /**
   * Update sun direction for horizon occlusion calculation
   * Should be called each frame with the current sun direction in world space
   *
   * @param direction Sun direction vector (normalized, in world space)
   */
  setSunDirection(direction: Vector3): void {
    this.material.setSunDirection(direction);
  }

  /**
   * Set sun horizon fade factor
   * Should be called each frame with the current horizon fade (0 = below horizon, 1 = above horizon)
   *
   * @param fade Horizon fade factor (0-1)
   */
  setSunHorizonFade(fade: number): void {
    this.material.setSunHorizonFade(fade);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelWarmup();
    this.disposeAsyncBuilder();

    for (const near of this.nearMeshes.values()) {
      this.nearRoot.remove(near.mesh);
      near.mesh.dispose();
    }
    this.nearMeshes.clear();
    this.groups.clear();
    this.promotedGroups.length = 0;

    // RockManager owns the shared prototypes - chunks must never dispose them
    for (const geometry of this.prototypes.values()) {
      geometry.dispose();
    }
    this.prototypes.clear();
    this.pinned.clear();
    this.trackedMeshes.clear();

    // Dispose material
    this.material.dispose();
  }
}

/**
 * Diameter of a placed rock: its prototypes have a unit horizontal
 * footprint, so this is the larger horizontal axis scale of its matrix.
 */
function rockDiameter(matrices: Float32Array, offset: number): number {
  const x = Math.hypot(matrices[offset], matrices[offset + 1], matrices[offset + 2]);
  const z = Math.hypot(matrices[offset + 8], matrices[offset + 9], matrices[offset + 10]);
  return Math.max(x, z);
}
