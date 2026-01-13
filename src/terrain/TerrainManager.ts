import { BufferAttribute, BufferGeometry, LOD, Mesh, Scene, Vector3, Camera, MeshBasicMaterial, Color, PerspectiveCamera } from 'three';
import { MoonMaterial } from '../shaders/MoonMaterial';
import type { TerrainArgs } from './terrain';
import type { TerrainWorkerResult } from './TerrainWorker';
import { 
  getNeighborKeys, 
  parseGridKey,
  getDistanceToChunk,
  getLodLevelForScreenSize,
  LodDetailLevel,
  type NeighborLods 
} from './LodUtils';
import { computeStitchedIndices } from './EdgeStitcher';
import { ChunkRequestQueue } from './ChunkRequestQueue';

export interface TerrainConfig {
  renderDistance: number;
  chunkWidth: number;
  chunkDepth: number;
  /** Resolution levels from highest to lowest, e.g. [512, 256, 128, 64] */
  lodLevels: number[];
  /** Target screen-space triangle size for LOD selection */
  lodDetailLevel: LodDetailLevel;
  /** Debug mode: render wireframe triangles with different color per chunk */
  debugWireframe?: boolean;
}

/**
 * Number of nearest chunks that get highest priority regardless of camera direction
 */
const NEAREST_CHUNKS_HIGH_PRIORITY = 10;

/**
 * Entry for a chunk with LOD support
 */
interface ChunkLodEntry {
  /** THREE.LOD object containing all mesh levels */
  lod: LOD;
  /** Meshes at each LOD level (index matches lodLevels) */
  meshes: (Mesh | null)[];
  /** Track which LOD levels have been built */
  builtLevels: Set<number>;
  /** Current active LOD level (for edge stitching) */
  currentLodLevel: number;
  /** Original index buffers before stitching (for restoration) */
  originalIndices: (Uint32Array | null)[];
}

export class TerrainManager {
  private terrainGrid: Map<string, ChunkLodEntry> = new Map();
  private requestQueue: ChunkRequestQueue;
  private workerBusy: boolean = false;
  private material: MoonMaterial;
  private worker: Worker;
  private scene: Scene;
  private config: TerrainConfig;
  private baseTerrainArgs: Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'>;
  private camera: Camera | null = null;
  private cameraForward: Vector3 = new Vector3();
  private debugMode: boolean = false;

  constructor(scene: Scene, config: TerrainConfig) {
    this.scene = scene;
    this.config = config;
    this.debugMode = config.debugWireframe ?? false;
    // Single shared material instance for all chunks (critical for performance)
    this.material = new MoonMaterial();

    // Base terrain args (without position/resolution - those are per-request)
    this.baseTerrainArgs = {
      seed: 0,
      gain: 0.5,
      lacunarity: 2,
      frequency: 0.07,
      amplitude: 0.5,
      altitude: 0.1,
      falloff: 0.0,
      erosion: 0.6,
      erosionSoftness: 0.3,
      rivers: 0.18,
      riverWidth: 0.35,
      riverFalloff: 0.06,
      lakes: 0.5,
      lakesFalloff: 0.5,
      riversFrequency: 0.13,
      smoothLowerPlanes: 0,
      octaves: 10,
      width: config.chunkWidth,
      depth: config.chunkDepth,
      renderDistance: config.renderDistance,
    };

    this.requestQueue = new ChunkRequestQueue({
      chunkWidth: config.chunkWidth,
      chunkDepth: config.chunkDepth,
    });

    this.worker = this.setupTerrainWorker();
  }

  /**
   * Set camera reference for LOD updates
   */
  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  /**
   * Compute the distance threshold for a given LOD level.
   * 
   * Traditional LOD: finest detail when close, coarser when far.
   * - LOD 0 (finest) at distance 0
   * - Coarser LODs at increasing distances
   */
  private computeLodDistance(lodLevel: number): number {
    // Finest LOD shows at distance 0
    if (lodLevel === 0) {
      return 0;
    }

    // For coarser LODs: compute distance where the PREVIOUS FINER LOD's
    // triangles fall below target pixels (time to switch to coarser)
    const finerLodIndex = lodLevel - 1;
    const finerResolution = this.config.lodLevels[finerLodIndex];
    const edgeLength = this.config.chunkWidth / (finerResolution - 1);
    
    // Get camera parameters
    const fov = (this.camera as PerspectiveCamera)?.fov ?? 70;
    const fovRadians = (fov * Math.PI) / 180;
    const screenHeight = window.innerHeight;
    const tanHalfFov = Math.tan(fovRadians / 2);
    const tiltFactor = Math.cos(Math.PI / 12); // 15 degrees

    // Solve for distance where finer LOD's triangles = targetPixels
    // At this distance, we can switch to the coarser LOD
    const targetPixels = this.config.lodDetailLevel;
    const distance = (edgeLength * screenHeight * tiltFactor) / (2 * targetPixels * tanHalfFov);

    return distance;
  }

  private setupTerrainWorker(): Worker {
    const worker = new Worker(
      new URL('./TerrainWorker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e: MessageEvent<TerrainWorkerResult>) => {
      this.handleWorkerResult(e.data);
    };

    return worker;
  }

  /**
   * Handle mesh data from worker
   */
  private handleWorkerResult(result: TerrainWorkerResult): void {
    const { positions, normals, index, biome, gridKey, lodLevel } = result;
    
    // Worker is no longer busy
    this.workerBusy = false;

    // Get or create chunk entry
    let entry = this.terrainGrid.get(gridKey);
    if (!entry) {
      entry = this.createChunkEntry(gridKey);
      this.terrainGrid.set(gridKey, entry);
    }

    // Create geometry
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(positions), 3)
    );
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array(normals), 3)
    );
    if (biome) {
      geometry.setAttribute(
        'biome',
        new BufferAttribute(new Float32Array(biome), 3)
      );
    }
    if (index) {
      geometry.setIndex(new BufferAttribute(new Uint32Array(index), 1));
      // Store original indices for stitching restoration
      entry.originalIndices[lodLevel] = new Uint32Array(index);
    }

    // Compute bounding sphere for correct frustum culling
    geometry.computeBoundingSphere();

    // Create mesh with appropriate material
    const material = this.debugMode 
      ? this.createDebugMaterial(gridKey)
      : this.material;
    const mesh = new Mesh(geometry, material);
    
    // Store mesh at this LOD level
    if (entry.meshes[lodLevel]) {
      // Dispose old mesh at this level
      entry.meshes[lodLevel]!.geometry.dispose();
      entry.lod.remove(entry.meshes[lodLevel]!);
    }
    
    entry.meshes[lodLevel] = mesh;
    entry.builtLevels.add(lodLevel);

    // Add to LOD object with computed distance threshold
    const distance = this.computeLodDistance(lodLevel);
    entry.lod.addLevel(mesh, distance);

    if (!this.debugMode) {
      this.material.needsUpdate = true;
    }

    // Dispatch next request from queue
    this.dispatchNext();
  }

  /**
   * Generate a color from a grid key (for debug visualization)
   */
  private generateChunkColor(gridKey: string): Color {
    // Simple hash function to generate consistent color from grid key
    let hash = 0;
    for (let i = 0; i < gridKey.length; i++) {
      hash = gridKey.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // Convert to RGB values (avoid too dark colors for visibility)
    const r = ((hash & 0xFF0000) >> 16) % 200 + 55;
    const g = ((hash & 0x00FF00) >> 8) % 200 + 55;
    const b = (hash & 0x0000FF) % 200 + 55;
    
    return new Color(r / 255, g / 255, b / 255);
  }

  /**
   * Create a debug material for a specific chunk
   */
  private createDebugMaterial(gridKey: string): MeshBasicMaterial {
    const color = this.generateChunkColor(gridKey);
    return new MeshBasicMaterial({ 
      wireframe: true, 
      color: color 
    });
  }

  /**
   * Toggle debug wireframe mode
   */
  toggleDebugMode(): void {
    this.debugMode = !this.debugMode;
    
    // Update all existing meshes
    for (const [gridKey, entry] of this.terrainGrid.entries()) {
      for (let lodLevel = 0; lodLevel < entry.meshes.length; lodLevel++) {
        const mesh = entry.meshes[lodLevel];
        if (mesh) {
          // Dispose old material
          if (mesh.material instanceof MeshBasicMaterial || mesh.material instanceof MoonMaterial) {
            (mesh.material as any).dispose?.();
          }
          
          // Create new material
          mesh.material = this.debugMode 
            ? this.createDebugMaterial(gridKey)
            : this.material;
        }
      }
    }
    
    console.log(`Debug wireframe mode: ${this.debugMode ? 'ON' : 'OFF'}`);
  }

  /**
   * Create a new chunk entry with LOD object
   */
  private createChunkEntry(gridKey: string): ChunkLodEntry {
    const [gridX, gridZ] = parseGridKey(gridKey);
    
    const lod = new LOD();
    lod.position.x = gridX * this.config.chunkWidth;
    lod.position.z = gridZ * this.config.chunkDepth;
    
    // Disable Three.js LOD auto-update - we manually control mesh visibility
    lod.autoUpdate = false;
    
    // Add LOD to scene
    this.scene.add(lod);

    return {
      lod,
      meshes: new Array(this.config.lodLevels.length).fill(null),
      builtLevels: new Set(),
      currentLodLevel: 0,
      originalIndices: new Array(this.config.lodLevels.length).fill(null),
    };
  }

  /**
   * Request a specific LOD level for a chunk (adds to priority queue)
   */
  private requestChunkLod(gridKey: string, lodLevel: number): void {
    // Already in queue?
    if (this.requestQueue.has(gridKey, lodLevel)) {
      return;
    }

    // Already built?
    const entry = this.terrainGrid.get(gridKey);
    if (entry?.builtLevels.has(lodLevel)) {
      return;
    }

    const [gridX, gridZ] = parseGridKey(gridKey);
    const resolution = this.config.lodLevels[lodLevel] ?? this.config.lodLevels[0];

    const args: TerrainArgs = {
      ...this.baseTerrainArgs,
      resolution,
      posX: gridX * this.config.chunkWidth / 25,
      posZ: gridZ * this.config.chunkDepth / 25,
    };

    // Add to priority queue (will be sorted and dispatched in update())
    this.requestQueue.add({ gridKey, lodLevel, terrainArgs: args });
  }

  /**
   * Dispatch the next highest-priority request to the worker
   */
  private dispatchNext(): void {
    if (this.workerBusy) {
      return;
    }

    const request = this.requestQueue.shift();
    if (request) {
      this.workerBusy = true;
      this.worker.postMessage({
        terrainArgs: request.terrainArgs,
        gridKey: request.gridKey,
        lodLevel: request.lodLevel,
      });
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
   * Optimized version that accepts pre-calculated camera parameters.
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
      this.config.chunkDepth
    );

    const desiredLod = getLodLevelForScreenSize(
      distance,
      this.config.lodLevels,
      this.config.chunkWidth,
      fovRadians,
      screenHeight,
      this.config.lodDetailLevel
    );

    return desiredLod;
  }

  /**
   * Update terrain based on camera position
   */
  update(cameraPosition: Vector3): void {
    // Get camera forward direction for priority calculation
    if (this.camera) {
      this.camera.getWorldDirection(this.cameraForward);
    }

    // Convert camera position to grid coordinates for chunk selection
    const camPosInGrid = cameraPosition.clone();
    camPosInGrid.x /= this.config.chunkWidth;
    camPosInGrid.z /= this.config.chunkDepth;
    camPosInGrid.y = 0;

    const renderDistance = Math.floor(this.config.renderDistance);

    // Get chunks that should be loaded
    const nearbyKeys = this.getNearbyChunkPositionKeys(camPosInGrid, renderDistance);
    const nearbySet = new Set(nearbyKeys);

    // Prune stale requests (chunks no longer in render distance)
    this.requestQueue.pruneStale(nearbySet);

    // Pre-calculate camera parameters once (don't recalculate thousands of times!)
    const fov = (this.camera as PerspectiveCamera)?.fov ?? 70;
    const fovRadians = (fov * Math.PI) / 180;
    const screenHeight = window.innerHeight;

    // Request chunks and their appropriate LOD levels
    for (const gridKey of nearbyKeys) {
      const desiredLod = this.getLodLevelForChunkOptimized(
        gridKey,
        cameraPosition,
        fovRadians,
        screenHeight
      );

      // Ensure chunk entry exists
      if (!this.terrainGrid.has(gridKey)) {
        const entry = this.createChunkEntry(gridKey);
        this.terrainGrid.set(gridKey, entry);
      }

      // Request the desired LOD level if not built
      const entry = this.terrainGrid.get(gridKey)!;
      if (!entry.builtLevels.has(desiredLod)) {
        this.requestChunkLod(gridKey, desiredLod);
      }

      // Also request adjacent LOD levels for smooth transitions
      // Request one level higher detail (lower index) and one lower detail (higher index)
      if (desiredLod > 0 && !entry.builtLevels.has(desiredLod - 1)) {
        this.requestChunkLod(gridKey, desiredLod - 1);
      }
      if (desiredLod < this.config.lodLevels.length - 1 && !entry.builtLevels.has(desiredLod + 1)) {
        this.requestChunkLod(gridKey, desiredLod + 1);
      }
    }

    // Get nearest chunks for highest priority
    const nearestHighPriorityKeys = new Set(
      nearbyKeys.slice(0, NEAREST_CHUNKS_HIGH_PRIORITY)
    );

    // Sort queue by priority (nearest chunks first, then distance + direction)
    this.requestQueue.sort(cameraPosition, this.cameraForward, nearestHighPriorityKeys);

    // Dispatch next request if worker is idle
    this.dispatchNext();

    // Manually control mesh visibility (bypasses Three.js LOD auto-switching)
    // Also returns actual LOD levels for reuse in edge stitching
    const chunkLodLevels = this.updateChunkVisibility(cameraPosition, fovRadians, screenHeight);

    // Track current LOD levels and update edge stitching (reuses LOD levels from visibility update)
    this.updateEdgeStitching(chunkLodLevels);

    // Remove distant chunks
    for (const gridKey of this.terrainGrid.keys()) {
      if (!nearbySet.has(gridKey)) {
        this.removeChunk(gridKey);
      }
    }
  }

  /**
   * Update mesh visibility for all chunks.
   * Manually controls which LOD mesh is visible, bypassing Three.js LOD auto-switching.
   * Shows the best available LOD (desired or next coarser if not built).
   * Returns a map of chunk keys to their actual LOD levels for reuse.
   */
  private updateChunkVisibility(
    cameraPosition: Vector3,
    fovRadians: number,
    screenHeight: number
  ): Map<string, number> {
    const chunkLodLevels = new Map<string, number>();
    
    for (const [gridKey, entry] of this.terrainGrid.entries()) {
      const desiredLod = this.getLodLevelForChunkOptimized(
        gridKey,
        cameraPosition,
        fovRadians,
        screenHeight
      );
      
      // Find best available LOD (desired or next coarser)
      let actualLod = desiredLod;
      if (!entry.builtLevels.has(actualLod)) {
        // Try coarser
        while (actualLod < this.config.lodLevels.length && !entry.builtLevels.has(actualLod)) {
          actualLod++;
        }
        
        // If no coarser LOD available, try finer
        if (actualLod >= this.config.lodLevels.length) {
          actualLod = desiredLod - 1;
          while (actualLod >= 0 && !entry.builtLevels.has(actualLod)) {
            actualLod--;
          }
        }
      }
      
      if (actualLod < 0 || actualLod >= this.config.lodLevels.length) {
        actualLod = entry.builtLevels.values().next().value ?? 0;
      }
      
      // Store actual LOD level for reuse
      entry.currentLodLevel = actualLod;
      chunkLodLevels.set(gridKey, actualLod);
      
      // Set visibility: only the actual LOD mesh is visible
      for (let i = 0; i < entry.meshes.length; i++) {
        const mesh = entry.meshes[i];
        if (mesh) {
          mesh.visible = (i === actualLod);
        }
      }
    }
    
    return chunkLodLevels;
  }

  /**
   * Update edge stitching for chunks that have LOD mismatches with neighbors.
   * Reuses LOD levels from updateChunkVisibility to avoid recalculating.
   */
  private updateEdgeStitching(chunkLodLevels: Map<string, number>): void {
    // Update edge stitching where needed
    for (const [gridKey, entry] of this.terrainGrid.entries()) {
      const myLod = entry.currentLodLevel;
      const [gridX, gridZ] = parseGridKey(gridKey);
      const neighbors = getNeighborKeys(gridX, gridZ);

      // Get neighbor LOD levels (default to same level if neighbor doesn't exist)
      const neighborLods: NeighborLods = {
        north: chunkLodLevels.get(neighbors.north) ?? myLod,
        south: chunkLodLevels.get(neighbors.south) ?? myLod,
        east: chunkLodLevels.get(neighbors.east) ?? myLod,
        west: chunkLodLevels.get(neighbors.west) ?? myLod,
      };

      // Update stitching for the current LOD mesh
      this.applyEdgeStitching(entry, myLod, neighborLods);
    }
  }

  /**
   * Apply edge stitching to a specific LOD level of a chunk
   */
  private applyEdgeStitching(
    entry: ChunkLodEntry,
    lodLevel: number,
    neighborLods: NeighborLods
  ): void {
    const mesh = entry.meshes[lodLevel];
    if (!mesh) return;

    const resolution = this.config.lodLevels[lodLevel];
    if (!resolution) return;

    // Check if stitching is needed (any neighbor has lower resolution = higher LOD index)
    const needsStitching = 
      neighborLods.north > lodLevel ||
      neighborLods.south > lodLevel ||
      neighborLods.east > lodLevel ||
      neighborLods.west > lodLevel;

    if (!needsStitching) {
      // Restore original indices if we have them
      const original = entry.originalIndices[lodLevel];
      if (original && mesh.geometry.index) {
        mesh.geometry.setIndex(new BufferAttribute(original.slice(), 1));
      }
      return;
    }

    // Compute stitched indices
    const stitchedIndices = computeStitchedIndices(
      resolution,
      neighborLods,
      lodLevel,
      this.config.lodLevels
    );

    // Apply to geometry
    mesh.geometry.setIndex(new BufferAttribute(stitchedIndices, 1));
  }

  /**
   * Remove a chunk and clean up its resources
   */
  private removeChunk(gridKey: string): void {
    const entry = this.terrainGrid.get(gridKey);
    if (!entry) return;

    // Remove LOD from scene
    this.scene.remove(entry.lod);

    // Dispose all mesh geometries
    for (const mesh of entry.meshes) {
      if (mesh) {
        mesh.geometry.dispose();
      }
    }

    // Note: Queue pruning handles removing stale requests

    this.terrainGrid.delete(gridKey);
  }

  /**
   * Get number of active chunks
   */
  getActiveChunkCount(): number {
    return this.terrainGrid.size;
  }

  /**
   * Get build queue length
   */
  getBuildQueueLength(): number {
    return this.requestQueue.length + (this.workerBusy ? 1 : 0);
  }

  /**
   * Get the material instance (for UI control)
   */
  getMaterial(): MoonMaterial {
    return this.material;
  }

  /**
   * Debug: Log distance and LOD information for all chunks
   * Helps identify distance calculation problems causing inconsistent LODs
   */
  logChunkDistancesAndLods(cameraPosition: Vector3): void {
    if (!this.camera) {
      console.warn('Cannot log chunk distances: camera not set');
      return;
    }

    // Pre-calculate camera parameters (same as in updateChunkVisibility)
    const fov = (this.camera as PerspectiveCamera)?.fov ?? 70;
    const fovRadians = (fov * Math.PI) / 180;
    const screenHeight = window.innerHeight;

    // Collect chunk data
    const chunkData: Array<{
      gridKey: string;
      distance: number;
      desiredLod: number;
      currentLod: number;
    }> = [];

    for (const [gridKey, entry] of this.terrainGrid.entries()) {
      const [gridX, gridZ] = parseGridKey(gridKey);
      
      // Calculate distance to nearest point on chunk
      const distance = getDistanceToChunk(
        cameraPosition.x,
        cameraPosition.y,
        cameraPosition.z,
        gridX,
        gridZ,
        this.config.chunkWidth,
        this.config.chunkDepth
      );

      // Calculate desired LOD level
      const desiredLod = this.getLodLevelForChunkOptimized(
        gridKey,
        cameraPosition,
        fovRadians,
        screenHeight
      );

      // Get current LOD level
      const currentLod = entry.currentLodLevel;

      chunkData.push({
        gridKey,
        distance,
        desiredLod,
        currentLod,
      });
    }

    // Sort by distance (closest first)
    chunkData.sort((a, b) => a.distance - b.distance);

    // Log formatted output
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

    // Summary statistics
    const mismatches = chunkData.filter(d => d.desiredLod !== d.currentLod);
    console.log(`\nTotal chunks: ${chunkData.length}`);
    console.log(`Mismatches: ${mismatches.length}`);
    if (mismatches.length > 0) {
      console.log('\nChunks with LOD mismatches:');
      for (const mismatch of mismatches) {
        console.log(
          `  ${mismatch.gridKey}: distance=${mismatch.distance.toFixed(2)}m, desired=${mismatch.desiredLod}, current=${mismatch.currentLod}`
        );
      }
    }
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.worker.terminate();
    
    for (const gridKey of this.terrainGrid.keys()) {
      this.removeChunk(gridKey);
    }
    
    this.terrainGrid.clear();
    this.requestQueue.clear();
    this.material.dispose();
  }
}
