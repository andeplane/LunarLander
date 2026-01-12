import * as THREE from 'three';
import type { ChunkCoord } from '../types';

/**
 * LOD controller responsible for:
 * - Determining appropriate LOD level based on distance
 * - Managing LOD transitions
 * - Edge stitching between different LOD levels
 */
export class LODController {
  private lodDistances: number[] = [500, 1500, 4000]; // Distance thresholds for LOD 0, 1, 2, 3

  /**
   * Get LOD level for a chunk based on distance from camera
   */
  getLODLevel(chunkCoord: ChunkCoord, cameraPosition: THREE.Vector3, chunkSize: number): number {
    // Calculate chunk center position
    const chunkCenterX = (chunkCoord.x + 0.5) * chunkSize;
    const chunkCenterZ = (chunkCoord.z + 0.5) * chunkSize;
    
    // Calculate distance from camera to chunk center
    const dx = chunkCenterX - cameraPosition.x;
    const dz = chunkCenterZ - cameraPosition.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    // Determine LOD level based on distance thresholds
    if (distance < this.lodDistances[0]) return 0;
    if (distance < this.lodDistances[1]) return 1;
    if (distance < this.lodDistances[2]) return 2;
    return 3;
  }

  /**
   * Get resolution for a given LOD level
   */
  getResolutionForLOD(lodLevel: number): number {
    const resolutions = [128, 64, 32, 16];
    return resolutions[Math.min(lodLevel, resolutions.length - 1)];
  }
}
