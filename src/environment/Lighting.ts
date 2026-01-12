import * as THREE from 'three';

/**
 * Lighting system responsible for:
 * - Sun directional light
 * - Hard shadows (Moon has no atmosphere)
 * - Shadow map configuration
 * - Ambient light (earthshine)
 */
export class Lighting {
  private sunLight!: THREE.DirectionalLight;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.initialize();
  }

  /**
   * Initialize lighting setup
   */
  private initialize(): void {
    // Sun directional light
    this.sunLight = new THREE.DirectionalLight(0xffffff, 1.0);
    this.sunLight.position.set(1000, 1000, 1000);
    this.sunLight.castShadow = true;
    
    // Shadow configuration
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 5000;
    this.sunLight.shadow.camera.left = -2000;
    this.sunLight.shadow.camera.right = 2000;
    this.sunLight.shadow.camera.top = 2000;
    this.sunLight.shadow.camera.bottom = -2000;

    this.scene.add(this.sunLight);

    // Minimal ambient light (earthshine)
    const ambientLight = new THREE.AmbientLight(0x000000, 0.05);
    this.scene.add(ambientLight);
  }

  /**
   * Get the sun light
   */
  getSunLight(): THREE.DirectionalLight {
    return this.sunLight;
  }

  /**
   * Update lighting (for day/night cycle, etc.)
   */
  update(): void {
    // Implementation will be added in future tickets
  }

  /**
   * Dispose lighting resources
   */
  dispose(): void {
    this.scene.remove(this.sunLight);
    this.sunLight.dispose();
  }
}
