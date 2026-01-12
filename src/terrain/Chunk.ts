import * as THREE from 'three';
import type { ChunkCoord } from '../types';

/**
 * Individual chunk representing a terrain mesh section
 * Responsible for:
 * - Chunk mesh geometry
 * - Height data storage
 * - LOD level management
 */
export class Chunk {
  public coord: ChunkCoord;
  public mesh: THREE.Mesh | null = null;
  public geometry: THREE.BufferGeometry | null = null;
  public heightData: Float32Array | null = null;
  public lodLevel: number = 0;

  constructor(coord: ChunkCoord) {
    this.coord = coord;
  }

  /**
   * Build chunk geometry
   */
  buildGeometry(_resolution: number, _size: number): void {
    // Implementation will be added in future tickets
  }

  /**
   * Update LOD level
   */
  updateLOD(level: number): void {
    this.lodLevel = level;
    // Implementation will be added in future tickets
  }

  /**
   * Dispose chunk resources
   */
  dispose(): void {
    if (this.geometry) {
      this.geometry.dispose();
    }
    if (this.mesh) {
      if (this.mesh.material) {
        if (Array.isArray(this.mesh.material)) {
          this.mesh.material.forEach(m => m.dispose());
        } else {
          this.mesh.material.dispose();
        }
      }
    }
  }
}
