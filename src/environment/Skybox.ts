import * as THREE from 'three';

/**
 * Skybox responsible for:
 * - Starfield background using equirectangular texture
 * - Black space rendering as fallback
 */
export class Skybox {
  private scene: THREE.Scene;
  private texture: THREE.Texture | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.initialize();
  }

  /**
   * Initialize skybox with default black background
   * Call loadTexture() to load the starfield
   */
  private initialize(): void {
    // Set scene background to black (space) as fallback
    this.scene.background = new THREE.Color(0x000000);
  }

  /**
   * Load an equirectangular texture for the skybox
   * @param texturePath Path to the equirectangular image
   */
  loadTexture(texturePath: string): void {
    const loader = new THREE.TextureLoader();
    
    loader.load(
      texturePath,
      (texture) => {
        // Configure for equirectangular mapping
        texture.mapping = THREE.EquirectangularReflectionMapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        
        // Set as scene background
        this.scene.background = texture;
        this.texture = texture;
        
        // Rotate skybox so Milky Way is overhead instead of on horizon
        // Rotate 90 degrees around X axis
        this.scene.backgroundRotation = new THREE.Euler(Math.PI / 2, 0, 0);
        
        console.log('Skybox texture loaded successfully');
      },
      undefined, // Progress callback (not needed)
      (error) => {
        console.error('Failed to load skybox texture:', error);
        // Keep black background as fallback
      }
    );
  }

  /**
   * Update skybox (for future animations, etc.)
   */
  update(): void {
    // No updates needed for static skybox
  }

  /**
   * Dispose skybox resources
   */
  dispose(): void {
    if (this.texture) {
      this.texture.dispose();
      this.texture = null;
    }
  }
}
