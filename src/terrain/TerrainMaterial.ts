import * as THREE from 'three';

/**
 * Terrain material responsible for:
 * - Lunar surface PBR material
 * - Normal mapping for surface detail
 * - Slope-based shading variation
 * - Grayscale regolith appearance
 */
export class TerrainMaterial {
  private material: THREE.MeshStandardMaterial;

  constructor() {
    this.material = new THREE.MeshStandardMaterial({
      color: 0x888888, // Grayscale lunar regolith
      roughness: 0.9,
      metalness: 0.1,
    });
  }

  /**
   * Get the Three.js material
   */
  getMaterial(): THREE.MeshStandardMaterial {
    return this.material;
  }

  /**
   * Update material properties
   */
  update(): void {
    // Implementation will be added in future tickets
  }

  /**
   * Dispose material resources
   */
  dispose(): void {
    this.material.dispose();
  }
}
