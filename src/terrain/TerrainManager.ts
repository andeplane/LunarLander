import { BufferAttribute, BufferGeometry, Mesh, Scene, Vector3 } from 'three';
import { TerrainMaterial } from '../shaders/TerrainMaterial';
import type { TerrainArgs } from './terrain';

export interface TerrainConfig {
  renderDistance: number;
  resolution: number;
  chunkWidth: number;
  chunkDepth: number;
}

interface ChunkEntry {
  mesh: Mesh;
  resolution: number;
}

export class TerrainManager {
  private terrainGrid: Map<string, ChunkEntry> = new Map();
  private scheduledKeys: Set<string> = new Set();
  private material: TerrainMaterial;
  private worker: Worker;
  private scene: Scene;
  private config: TerrainConfig;
  private terrainArgs: TerrainArgs;

  constructor(scene: Scene, config: TerrainConfig) {
    this.scene = scene;
    this.config = config;
    this.material = new TerrainMaterial();

    // Default terrain args (Earth-like terrain)
    this.terrainArgs = {
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
      resolution: config.resolution,
      width: config.chunkWidth,
      depth: config.chunkDepth,
      posX: 0,
      posZ: 0,
      renderDistance: config.renderDistance,
    };

    this.worker = this.setupTerrainWorker();
  }

  private setupTerrainWorker(): Worker {
    const worker = new Worker(
      new URL('./TerrainWorker.ts', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e) => {
      const { positions, normals, index, biome, gridKey } = e.data;

      // Remove old mesh if it exists
      if (this.terrainGrid.has(gridKey)) {
        const old = this.terrainGrid.get(gridKey)!;
        this.scene.remove(old.mesh);
        old.mesh.geometry.dispose();
        this.terrainGrid.delete(gridKey);
      }

      // Create new geometry
      const terrainGeometry = new BufferGeometry();
      terrainGeometry.setAttribute(
        'position',
        new BufferAttribute(new Float32Array(positions), 3)
      );
      terrainGeometry.setAttribute(
        'normal',
        new BufferAttribute(new Float32Array(normals), 3)
      );
      terrainGeometry.setAttribute(
        'biome',
        new BufferAttribute(new Float32Array(biome), 3)
      );
      terrainGeometry.setIndex(new BufferAttribute(new Uint32Array(index), 1));

      // Create mesh and position it
      const newTerrain = new Mesh(terrainGeometry, this.material);
      const [gridX, gridZ] = gridKey.split(',').map(Number);
      newTerrain.position.x = gridX * this.config.chunkWidth;
      newTerrain.position.z = gridZ * this.config.chunkDepth;

      this.terrainGrid.set(gridKey, { mesh: newTerrain, resolution: this.terrainArgs.resolution });
      this.scene.add(newTerrain);
      this.scheduledKeys.delete(gridKey);
      this.material.needsUpdate = true;
    };

    return worker;
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
   * Update terrain based on camera position
   */
  update(cameraPosition: Vector3): void {
    // Convert camera position to grid coordinates
    const camPosInGrid = cameraPosition.clone();
    camPosInGrid.x /= this.config.chunkWidth;
    camPosInGrid.z /= this.config.chunkDepth;
    camPosInGrid.y = 0;

    const renderDistance = Math.floor(this.config.renderDistance);

    // Generate nearby chunks
    for (const gridKey of this.getNearbyChunkPositionKeys(camPosInGrid, renderDistance)) {
      if (!this.terrainGrid.has(gridKey) && !this.scheduledKeys.has(gridKey)) {
        this.scheduledKeys.add(gridKey);
        const [gridX, gridZ] = gridKey.split(',').map(Number);

        // Update terrain args with chunk position
        const args = { ...this.terrainArgs };
        args.posX = gridX * 0.4;
        args.posZ = gridZ * 0.4;

        this.worker.postMessage({ terrainArgs: args, gridKey });
      }
    }

    // Remove distant chunks
    for (const gridKey of this.terrainGrid.keys()) {
      const [iX, iZ] = gridKey.split(',').map(Number);
      const distanceToCamera = camPosInGrid.distanceTo(new Vector3(iX, 0, iZ));
      if (distanceToCamera > renderDistance) {
        const entry = this.terrainGrid.get(gridKey)!;
        this.scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        this.terrainGrid.delete(gridKey);
      }
    }
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
    return this.scheduledKeys.size;
  }

  /**
   * Clean up resources
   */
  dispose(): void {
    this.worker.terminate();
    for (const entry of this.terrainGrid.values()) {
      this.scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
    }
    this.terrainGrid.clear();
    this.material.dispose();
  }
}
