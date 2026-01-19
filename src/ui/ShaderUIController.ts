import { GUI } from 'lil-gui';
import type { MoonMaterial, MoonMaterialParams } from '../shaders/MoonMaterial';
import type { CelestialSystem } from '../environment/CelestialSystem';

/**
 * UI Controller for MoonMaterial shader parameters and lighting
 * Provides organized GUI controls using lil-gui
 */
export class ShaderUIController {
  private gui: GUI;
  private material: MoonMaterial;
  private params: MoonMaterialParams;
  private celestialSystem: CelestialSystem | null = null;
  private requestRender: () => void;

  constructor(material: MoonMaterial, requestRender: () => void, celestialSystem?: CelestialSystem) {
    this.material = material;
    this.requestRender = requestRender;
    this.celestialSystem = celestialSystem ?? null;
    // Get initial params - we'll use onChange handlers instead of Proxy
    this.params = material.getParams();
    
    // Sync initial planetRadius to celestial system
    if (this.celestialSystem) {
      this.celestialSystem.setPlanetRadius(this.params.planetRadius);
    }
    
    // Create GUI instance
    this.gui = new GUI();
    this.gui.title('Lunar Surface Shader');
    this.gui.domElement.style.position = 'fixed';
    this.gui.domElement.style.top = '10px';
    this.gui.domElement.style.right = '10px';
    this.gui.domElement.style.zIndex = '1000';

    // Create organized folders
    this.setupTogglesFolder();
    this.setupColorsFolder();
    this.setupCurvatureFolder();
    this.setupTextureLodFolder();
    this.setupLightingFolder();
  }

  /**
   * Setup toggles folder
   */
  private setupTogglesFolder(): void {
    const folder = this.gui.addFolder('Toggles');
    
    folder.add(this.params, 'enableColorVariation')
      .name('Enable Color Variation')
      .onChange((value: boolean) => {
        this.material.setParam('enableColorVariation', value);
        this.requestRender();
      });

    folder.open();
  }

  /**
   * Setup color parameters folder
   */
  private setupColorsFolder(): void {
    const folder = this.gui.addFolder('Colors');
    
    folder.add(this.params, 'colorVariationFrequency', 0.001, 0.02, 0.001)
      .name('Variation Frequency')
      .onChange((value: number) => {
        this.material.setParam('colorVariationFrequency', value);
        this.requestRender();
      });

    folder.add(this.params, 'baseColorBlend', 0.0, 1.0, 0.1)
      .name('Base Color Blend')
      .onChange((value: number) => {
        this.material.setParam('baseColorBlend', value);
        this.requestRender();
      });

    folder.add(this.params, 'brightnessBoost', 1.0, 5.0, 0.1)
      .name('Brightness Boost')
      .onChange((value: number) => {
        this.material.setParam('brightnessBoost', value);
        this.requestRender();
      });
  }

  /**
   * Setup curvature parameters folder
   */
  private setupCurvatureFolder(): void {
    const folder = this.gui.addFolder('Curvature');
    
    folder.add(this.params, 'enableCurvature')
      .name('Enable Curvature')
      .onChange((value: boolean) => {
        this.material.setParam('enableCurvature', value);
        this.requestRender();
      });

    folder.add(this.params, 'planetRadius', 1000, 50000, 500)
      .name('Planet Radius (m)')
      .onChange((value: number) => {
        // Update terrain shader
        this.material.setParam('planetRadius', value);
        // Sync to celestial system (sun, Earth, stars rotation)
        if (this.celestialSystem) {
          this.celestialSystem.setPlanetRadius(value);
        }
        this.requestRender();
      });
    
    folder.open();
  }

  /**
   * Setup texture LOD parameters folder
   * Controls for distance-based texture blending and hex tiling
   */
  private setupTextureLodFolder(): void {
    const folder = this.gui.addFolder('Texture LOD');
    
    folder.add(this.params, 'enableTexture')
      .name('Enable Texture')
      .onChange((value: boolean) => {
        this.material.setParam('enableTexture', value);
        this.requestRender();
      });
    
    folder.add(this.params, 'enableHexTiling')
      .name('Enable Hex Tiling')
      .onChange((value: boolean) => {
        this.material.setParam('enableHexTiling', value);
        this.requestRender();
      });
    
    // Hex tiling controls (0 = disabled for debugging)
    folder.add(this.params, 'hexPatchScale', 0, 20, 0.5)
      .name('Hex Patch Scale')
      .onChange((value: number) => {
        this.material.setParam('hexPatchScale', value);
        this.requestRender();
      });
    
    folder.add(this.params, 'hexContrastCorrection')
      .name('Hex Contrast Correct')
      .onChange((value: boolean) => {
        this.material.setParam('hexContrastCorrection', value);
        this.requestRender();
      });
    
    // UV scale controls for height-based interpolation
    folder.add(this.params, 'nonHexUvScale', 0.05, 1.0, 0.01)
      .name('Non-Hex UV Scale')
      .onChange((value: number) => {
        this.material.setParam('nonHexUvScale', value);
        this.requestRender();
      });
    
    folder.add(this.params, 'hexUvScale', 0.05, 1.0, 0.01)
      .name('Hex UV Scale')
      .onChange((value: number) => {
        this.material.setParam('hexUvScale', value);
        this.requestRender();
      });
    
    folder.open();
  }

  /**
   * Setup lighting parameters folder
   * Controls for sun, earthshine, and spaceship lights
   */
  private setupLightingFolder(): void {
    if (!this.celestialSystem) return;
    
    const folder = this.gui.addFolder('Lighting');
    
    // Create a proxy object for the lighting params since celestialSystem uses getters/setters
    const lightingParams = {
      sunIntensity: this.celestialSystem.sunIntensity,
      earthshineMultiplier: this.celestialSystem.earthshineMultiplier,
      spaceshipLightIntensity: this.celestialSystem.spaceshipLightIntensity,
      spaceshipLightRange: this.celestialSystem.spaceshipLightRange,
      flashlightIntensity: this.celestialSystem.flashlightIntensity,
      flashlightRange: this.celestialSystem.flashlightRange,
      flashlightAngle: this.celestialSystem.flashlightAngle * (180 / Math.PI), // Convert to degrees for UI
    };
    
    folder.add(lightingParams, 'sunIntensity', 0, 20, 0.1)
      .name('Sun Intensity')
      .onChange((value: number) => {
        if (this.celestialSystem) {
          this.celestialSystem.sunIntensity = value;
        }
      });
    
    folder.add(lightingParams, 'earthshineMultiplier', 0, 1, 0.01)
      .name('Earthshine Multiplier')
      .onChange((value: number) => {
        if (this.celestialSystem) {
          this.celestialSystem.earthshineMultiplier = value;
        }
      });
    
    folder.add(lightingParams, 'spaceshipLightIntensity', 0, 20, 1)
      .name('Spaceship Intensity')
      .onChange((value: number) => {
        if (this.celestialSystem) {
          this.celestialSystem.spaceshipLightIntensity = value;
        }
      });
    
    folder.add(lightingParams, 'spaceshipLightRange', 10, 500, 10)
      .name('Spaceship Range (m)')
      .onChange((value: number) => {
        if (this.celestialSystem) {
          this.celestialSystem.spaceshipLightRange = value;
        }
      });
    
    folder.add(lightingParams, 'flashlightIntensity', 0, 50, 1)
      .name('Flashlight Intensity')
      .onChange((value: number) => {
        if (this.celestialSystem) {
          this.celestialSystem.flashlightIntensity = value;
        }
      });
    
    folder.add(lightingParams, 'flashlightRange', 50, 1000, 50)
      .name('Flashlight Range (m)')
      .onChange((value: number) => {
        if (this.celestialSystem) {
          this.celestialSystem.flashlightRange = value;
        }
      });
    
    folder.add(lightingParams, 'flashlightAngle', 5, 60, 1)
      .name('Flashlight Angle (°)')
      .onChange((value: number) => {
        if (this.celestialSystem) {
          // Convert degrees back to radians
          this.celestialSystem.flashlightAngle = value * (Math.PI / 180);
        }
      });
    
    folder.open();
  }

  /**
   * Dispose of the GUI
   */
  dispose(): void {
    this.gui.destroy();
  }
}
