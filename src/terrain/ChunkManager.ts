import * as THREE from 'three';
import type { Chunk, ChunkCoord, ChunkConfig } from '../types';

/**
 * Chunk manager responsible for:
 * - Chunk lifecycle management (create, update, dispose)
 * - Maintaining active chunks around camera
 * - Chunk loading/unloading based on camera position
 * - Height query API
 */
export class ChunkManager {
  private config: ChunkConfig;
  private activeChunks: Map<string, Chunk> = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private buildQueue: ChunkCoord[] = [];

  constructor(config: ChunkConfig) {
    this.config = config;
    // Properties will be used in future implementation
    void this.buildQueue;
  }

  /**
   * Update chunks based on camera position
   */
  update(_cameraPosition: THREE.Vector3): void {
    // Implementation will be added in future tickets
  }

  /**
   * Get height at world position
   */
  getHeightAt(_worldX: number, _worldZ: number): number {
    // Implementation will be added in future tickets
    return 0;
  }

  /**
   * Get chunk coordinate from world position
   */
  worldToChunkCoord(worldX: number, worldZ: number): ChunkCoord {
    return {
      x: Math.floor(worldX / this.config.size),
      z: Math.floor(worldZ / this.config.size)
    };
  }

  /**
   * Get chunk key string from coordinates
   * Reserved for future use
   */
  public getChunkKey(coord: ChunkCoord): string {
    return `${coord.x},${coord.z}`;
  }

  /**
   * Cleanup and dispose all chunks
   */
  dispose(): void {
    for (const chunk of this.activeChunks.values()) {
      if (chunk.geometry) chunk.geometry.dispose();
      if (chunk.mesh) {
        if (chunk.mesh.material) {
          if (Array.isArray(chunk.mesh.material)) {
            chunk.mesh.material.forEach(m => m.dispose());
          } else {
            chunk.mesh.material.dispose();
          }
        }
      }
    }
    this.activeChunks.clear();
    this.buildQueue = [];
  }
}
