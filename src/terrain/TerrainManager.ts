import { BufferAttribute, BufferGeometry, LOD, Mesh, Scene, Vector3, Camera, MeshBasicMaterial, Color } from 'three';
import { TerrainMaterial } from '../shaders/TerrainMaterial';
import type { TerrainArgs } from './terrain';
import type { TerrainWorkerResult } from './TerrainWorker';
import { 
  getNeighborKeys, 
  parseGridKey,
  getDistanceToChunk,
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
  /** Distance thresholds for each LOD level (in world units), e.g. [0, 100, 200, 400] */
  lodDistances: number[];
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
  private material: TerrainMaterial;
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
    this.material = new TerrainMaterial();

    // Validate config
    if (config.lodLevels.length !== config.lodDistances.length) {
      console.warn('TerrainManager: lodLevels and lodDistances arrays should have same length');
    }

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

    // Add to LOD object with distance threshold
    const distance = this.config.lodDistances[lodLevel] ?? 0;
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
          if (mesh.material instanceof MeshBasicMaterial || mesh.material instanceof TerrainMaterial) {
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
   * Determine which LOD level a chunk should use based on distance
   */
  private getLodLevelForChunk(gridKey: string, cameraWorldPos: Vector3): number {
    const [gridX, gridZ] = parseGridKey(gridKey);
    const distance = getDistanceToChunk(
      cameraWorldPos.x,
      cameraWorldPos.z,
      gridX,
      gridZ,
      this.config.chunkWidth,
      this.config.chunkDepth
    );

    // Find appropriate LOD level based on distance thresholds
    for (let i = this.config.lodDistances.length - 1; i >= 0; i--) {
      if (distance >= this.config.lodDistances[i]) {
        return i;
      }
    }
    return 0;
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

    // Request chunks and their appropriate LOD levels
    for (const gridKey of nearbyKeys) {
      const desiredLod = this.getLodLevelForChunk(gridKey, cameraPosition);
      
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

    // Update LOD objects (Three.js handles visibility switching)
    if (this.camera) {
      for (const entry of this.terrainGrid.values()) {
        entry.lod.update(this.camera);
      }
    }

    // Track current LOD levels and update edge stitching
    this.updateEdgeStitching(cameraPosition);

    // Remove distant chunks
    for (const gridKey of this.terrainGrid.keys()) {
      if (!nearbySet.has(gridKey)) {
        this.removeChunk(gridKey);
      }
    }
  }

  /**
   * Update edge stitching for chunks that have LOD mismatches with neighbors
   */
  private updateEdgeStitching(cameraPosition: Vector3): void {
    // First pass: determine current LOD level for each chunk
    const chunkLodLevels = new Map<string, number>();
    
    for (const [gridKey, entry] of this.terrainGrid.entries()) {
      const desiredLod = this.getLodLevelForChunk(gridKey, cameraPosition);
      // Use the best available LOD that's closest to desired
      let actualLod = desiredLod;
      while (actualLod < this.config.lodLevels.length && !entry.builtLevels.has(actualLod)) {
        actualLod++;
      }
      if (actualLod >= this.config.lodLevels.length) {
        // Fall back to any available LOD
        actualLod = entry.builtLevels.values().next().value ?? 0;
      }
      entry.currentLodLevel = actualLod;
      chunkLodLevels.set(gridKey, actualLod);
    }

    // Second pass: update edge stitching where needed
    for (const [gridKey, entry] of this.terrainGrid.entries()) {
      const [gridX, gridZ] = parseGridKey(gridKey);
      const neighbors = getNeighborKeys(gridX, gridZ);
      const myLod = entry.currentLodLevel;

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
