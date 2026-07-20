import { type BufferGeometry, InstancedMesh, Matrix4, Vector3 } from 'three';
import { RockBuilder, type RockLibraryBuilder } from './RockBuilder';
import { MoonMaterial } from '../shaders/MoonMaterial';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';
import type { RockPlacement } from '../terrain/ChunkWorker';
import {
  applyCurvatureDropToSphere,
  curvatureDrop,
  curvatureDropRange,
  maxLoadedChunkDistance,
} from '../terrain/curvatureBounds';

/**
 * Base (un-inflated) bounding sphere of a tracked rock mesh, in mesh-local
 * space, used to recompute curvature-aware culling bounds each frame.
 */
interface TrackedBounds {
  center: Vector3;
  radius: number;
}

// Scratch vector to avoid per-frame allocations in updateCullingBounds
const _worldCenter = new Vector3();

/**
 * In-progress prototype library for one detail level. Prototypes and stable
 * axes accumulate here (via idle warmup steps or a synchronous catch-up in
 * ensureDetailLevel) until the level is complete and promoted to the
 * prototypesByDetail/stableAxesByDetail maps.
 */
interface PartialLibrary {
  builder: RockLibraryBuilder;
  prototypes: BufferGeometry[];
  stableAxes: Vector3[];
}

/** Time budget (ms) per warmup slice when requestIdleCallback is unavailable. */
const WARMUP_BUDGET_MS = 8;
/** Minimum idle time (ms) we require before doing another unit of warmup work. */
const IDLE_TIME_FLOOR_MS = 1;

/**
 * RockManager generates LOD-based libraries of rock prototype geometries
 * and creates InstancedMesh from worker-computed placement data.
 *
 * Rock detail is mapped directly to chunk LOD level:
 * - LOD 0-1: detail 15 (~5120 triangles) for closest chunks
 * - LOD 2-3: detail 10 (~2420 triangles) for medium chunks
 * - LOD 4+: detail 7 (~1280 triangles) for distant chunks
 *
 * Prototype generation (geometry build + stable-axis power iteration) is
 * expensive — librarySize prototypes per detail level — so it is NOT done in
 * the constructor. Instead it is spread over idle time one prototype at a
 * time (requestIdleCallback with a setTimeout fallback), and any level that
 * is requested before its warmup finished is completed synchronously on
 * first use. Generation is seeded per prototype index, so lazy/incremental
 * building yields exactly the same rocks as the old eager path.
 */
export class RockManager {
  // Detail levels used by getDetailForLod, finest first: the finest level is
  // needed for the closest chunks, so warm it up before the coarser ones.
  private static readonly DETAIL_LEVELS: readonly number[] = [15, 10, 7];

  // Store prototypes by detail level (7, 10, 15) instead of LOD level
  // This avoids generating duplicate libraries for LODs that share the same detail level
  private prototypesByDetail: Map<number, BufferGeometry[]> = new Map();
  // Store stable axes (principal axes) for each prototype by detail level
  // Each entry is an array of Vector3, one per prototype
  private stableAxesByDetail: Map<number, Vector3[]> = new Map();
  // In-progress libraries per detail level (idle warmup or partial sync work)
  private partialByDetail: Map<number, PartialLibrary> = new Map();
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
  private lodLevels: number[];
  private renderDistance: number;
  private planetRadius: number;

  /**
   * Get triangle count for a given detail level.
   * Formula: 20 * (detail + 1)^2
   */
  static getTriangleCount(detail: number): number {
    return 20 * (detail + 1) ** 2;
  }

  /**
   * Find appropriate icosahedron detail level for a given LOD.
   * Uses direct LOD-to-detail mapping prioritizing visual quality.
   * 
   * Note: LOD 0 = highest detail terrain (1024 resolution), LOD 8 = lowest detail (4 resolution)
   * Closest chunks get maximum detail, distant chunks get lower detail for performance.
   * 
   * Triangle count formula: 20 * (detail + 1)^2
   * 
   * Strategy:
   * - LOD 0-1 (closest chunks): detail 15 (~5120 triangles) - maximum quality
   * - LOD 2-3 (medium chunks): detail 10 (~2420 triangles) - high quality
   * - LOD 4+ (distant chunks): detail 7 (~1280 triangles) - lower detail for performance
   */
  static getDetailForLod(
    lodLevel: number,
    _chunkWidth: number,
    _chunkDepth: number,
    _lodLevels: number[],
    _avgRockDiameter: number = 1.0
  ): number {
    // Direct LOD-to-detail mapping prioritizing visual quality
    // Note: LOD 0 = highest detail (1024), LOD 8 = lowest detail (4)
    // Closest chunks get maximum detail, distant chunks get lower detail
    if (lodLevel <= 1) {
      return 15; // LOD 0-1: detail 15 (~5120 triangles) for closest chunks
    } else if (lodLevel <= 3) {
      return 10; // LOD 2-3: detail 10 (~2420 triangles) for medium chunks
    } else {
      return 7; // LOD 4+: detail 7 (~1280 triangles) for distant chunks
    }
  }

  /**
   * Create a RockManager with LOD-based libraries of procedural rock prototypes.
   * 
   * @param librarySize - Number of unique rock shapes to generate per LOD (default: 30)
   * @param chunkWidth - Chunk width in meters (default: 100)
   * @param chunkDepth - Chunk depth in meters (default: 100)
   * @param lodLevels - Terrain LOD resolution levels (default: [1024, 512, 256, 128, 64, 32, 16, 8, 4])
   * @param renderDistance - Maximum chunks to load in each direction (default: 20)
   * @param planetRadius - Planet radius for curvature calculations (default: 5000)
   */
  constructor(
    librarySize: number = 30,
    chunkWidth: number = 100,
    chunkDepth: number = 100,
    lodLevels: number[] = [1024, 512, 256, 128, 64, 32, 16, 8, 4],
    renderDistance: number = 20,
    planetRadius: number = DEFAULT_PLANET_RADIUS
  ) {
    this.librarySize = librarySize;
    this.chunkWidth = chunkWidth;
    this.chunkDepth = chunkDepth;
    this.lodLevels = lodLevels;
    this.renderDistance = renderDistance;
    this.planetRadius = planetRadius;

    // Create shared material for all rocks with curvature support
    // Use MoonMaterial so rocks match terrain appearance
    this.material = new MoonMaterial();
    this.material.setParam('enableColorVariation', true); // Match terrain
    this.material.setParam('enableCurvature', true);
    this.material.setParam('planetRadius', planetRadius);

    // Prototype libraries are NOT generated here: building
    // DETAIL_LEVELS.length * librarySize geometries plus stable axes blocks
    // the main thread for hundreds of ms during startup. Instead, spread the
    // work over idle time; any level requested earlier is completed
    // synchronously on first use (see ensureDetailLevel).
    this.scheduleWarmup();
  }

  /**
   * Whether the prototype library for a detail level has been fully built.
   * Exposed for tests/diagnostics.
   */
  isDetailLevelReady(detailLevel: number): boolean {
    return this.prototypesByDetail.has(detailLevel);
  }

  /**
   * Perform one unit of prototype-generation work for a detail level:
   * either create the shared base geometry (first call) or build one
   * prototype and its stable axis.
   *
   * @returns true once the level's library is complete
   */
  private buildStep(detail: number): boolean {
    if (this.prototypesByDetail.has(detail)) {
      return true;
    }

    let partial = this.partialByDetail.get(detail);
    if (!partial) {
      // Creating the base geometry (icosphere + vertex merge) is this unit's
      // work - prototypes follow on subsequent calls
      partial = {
        builder: RockBuilder.createLibraryBuilder(this.librarySize, { detail }),
        prototypes: [],
        stableAxes: [],
      };
      this.partialByDetail.set(detail, partial);
      return this.librarySize <= 0 ? this.finishLevel(detail, partial) : false;
    }

    const geometry = partial.builder.buildNext();
    if (geometry) {
      partial.prototypes.push(geometry);
      partial.stableAxes.push(RockBuilder.calculateStableAxis(geometry));
    }

    if (!geometry || partial.prototypes.length >= this.librarySize) {
      return this.finishLevel(detail, partial);
    }
    return false;
  }

  /** Promote a completed partial library into the by-detail maps. */
  private finishLevel(detail: number, partial: PartialLibrary): boolean {
    partial.builder.dispose();
    this.prototypesByDetail.set(detail, partial.prototypes);
    this.stableAxesByDetail.set(detail, partial.stableAxes);
    this.partialByDetail.delete(detail);
    return true;
  }

  /**
   * Ensure the prototype library for a detail level exists, finishing any
   * remaining generation work synchronously. Called from the accessors so a
   * level that is needed before its idle warmup completed is built on first
   * use (at most one detail level's worth of work, not all of them).
   *
   * Unknown detail levels (anything outside DETAIL_LEVELS) are not generated.
   */
  private ensureDetailLevel(detail: number): BufferGeometry[] | undefined {
    if (this.disposed || !RockManager.DETAIL_LEVELS.includes(detail)) {
      return this.prototypesByDetail.get(detail);
    }
    while (!this.buildStep(detail)) {
      // Finish the remaining units for this level synchronously
    }
    return this.prototypesByDetail.get(detail);
  }

  /**
   * Schedule the next background warmup slice via requestIdleCallback,
   * falling back to setTimeout where unavailable (e.g. Safari, node tests).
   */
  private scheduleWarmup(): void {
    if (this.disposed || this.warmupHandle !== null || !this.hasPendingWarmupWork()) {
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

  private hasPendingWarmupWork(): boolean {
    return RockManager.DETAIL_LEVELS.some((detail) => !this.prototypesByDetail.has(detail));
  }

  /**
   * Run prototype-generation work units until the idle deadline (or fallback
   * time budget) is exhausted, then reschedule if anything remains. Finest
   * detail level first: it is the one the closest chunks need.
   */
  private runWarmupSlice(deadline?: IdleDeadline): void {
    if (this.disposed) {
      return;
    }
    const sliceEnd = performance.now() + WARMUP_BUDGET_MS;
    const outOfTime = (): boolean =>
      deadline ? deadline.timeRemaining() <= IDLE_TIME_FLOOR_MS : performance.now() >= sliceEnd;

    for (const detail of RockManager.DETAIL_LEVELS) {
      while (!this.buildStep(detail)) {
        if (outOfTime()) {
          this.scheduleWarmup();
          return;
        }
      }
    }
  }

  /** Cancel any scheduled background warmup slice. */
  private cancelWarmup(): void {
    if (this.warmupHandle === null) {
      return;
    }
    if (this.warmupUsesIdleCallback) {
      cancelIdleCallback(this.warmupHandle as number);
    } else {
      clearTimeout(this.warmupHandle as ReturnType<typeof setTimeout>);
    }
    this.warmupHandle = null;
  }

  /**
   * Get stable axes (principal axes) for prototypes at a given detail level.
   * Builds the level's library on first use if it is not ready yet.
   *
   * @param detailLevel - Detail level (7, 10, or 15)
   * @returns Array of Vector3 representing stable axes, one per prototype
   */
  getStableAxesForDetail(detailLevel: number): Vector3[] | undefined {
    this.ensureDetailLevel(detailLevel);
    return this.stableAxesByDetail.get(detailLevel);
  }

  /**
   * Create InstancedMesh objects from worker-computed placement data.
   * 
   * @param placements - Array of rock placements from ChunkWorker
   * @param lodLevel - LOD level to use for selecting appropriate detail library
   * @returns Array of InstancedMesh (one per prototype that has placements)
   */
  createRockMeshes(placements: RockPlacement[], lodLevel: number): InstancedMesh[] {
    const meshes: InstancedMesh[] = [];

    // Map LOD level to detail level (building the library on first use)
    const detail = RockManager.getDetailForLod(lodLevel, this.chunkWidth, this.chunkDepth, this.lodLevels);
    const prototypes = this.ensureDetailLevel(detail) ?? this.ensureDetailLevel(7);
    if (!prototypes || prototypes.length === 0) {
      console.warn(`No prototypes available for detail ${detail} (LOD ${lodLevel})`);
      return meshes;
    }

    for (const placement of placements) {
      const { prototypeId, matrices } = placement;

      // Get prototype geometry (wrap around if prototypeId is out of range)
      const geometry = prototypes[prototypeId % prototypes.length];
      if (!geometry) {
        continue;
      }

      // Calculate instance count from matrix array
      // Each Matrix4 is 16 floats
      const instanceCount = matrices.length / 16;
      if (instanceCount === 0) {
        continue;
      }

      // Create instanced mesh
      const mesh = new InstancedMesh(geometry, this.material, instanceCount);

      // Set instance matrices from flat array
      const matrix = new Matrix4();
      for (let i = 0; i < instanceCount; i++) {
        // Extract 16 floats for this instance
        const offset = i * 16;
        matrix.fromArray(matrices, offset);
        mesh.setMatrixAt(i, matrix);
      }

      // Mark instance matrix as needing update
      mesh.instanceMatrix.needsUpdate = true;

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

      // Enable frustum culling per instance
      mesh.frustumCulled = true;

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

  /**
   * Get the number of rock meshes currently tracked for culling updates.
   * Exposed for tests/diagnostics.
   */
  getTrackedMeshCount(): number {
    return this.trackedMeshes.size;
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
      // their parent chunk LOD object)
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
   * Get a specific prototype geometry by index and LOD level.
   * 
   * @param index - Prototype index (wraps around if > library size)
   * @param lodLevel - LOD level (default: 0)
   */
  getPrototype(index: number, lodLevel: number = 0): BufferGeometry | undefined {
    const detail = RockManager.getDetailForLod(lodLevel, this.chunkWidth, this.chunkDepth, this.lodLevels);
    const prototypes = this.ensureDetailLevel(detail) ?? this.ensureDetailLevel(7);
    if (!prototypes || prototypes.length === 0) return undefined;
    return prototypes[index % prototypes.length];
  }

  /**
   * Get all prototype geometries for a given detail level.
   * Builds the level's library on first use if it is not ready yet.
   *
   * @param detailLevel - Detail level (7, 10, or 15)
   */
  getPrototypesForDetail(detailLevel: number): BufferGeometry[] | undefined {
    return this.ensureDetailLevel(detailLevel);
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.disposed = true;
    this.cancelWarmup();

    // Dispose all prototype geometries across all detail levels.
    // RockManager owns the shared prototypes - chunks must never dispose them.
    for (const prototypes of this.prototypesByDetail.values()) {
      for (const geometry of prototypes) {
        geometry.dispose();
      }
    }
    this.prototypesByDetail.clear();
    this.stableAxesByDetail.clear();

    // Dispose any half-built libraries from an interrupted warmup
    for (const partial of this.partialByDetail.values()) {
      partial.builder.dispose();
      for (const geometry of partial.prototypes) {
        geometry.dispose();
      }
    }
    this.partialByDetail.clear();
    this.trackedMeshes.clear();

    // Dispose material
    this.material.dispose();
  }
}
