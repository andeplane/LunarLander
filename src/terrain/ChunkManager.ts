import { type Scene, Vector3, type Camera, type PerspectiveCamera, MeshBasicMaterial, Color } from 'three';
import { Chunk } from './Chunk';
import type { TerrainGenerator } from './TerrainGenerator';
import { RockManager } from '../environment/RockManager';
import type { TerrainArgs } from './terrain';
import type { ChunkWorkerResult } from './ChunkWorker';
import type { RockGenerationConfig, CraterGenerationConfig } from '../types';
import {
  getNeighborKeys,
  parseGridKey,
  getDistanceToChunk,
  getLodLevelForScreenSize,
  type LodDetailLevel,
  projectToScreenSpace,
  type NeighborLods
} from './LodUtils';
import { ChunkRequestQueue, type QueuedRequest } from './ChunkRequestQueue';

/**
 * Configuration for chunk management
 */
export interface ChunkConfig {
  renderDistance: number;
  chunkWidth: number;
  chunkDepth: number;
  /** Resolution levels from highest to lowest, e.g. [512, 256, 128, 64] */
  lodLevels: number[];
  /** Target screen-space triangle size for LOD selection */
  lodDetailLevel: LodDetailLevel;
  /** Debug mode: render wireframe triangles with different color per chunk */
  debugWireframe?: boolean;
  /** Number of terrain generation workers (default: auto-detected from CPU cores, capped at 8) */
  workerCount?: number;
}

/**
 * Number of chunks that the high-priority worker targets (3x3 grid)
 */
const HP_WORKER_TARGET_CHUNKS = 9;

/**
 * Number of nearest chunks that get Tier 1 priority boost (~5x5 grid)
 */
const NEAREST_CHUNKS_HIGH_PRIORITY = 25;

/**
 * State for a single chunk worker
 */
interface WorkerState {
  worker: Worker;
  busy: boolean;
  isHighPriority: boolean;
}

/**
 * ChunkManager orchestrates chunk lifecycle, owns the worker pool,
 * and coordinates between TerrainGenerator and RockManager.
 */
export class ChunkManager {
  private chunks: Map<string, Chunk> = new Map();
  private requestQueue: ChunkRequestQueue;
  private workers: WorkerState[] = [];
  private inFlight: Set<string> = new Set(); // "gridKey:lodLevel"
  private hpWorkerKeys: Set<string> = new Set(); // Nearest 9 chunks for HP worker
  private scene: Scene;
  private config: ChunkConfig;
  private terrainGenerator: TerrainGenerator;
  private rockManager: RockManager;
  private rockGenerationConfig: RockGenerationConfig;
  private baseTerrainArgs: Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'>;
  private camera: Camera | null = null;
  private cameraForward: Vector3 = new Vector3();
  // Reusable vector for rock bounding sphere world-space center (avoids per-rock allocation)
  private readonly rockWorldCenter: Vector3 = new Vector3();
  private debugMode: boolean = false;
  private collisionLodLevel: number = 0;
  /** Last known terrain height (world Y) under the camera, for LOD distances */
  private cameraTerrainY: number = 0;
  private requestRender: () => void;

  constructor(
    scene: Scene,
    config: ChunkConfig,
    terrainGenerator: TerrainGenerator,
    rockManager: RockManager,
    rockGenerationConfig: RockGenerationConfig,
    craterGenerationConfig: CraterGenerationConfig,
    requestRender: () => void
  ) {
    this.scene = scene;
    this.config = config;
    this.terrainGenerator = terrainGenerator;
    this.rockManager = rockManager;
    this.rockGenerationConfig = rockGenerationConfig;
    this.requestRender = requestRender;
    this.debugMode = config.debugWireframe ?? false;

    // Base terrain args (without position/resolution - those are per-request)
    this.baseTerrainArgs = {
      // Noise parameters for lunar terrain
      seed: 0,
      gain: 0.5,
      lacunarity: 2,               // Octave wavelengths span ~67m down to ~8m, keeping the surface smooth (craters/rocks add fine detail)
      frequency: 0.015,            // Low frequency for broad lunar features
      amplitude: 1.0,              // Gentle height variation
      altitude: 0.1,
      octaves: 4,                  // Few octaves for smooth terrain (craters add detail)
      smoothLowerPlanes: 0,
      
      // Chunk dimensions
      width: config.chunkWidth,
      depth: config.chunkDepth,
      renderDistance: config.renderDistance,
      
      // Crater generation parameters
      craterSeed: craterGenerationConfig.seed,
      craterDensity: craterGenerationConfig.density,
      craterMinRadius: craterGenerationConfig.minRadius,
      craterMaxRadius: craterGenerationConfig.maxRadius,
      craterPowerLawExponent: craterGenerationConfig.powerLawExponent,
      craterDepthRatio: craterGenerationConfig.depthRatio,
      craterRimHeight: craterGenerationConfig.rimHeight,
      craterRimWidth: craterGenerationConfig.rimWidth,
      craterFloorFlatness: craterGenerationConfig.floorFlatness,
    };

    this.requestQueue = new ChunkRequestQueue({
      chunkWidth: config.chunkWidth,
      chunkDepth: config.chunkDepth,
    });

    this.setupWorkers();

    // Identify the LOD level closest to resolution 32 for collision detection
    this.collisionLodLevel = this.findCollisionLodLevel(32);
  }

  /**
   * Find the LOD level index closest to target resolution
   */
  private findCollisionLodLevel(targetResolution: number): number {
    let closestIndex = 0;
    let minDiff = Infinity;

    for (let i = 0; i < this.config.lodLevels.length; i++) {
      const diff = Math.abs(this.config.lodLevels[i] - targetResolution);
      if (diff <= minDiff) {
        minDiff = diff;
        closestIndex = i;
      }
    }
    return closestIndex;
  }

  /**
   * Set camera reference for LOD updates
   */
  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  /**
   * Compute the distance threshold for a given LOD level.
   */
  private computeLodDistance(lodLevel: number): number {
    if (lodLevel === 0) {
      return 0;
    }

    const finerLodIndex = lodLevel - 1;
    const finerResolution = this.config.lodLevels[finerLodIndex];
    const edgeLength = this.config.chunkWidth / (finerResolution - 1);

    const fov = (this.camera as PerspectiveCamera)?.fov ?? 70;
    const fovRadians = (fov * Math.PI) / 180;
    const screenHeight = window.innerHeight;
    const tanHalfFov = Math.tan(fovRadians / 2);
    const tiltFactor = Math.cos(Math.PI / 12);

    const targetPixels = this.config.lodDetailLevel;
    const distance = (edgeLength * screenHeight * tiltFactor) / (2 * targetPixels * tanHalfFov);

    return distance;
  }

  private setupWorkers(): void {
    // Use hardwareConcurrency if available, with reasonable defaults and caps
    const defaultWorkerCount = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? Math.max(2, Math.min(navigator.hardwareConcurrency - 1, 8)) // Leave 1 core for main thread, cap at 8
      : 3; // Fallback for browsers without hardwareConcurrency
    
    const count = Math.max(1, this.config.workerCount ?? defaultWorkerCount);

    for (let i = 0; i < count; i++) {
      const worker = new Worker(
        new URL('./ChunkWorker.ts', import.meta.url),
        { type: 'module' }
      );

      worker.onmessage = (e: MessageEvent<ChunkWorkerResult>) => {
        this.handleWorkerResult(e.data, i);
      };

      this.workers.push({
        worker,
        busy: false,
        isHighPriority: i === 0,
      });
    }
  }

  /**
   * Handle chunk data from worker
   */
  private handleWorkerResult(result: ChunkWorkerResult, workerIndex: number): void {
    const { gridKey, lodLevel } = result;

    // Worker is no longer busy
    this.workers[workerIndex].busy = false;

    // Clear from in-flight
    const requestKey = `${gridKey}:${lodLevel}`;
    this.inFlight.delete(requestKey);

    // Ignore results for chunks that are no longer wanted (pruned while the
    // build was in flight). Re-creating them here would resurrect zombie
    // chunks that get disposed again on the next update.
    const chunk = this.chunks.get(gridKey);
    if (!chunk) {
      this.dispatchNext();
      return;
    }

    // Create terrain mesh via TerrainGenerator
    const terrainMesh = this.terrainGenerator.createTerrainMesh(result, this.debugMode, gridKey);

    // Store original indices for edge stitching. The same array the geometry
    // wraps is stored: stitching swaps in separately cached index arrays and
    // never mutates this one, so no defensive copy is needed.
    this.terrainGenerator.storeOriginalIndices(gridKey, lodLevel, result.index);

    // Add terrain mesh to chunk
    const distance = this.computeLodDistance(lodLevel);
    chunk.addTerrainMesh(terrainMesh, lodLevel, distance);
    this.requestRender();

    // Replace any existing rock meshes for this LOD level so a repeated
    // result never leaves duplicated rock instances behind
    chunk.clearRockMeshes(lodLevel);

    // Create rock meshes via RockManager (if placements exist)
    if (result.rockPlacements && result.rockPlacements.length > 0) {
      const rockMeshes = this.rockManager.createRockMeshes(result.rockPlacements, lodLevel);
      for (const rockMesh of rockMeshes) {
        chunk.addRockMesh(rockMesh, lodLevel);
        
        // Apply debug material if debug mode is active
        if (this.debugMode) {
          rockMesh.material = new MeshBasicMaterial({ 
            wireframe: true, 
            color: this.generateChunkColor(gridKey) 
          });
        }
      }
      this.requestRender();
    }

    // Dispatch next request from queue
    this.dispatchNext();
  }

  /**
   * Generate a color from a grid key (for debug visualization)
   */
  private generateChunkColor(gridKey: string): Color {
    let hash = 0;
    for (let i = 0; i < gridKey.length; i++) {
      hash = gridKey.charCodeAt(i) + ((hash << 5) - hash);
    }

    const r = ((hash & 0xFF0000) >> 16) % 200 + 55;
    const g = ((hash & 0x00FF00) >> 8) % 200 + 55;
    const b = (hash & 0x0000FF) % 200 + 55;

    return new Color(r / 255, g / 255, b / 255);
  }

  /**
   * Toggle debug wireframe mode
   */
  toggleDebugMode(): void {
    this.debugMode = !this.debugMode;

    // Update all existing terrain meshes
    for (const [gridKey, chunk] of this.chunks.entries()) {
      for (let lodLevel = 0; lodLevel < chunk.getLodLevelCount(); lodLevel++) {
        const mesh = chunk.getTerrainMesh(lodLevel);
        if (mesh) {
          const oldMaterial = mesh.material;

          // Only dispose debug materials (MeshBasicMaterial), never the shared MoonMaterial
          if (oldMaterial instanceof MeshBasicMaterial) {
            oldMaterial.dispose();
          }

          // Create new material
          mesh.material = this.debugMode
            ? new MeshBasicMaterial({ wireframe: true, color: this.generateChunkColor(gridKey) })
            : this.terrainGenerator.getMaterial();
        }
      }
    }

    // Update all existing rock meshes
    for (const [gridKey, chunk] of this.chunks.entries()) {
      for (let lodLevel = 0; lodLevel < chunk.getLodLevelCount(); lodLevel++) {
        const rockMeshes = chunk.getRockMeshes(lodLevel);
        for (const rockMesh of rockMeshes) {
          const oldMaterial = rockMesh.material;

          // Only dispose debug materials (MeshBasicMaterial), never the shared MoonMaterial
          if (oldMaterial instanceof MeshBasicMaterial) {
            oldMaterial.dispose();
          }

          // Create new material
          rockMesh.material = this.debugMode
            ? new MeshBasicMaterial({ wireframe: true, color: this.generateChunkColor(gridKey) })
            : this.rockManager.getMaterial();
        }
      }
    }

    console.log(`Debug wireframe mode: ${this.debugMode ? 'ON' : 'OFF'}`);
    this.requestRender();
  }

  /**
   * Create a new chunk
   */
  private createChunk(gridKey: string): Chunk {
    const [gridX, gridZ] = parseGridKey(gridKey);
    const worldX = gridX * this.config.chunkWidth;
    const worldZ = gridZ * this.config.chunkDepth;

    const chunk = new Chunk(gridKey, worldX, worldZ, this.config.lodLevels.length);
    chunk.addToScene(this.scene);
    this.requestRender();

    return chunk;
  }

  /**
   * Request a specific LOD level for a chunk (adds to priority queue)
   */
  private requestChunkLod(gridKey: string, lodLevel: number): void {
    if (this.requestQueue.has(gridKey, lodLevel)) {
      return;
    }

    // Already being built by a worker - don't re-queue it
    if (this.inFlight.has(`${gridKey}:${lodLevel}`)) {
      return;
    }

    const chunk = this.chunks.get(gridKey);
    if (chunk?.hasLodLevel(lodLevel)) {
      return;
    }

    const [gridX, gridZ] = parseGridKey(gridKey);
    const resolution = this.config.lodLevels[lodLevel] ?? this.config.lodLevels[0];

    const args: TerrainArgs = {
      ...this.baseTerrainArgs,
      resolution,
      posX: gridX * this.config.chunkWidth,
      posZ: gridZ * this.config.chunkDepth,
    };

    this.requestQueue.add({ gridKey, lodLevel, terrainArgs: args });
  }

  /**
   * Base terrain generation args shared by every chunk request (noise,
   * dimensions, crater params — everything except per-chunk
   * resolution/posX/posZ). Used by the lander mode's terrain height
   * sampler and deterministic rock queries so they can never drift from
   * the meshes the workers build.
   */
  getBaseTerrainArgs(): Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'> {
    return { ...this.baseTerrainArgs };
  }

  /**
   * Pop queued requests until one is still worth building.
   * Drops requests whose chunk has been pruned or already has the LOD built
   * (e.g. a duplicate queued while the same build was in flight).
   */
  private takeNextValidRequest(isHighPriority: boolean): QueuedRequest | undefined {
    for (;;) {
      const request = isHighPriority
        ? this.requestQueue.shiftMatching(this.hpWorkerKeys, this.inFlight) || this.requestQueue.shiftAny(this.inFlight)
        : this.requestQueue.shiftAny(this.inFlight);

      if (!request) {
        return undefined;
      }

      const chunk = this.chunks.get(request.gridKey);
      if (!chunk || chunk.hasLodLevel(request.lodLevel)) {
        continue;
      }

      return request;
    }
  }

  /**
   * Dispatch next highest-priority requests to idle workers
   */
  private dispatchNext(): void {
    for (const workerState of this.workers) {
      if (workerState.busy) {
        continue;
      }

      const request = this.takeNextValidRequest(workerState.isHighPriority);

      if (request) {
        const key = `${request.gridKey}:${request.lodLevel}`;
        this.inFlight.add(key);
        workerState.busy = true;

        // Get stable axes for this LOD level
        const detail = RockManager.getDetailForLod(
          request.lodLevel,
          this.config.chunkWidth,
          this.config.chunkDepth,
          this.config.lodLevels
        );
        const stableAxes = this.rockManager.getStableAxesForDetail(detail);
        
        // Flatten stable axes array to Float32Array [x1, y1, z1, x2, y2, z2, ...]
        let stableAxesFlat: Float32Array | undefined;
        if (stableAxes) {
          stableAxesFlat = new Float32Array(stableAxes.length * 3);
          for (let i = 0; i < stableAxes.length; i++) {
            stableAxesFlat[i * 3] = stableAxes[i].x;
            stableAxesFlat[i * 3 + 1] = stableAxes[i].y;
            stableAxesFlat[i * 3 + 2] = stableAxes[i].z;
          }
        }

        const message = {
          terrainArgs: request.terrainArgs,
          gridKey: request.gridKey,
          lodLevel: request.lodLevel,
          rockLibrarySize: this.rockManager.getLibrarySize(),
          rockConfig: this.rockGenerationConfig,
          stableAxes: stableAxesFlat,
        };

        // Transfer the freshly built stableAxes buffer instead of cloning it
        if (stableAxesFlat) {
          workerState.worker.postMessage(message, [stableAxesFlat.buffer]);
        } else {
          workerState.worker.postMessage(message);
        }
      }
    }
  }

  private getNearbyChunkPositionKeys(center: Vector3, radius: number): string[] {
    const keys: { key: string; distance: number }[] = [];
    const cx = Math.round(center.x);
    const cz = Math.round(center.z);
    const r = Math.ceil(radius);

    for (let x = cx - r; x <= cx + r; x++) {
      for (let z = cz - r; z <= cz + r; z++) {
        const dx = x - center.x;
        const dz = z - center.z;
        const distance = Math.sqrt(dx * dx + dz * dz);
        if (distance <= radius) {
          keys.push({ key: `${x},${z}`, distance });
        }
      }
    }
    keys.sort((a, b) => a.distance - b.distance);
    return keys.map((k) => k.key);
  }

  /**
   * Determine which LOD level a chunk should use based on screen-space triangle size.
   */
  private getLodLevelForChunkOptimized(
    gridKey: string,
    cameraWorldPos: Vector3,
    fovRadians: number,
    screenHeight: number
  ): number {
    const [gridX, gridZ] = parseGridKey(gridKey);
    const distance = getDistanceToChunk(
      cameraWorldPos.x,
      cameraWorldPos.y,
      cameraWorldPos.z,
      gridX,
      gridZ,
      this.config.chunkWidth,
      this.config.chunkDepth,
      this.cameraTerrainY
    );

    return getLodLevelForScreenSize(
      distance,
      this.config.lodLevels,
      this.config.chunkWidth,
      fovRadians,
      screenHeight,
      this.config.lodDetailLevel
    );
  }

  /**
   * Update terrain based on camera position
   */
  update(cameraPosition: Vector3): void {
    if (this.camera) {
      this.camera.getWorldDirection(this.cameraForward);
    }

    // Track the terrain height under the camera so LOD distances measure
    // altitude above the terrain instead of distance to the Y=0 plane
    // (which would bias LOD coarser when flying low over elevated terrain).
    // Keeps the last known height while the chunk under the camera loads.
    const terrainY = this.getHeightAt(cameraPosition.x, cameraPosition.z);
    if (terrainY !== null) {
      this.cameraTerrainY = terrainY;
    }

    const camPosInGrid = cameraPosition.clone();
    camPosInGrid.x /= this.config.chunkWidth;
    camPosInGrid.z /= this.config.chunkDepth;
    camPosInGrid.y = 0;

    const renderDistance = Math.floor(this.config.renderDistance);
    const nearbyKeys = this.getNearbyChunkPositionKeys(camPosInGrid, renderDistance);
    const nearbySet = new Set(nearbyKeys);

    this.requestQueue.pruneStale(nearbySet);

    const fov = (this.camera as PerspectiveCamera)?.fov ?? 70;
    const fovRadians = (fov * Math.PI) / 180;
    const screenHeight = window.innerHeight;

    for (const gridKey of nearbyKeys) {
      const desiredLod = this.getLodLevelForChunkOptimized(
        gridKey,
        cameraPosition,
        fovRadians,
        screenHeight
      );

      if (!this.chunks.has(gridKey)) {
        const chunk = this.createChunk(gridKey);
        this.chunks.set(gridKey, chunk);
      }

      const chunk = this.chunks.get(gridKey);
      if (!chunk) {
        continue; // Skip if chunk creation failed
      }

      if (!chunk.hasLodLevel(this.collisionLodLevel)) {
        this.requestChunkLod(gridKey, this.collisionLodLevel);
      }

      if (!chunk.hasLodLevel(desiredLod)) {
        this.requestChunkLod(gridKey, desiredLod);
      }

      const coarsestLod = this.config.lodLevels.length - 1;
      if (!chunk.hasLodLevel(coarsestLod)) {
        this.requestChunkLod(gridKey, coarsestLod);
      }

      if (desiredLod > 0 && !chunk.hasLodLevel(desiredLod - 1)) {
        this.requestChunkLod(gridKey, desiredLod - 1);
      }
      if (desiredLod < this.config.lodLevels.length - 1 && !chunk.hasLodLevel(desiredLod + 1)) {
        this.requestChunkLod(gridKey, desiredLod + 1);
      }
    }

    this.hpWorkerKeys = new Set(nearbyKeys.slice(0, HP_WORKER_TARGET_CHUNKS));

    const nearestHighPriorityKeys = new Set(nearbyKeys.slice(0, NEAREST_CHUNKS_HIGH_PRIORITY));
    const maxLodLevel = this.config.lodLevels.length - 1;
    this.requestQueue.sort(cameraPosition, this.cameraForward, nearestHighPriorityKeys, maxLodLevel);

    this.dispatchNext();

    const chunkLodLevels = this.updateChunkVisibility(cameraPosition, fovRadians, screenHeight);
    this.updateRockVisibility(cameraPosition, fovRadians, screenHeight);
    this.updateEdgeStitching(chunkLodLevels);

    this.evictStaleLodLevels(cameraPosition, fovRadians, screenHeight);

    // Update rock material uniforms (curvature)
    this.updateRockMaterialUniforms(cameraPosition);

    for (const gridKey of this.chunks.keys()) {
      if (!nearbySet.has(gridKey)) {
        this.removeChunk(gridKey);
      }
    }
  }

  /**
   * Update rock material uniforms per-frame for curvature.
   * Syncs enableCurvature and planetRadius from terrain material.
   * Note: cameraPosition is automatically provided by Three.js.
   */
  private updateRockMaterialUniforms(cameraPosition: Vector3): void {
    const rockMaterial = this.rockManager.getMaterial();

    // Sync curvature settings from terrain material
    const terrainMaterial = this.terrainGenerator.getMaterial();
    const enableCurvature = terrainMaterial.getParam('enableCurvature');
    const planetRadius = terrainMaterial.getParam('planetRadius');

    rockMaterial.setParam('enableCurvature', enableCurvature);
    rockMaterial.setParam('planetRadius', planetRadius);

    // Tighten per-mesh rock culling bounds from the actual camera distance
    // (the curvature drop the shader applies depends on it)
    this.rockManager.updateCullingBounds(cameraPosition);
  }

  /**
   * Update mesh visibility for all chunks.
   */
  private updateChunkVisibility(
    cameraPosition: Vector3,
    fovRadians: number,
    screenHeight: number
  ): Map<string, number> {
    const chunkLodLevels = new Map<string, number>();

    for (const [gridKey, chunk] of this.chunks.entries()) {
      const desiredLod = this.getLodLevelForChunkOptimized(
        gridKey,
        cameraPosition,
        fovRadians,
        screenHeight
      );

      const actualLod = chunk.findBestAvailableLod(desiredLod);
      chunk.setLodLevel(actualLod);
      chunkLodLevels.set(gridKey, actualLod);
    }

    return chunkLodLevels;
  }

  /**
   * Update rock visibility based on bounding sphere screen space size.
   * Rocks are shown when their bounding sphere diameter is >= 4 pixels (LodDetailLevel.Balanced).
   */
  private updateRockVisibility(
    cameraPosition: Vector3,
    fovRadians: number,
    screenHeight: number
  ): void {
    const minScreenSize = this.config.lodDetailLevel; // LodDetailLevel.Balanced = 4 pixels

    for (const chunk of this.chunks.values()) {
      // Iterate through all LOD levels
      for (let lodLevel = 0; lodLevel < chunk.getLodLevelCount(); lodLevel++) {
        const rockMeshes = chunk.getRockMeshes(lodLevel);
        
        for (const rockMesh of rockMeshes) {
          // Ensure bounding sphere is computed
          if (!rockMesh.boundingSphere) {
            rockMesh.computeBoundingSphere();
          }

          if (!rockMesh.boundingSphere) {
            // No bounding sphere available, hide the mesh
            rockMesh.visible = false;
            continue;
          }

          // Transform bounding sphere center to world space (reusable vector)
          const worldCenter = this.rockWorldCenter
            .copy(rockMesh.boundingSphere.center)
            .applyMatrix4(rockMesh.matrixWorld);
          
          // Calculate distance from camera to bounding sphere center in world space
          const dx = cameraPosition.x - worldCenter.x;
          const dy = cameraPosition.y - worldCenter.y;
          const dz = cameraPosition.z - worldCenter.z;
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);

          // Calculate screen space size of bounding sphere diameter
          const diameter = rockMesh.boundingSphere.radius * 2;
          const screenSize = projectToScreenSpace(diameter, distance, fovRadians, screenHeight);

          // Show rock if bounding sphere diameter is >= threshold
          rockMesh.visible = screenSize >= minScreenSize;
        }
      }
    }
  }

  /**
   * Update edge stitching for chunks that have LOD mismatches with neighbors.
   */
  private updateEdgeStitching(chunkLodLevels: Map<string, number>): void {
    for (const [gridKey, chunk] of this.chunks.entries()) {
      const myLod = chunk.currentLodLevel;
      const [gridX, gridZ] = parseGridKey(gridKey);
      const neighbors = getNeighborKeys(gridX, gridZ);

      const neighborLods: NeighborLods = {
        north: chunkLodLevels.get(neighbors.north) ?? myLod,
        south: chunkLodLevels.get(neighbors.south) ?? myLod,
        east: chunkLodLevels.get(neighbors.east) ?? myLod,
        west: chunkLodLevels.get(neighbors.west) ?? myLod,
      };

      const mesh = chunk.getTerrainMesh(myLod);
      if (mesh) {
        this.terrainGenerator.applyEdgeStitching(
          gridKey,
          mesh,
          myLod,
          neighborLods,
          this.config.lodLevels
        );
      }
    }
  }

  /**
   * Evict built LOD levels that are no longer needed, freeing GPU memory.
   *
   * For each chunk, a retained set of levels is kept and everything else is
   * disposed:
   * - desired level and desired±1 (matches what update() prefetches)
   * - the currently displayed level (never evict a visible mesh)
   * - the collision LOD level (getHeightAt relies on it)
   * - the coarsest level (cheap, always-available fallback)
   *
   * Evicted levels are rebuilt on demand if the camera comes back.
   */
  private evictStaleLodLevels(
    cameraPosition: Vector3,
    fovRadians: number,
    screenHeight: number
  ): void {
    const coarsestLod = this.config.lodLevels.length - 1;

    for (const [gridKey, chunk] of this.chunks.entries()) {
      const desiredLod = this.getLodLevelForChunkOptimized(
        gridKey,
        cameraPosition,
        fovRadians,
        screenHeight
      );

      const retained = new Set<number>([
        desiredLod,
        desiredLod - 1,
        desiredLod + 1,
        chunk.currentLodLevel,
        this.collisionLodLevel,
        coarsestLod,
      ]);

      // Copy: removeLodLevel mutates builtLevels while we iterate
      for (const lodLevel of [...chunk.builtLevels]) {
        if (retained.has(lodLevel)) {
          continue;
        }

        chunk.removeLodLevel(lodLevel);
        this.terrainGenerator.clearStitchingData(gridKey, lodLevel);
      }
    }
  }

  /**
   * Remove a chunk and clean up its resources
   */
  private removeChunk(gridKey: string): void {
    const chunk = this.chunks.get(gridKey);
    if (!chunk) return;

    chunk.removeFromScene(this.scene);
    chunk.dispose();

    // Clear stitching data
    this.terrainGenerator.clearStitchingData(gridKey);

    this.chunks.delete(gridKey);
  }

  /**
   * Get a chunk by grid key (for physics system)
   */
  getChunk(gridKey: string): Chunk | undefined {
    return this.chunks.get(gridKey);
  }

  /**
   * Get number of active chunks
   */
  getActiveChunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Get total number of workers
   */
  getWorkerCount(): number {
    return this.workers.length;
  }

  /**
   * Get number of workers currently processing chunks
   */
  getActiveWorkerCount(): number {
    return this.workers.filter(w => w.busy).length;
  }

  /**
   * Get build queue length
   */
  getBuildQueueLength(): number {
    return this.requestQueue.length + this.getActiveWorkerCount();
  }

  /**
   * Get the height of the terrain at a given world (x, z) coordinate.
   */
  getHeightAt(x: number, z: number): number | null {
    const gridX = Math.round(x / this.config.chunkWidth);
    const gridZ = Math.round(z / this.config.chunkDepth);
    const gridKey = `${gridX},${gridZ}`;

    const chunk = this.chunks.get(gridKey);
    if (!chunk) return null;

    // Use collision LOD mesh if available
    let mesh = chunk.getTerrainMesh(this.collisionLodLevel);
    if (!mesh || !chunk.hasLodLevel(this.collisionLodLevel)) {
      // Fallback: use the finest available LOD mesh so collision queries
      // never run against a coarser mesh than necessary
      for (let i = 0; i < this.config.lodLevels.length; i++) {
        if (chunk.hasLodLevel(i)) {
          mesh = chunk.getTerrainMesh(i);
          break;
        }
      }
      if (!mesh) return null;
    }

    return this.terrainGenerator.raycastHeight(x, z, mesh);
  }

  /**
   * Check if the chunk at the given world position has the maximum LOD level (level 0) available.
   * @param x World X coordinate
   * @param z World Z coordinate
   * @returns true if chunk exists and has max LOD, false otherwise
   */
  hasMaxLodAt(x: number, z: number): boolean {
    const gridX = Math.round(x / this.config.chunkWidth);
    const gridZ = Math.round(z / this.config.chunkDepth);
    const gridKey = `${gridX},${gridZ}`;

    const chunk = this.chunks.get(gridKey);
    if (!chunk) return false;

    // Check if chunk has max LOD (level 0)
    return chunk.hasLodLevel(0);
  }

  /**
   * Debug: Log distance and LOD information for all chunks
   */
  logChunkDistancesAndLods(cameraPosition: Vector3): void {
    if (!this.camera) {
      console.warn('Cannot log chunk distances: camera not set');
      return;
    }

    const fov = (this.camera as PerspectiveCamera)?.fov ?? 70;
    const fovRadians = (fov * Math.PI) / 180;
    const screenHeight = window.innerHeight;

    const chunkData: Array<{
      gridKey: string;
      distance: number;
      desiredLod: number;
      currentLod: number;
    }> = [];

    for (const [gridKey, chunk] of this.chunks.entries()) {
      const [gridX, gridZ] = parseGridKey(gridKey);

      const distance = getDistanceToChunk(
        cameraPosition.x,
        cameraPosition.y,
        cameraPosition.z,
        gridX,
        gridZ,
        this.config.chunkWidth,
        this.config.chunkDepth,
        this.cameraTerrainY
      );

      const desiredLod = this.getLodLevelForChunkOptimized(
        gridKey,
        cameraPosition,
        fovRadians,
        screenHeight
      );

      chunkData.push({
        gridKey,
        distance,
        desiredLod,
        currentLod: chunk.currentLodLevel,
      });
    }

    chunkData.sort((a, b) => a.distance - b.distance);

    console.log('=== Chunk Distance & LOD Debug ===');
    console.log('Grid Key | Distance (m) | Desired LOD | Current LOD | Match');
    console.log('---------|--------------|-------------|-------------|------');

    for (const data of chunkData) {
      const match = data.desiredLod === data.currentLod ? '✓' : '✗';
      const matchColor = data.desiredLod === data.currentLod ? '' : 'color: orange';
      console.log(
        `%c${data.gridKey.padEnd(9)} | ${data.distance.toFixed(2).padStart(12)} | ${String(data.desiredLod).padStart(11)} | ${String(data.currentLod).padStart(11)} | ${match}`,
        matchColor
      );
    }

    const mismatches = chunkData.filter(d => d.desiredLod !== d.currentLod);
    console.log(`\nTotal chunks: ${chunkData.length}`);
    console.log(`Mismatches: ${mismatches.length}`);
  }

  /**
   * Get the terrain material (for UI control)
   */
  getMaterial() {
    return this.terrainGenerator.getMaterial();
  }

  /**
   * Update sun direction for horizon occlusion calculation
   * Should be called each frame with the current sun direction in world space
   * Applies to both terrain and rocks
   * 
   * @param direction Sun direction vector (normalized, in world space)
   */
  setSunDirection(direction: Vector3): void {
    this.terrainGenerator.setSunDirection(direction);
    this.rockManager.setSunDirection(direction);
  }

  /**
   * Set sun horizon fade factor
   * Should be called each frame with the current horizon fade (0 = below horizon, 1 = above horizon)
   * Applies to both terrain and rocks
   * 
   * @param fade Horizon fade factor (0-1)
   */
  setSunHorizonFade(fade: number): void {
    this.terrainGenerator.setSunHorizonFade(fade);
    this.rockManager.setSunHorizonFade(fade);
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    for (const workerState of this.workers) {
      workerState.worker.terminate();
    }
    this.workers = [];

    for (const gridKey of this.chunks.keys()) {
      this.removeChunk(gridKey);
    }

    this.chunks.clear();
    this.requestQueue.clear();
    this.inFlight.clear();
    this.terrainGenerator.dispose();
    this.rockManager.dispose();
  }
}
