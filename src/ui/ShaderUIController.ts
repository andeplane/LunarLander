import { GUI } from 'lil-gui';
import { MoonMaterial, type MoonMaterialParams } from '../shaders/MoonMaterial';
import { CelestialSystem } from '../environment/CelestialSystem';

/**
 * UI Controller for MoonMaterial shader parameters and lighting
 * Provides organized GUI controls using lil-gui
 */
export class ShaderUIController {
  private gui: GUI;
  private material: MoonMaterial;
  private params: MoonMaterialParams;
  private celestialSystem: CelestialSystem | null = null;

  constructor(material: MoonMaterial, celestialSystem?: CelestialSystem) {
    this.material = material;
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
    this.setupNoiseFolder();
    this.setupCratersFolder();
    this.setupBumpMappingFolder();
    this.setupColorsFolder();
    this.setupCurvatureFolder();
    this.setupLightingFolder();
  }

  /**
   * Setup toggles folder
   */
  private setupTogglesFolder(): void {
    const folder = this.gui.addFolder('Toggles');
    
    folder.add(this.params, 'enableCraters')
      .name('Enable Craters')
      .onChange((value: boolean) => this.material.setParam('enableCraters', value));

    folder.add(this.params, 'enableNoise')
      .name('Enable Noise')
      .onChange((value: boolean) => this.material.setParam('enableNoise', value));

    folder.add(this.params, 'enableBumpMapping')
      .name('Enable Bump Mapping')
      .onChange((value: boolean) => this.material.setParam('enableBumpMapping', value));

    folder.add(this.params, 'enableColorVariation')
      .name('Enable Color Variation')
      .onChange((value: boolean) => this.material.setParam('enableColorVariation', value));

    folder.open();
  }

  /**
   * Setup noise parameters folder
   */
  private setupNoiseFolder(): void {
    const folder = this.gui.addFolder('Noise');
    
    folder.add(this.params, 'noiseFrequency', 1.0, 20.0, 0.1)
      .name('Noise Frequency')
      .onChange((value: number) => this.material.setParam('noiseFrequency', value));

    folder.add(this.params, 'noiseAmplitude', 0.0, 0.2, 0.01)
      .name('Noise Amplitude')
      .onChange((value: number) => this.material.setParam('noiseAmplitude', value));

    folder.add(this.params, 'distortionFrequency', 0.1, 2.0, 0.1)
      .name('Distortion Frequency')
      .onChange((value: number) => this.material.setParam('distortionFrequency', value));
  }

  /**
   * Setup craters parameters folder
   */
  private setupCratersFolder(): void {
    const folder = this.gui.addFolder('Craters');
    
    folder.add(this.params, 'scale', 0.01, 0.2, 0.01)
      .name('Crater Density')
      .onChange((value: number) => this.material.setParam('scale', value));

    folder.add(this.params, 'distortion', 0.0, 1.0, 0.05)
      .name('Crater Wobble')
      .onChange((value: number) => this.material.setParam('distortion', value));

    const largeFolder = folder.addFolder('Large Craters');
    largeFolder.add(this.params, 'largeCraterScale', 0.1, 2.0, 0.1)
      .name('Scale Multiplier')
      .onChange((value: number) => this.material.setParam('largeCraterScale', value));
    largeFolder.add(this.params, 'largeCraterSmoothMin', 0.0, 0.5, 0.05)
      .name('Smoothstep Min')
      .onChange((value: number) => this.material.setParam('largeCraterSmoothMin', value));
    largeFolder.add(this.params, 'largeCraterSmoothMax', 0.5, 1.0, 0.05)
      .name('Smoothstep Max')
      .onChange((value: number) => this.material.setParam('largeCraterSmoothMax', value));
    largeFolder.add(this.params, 'largeCraterWeight', 0.0, 1.0, 0.1)
      .name('Blend Weight')
      .onChange((value: number) => this.material.setParam('largeCraterWeight', value));

    const mediumFolder = folder.addFolder('Medium Craters');
    mediumFolder.add(this.params, 'mediumCraterScale', 0.5, 3.0, 0.1)
      .name('Scale Multiplier')
      .onChange((value: number) => this.material.setParam('mediumCraterScale', value));
    mediumFolder.add(this.params, 'mediumCraterSmoothMin', 0.0, 0.5, 0.05)
      .name('Smoothstep Min')
      .onChange((value: number) => this.material.setParam('mediumCraterSmoothMin', value));
    mediumFolder.add(this.params, 'mediumCraterSmoothMax', 0.5, 1.0, 0.05)
      .name('Smoothstep Max')
      .onChange((value: number) => this.material.setParam('mediumCraterSmoothMax', value));
    mediumFolder.add(this.params, 'mediumCraterWeight', 0.0, 1.0, 0.1)
      .name('Blend Weight')
      .onChange((value: number) => this.material.setParam('mediumCraterWeight', value));
  }

  /**
   * Setup surface texture (regolith) parameters folder
   */
  private setupBumpMappingFolder(): void {
    const folder = this.gui.addFolder('Surface Texture');
    
    folder.add(this.params, 'enableRocks')
      .name('Enable Rocks')
      .onChange((value: boolean) => this.material.setParam('enableRocks', value));

    folder.add(this.params, 'enableMicroCraters')
      .name('Enable Micro Craters')
      .onChange((value: boolean) => this.material.setParam('enableMicroCraters', value));
    
    folder.add(this.params, 'rockDensity', 0.0, 1.0, 0.05)
      .name('Gravel vs Dust')
      .onChange((value: number) => this.material.setParam('rockDensity', value));

    folder.add(this.params, 'rockSize', 5.0, 100.0, 5.0)
      .name('Texture Scale')
      .onChange((value: number) => this.material.setParam('rockSize', value));

    folder.add(this.params, 'rockSoftness', 0.0, 1.0, 0.05)
      .name('Smoothness')
      .onChange((value: number) => this.material.setParam('rockSoftness', value));

    folder.add(this.params, 'rockHeight', 0.1, 2.0, 0.1)
      .name('Bump Intensity')
      .onChange((value: number) => this.material.setParam('rockHeight', value));
  }

  /**
   * Setup color parameters folder
   */
  private setupColorsFolder(): void {
    const folder = this.gui.addFolder('Colors');
    
    folder.add(this.params, 'colorVariationFrequency', 0.001, 0.02, 0.001)
      .name('Variation Frequency')
      .onChange((value: number) => this.material.setParam('colorVariationFrequency', value));

    folder.add(this.params, 'baseColorBlend', 0.0, 1.0, 0.1)
      .name('Base Color Blend')
      .onChange((value: number) => this.material.setParam('baseColorBlend', value));

    folder.add(this.params, 'brightnessBoost', 1.0, 5.0, 0.1)
      .name('Brightness Boost')
      .onChange((value: number) => this.material.setParam('brightnessBoost', value));
  }

  /**
   * Setup curvature parameters folder
   */
  private setupCurvatureFolder(): void {
    const folder = this.gui.addFolder('Curvature');
    
    folder.add(this.params, 'enableCurvature')
      .name('Enable Curvature')
      .onChange((value: boolean) => this.material.setParam('enableCurvature', value));

    folder.add(this.params, 'planetRadius', 1000, 50000, 500)
      .name('Planet Radius (m)')
      .onChange((value: number) => {
        // Update terrain shader
        this.material.setParam('planetRadius', value);
        // Sync to celestial system (sun, Earth, stars rotation)
        if (this.celestialSystem) {
          this.celestialSystem.setPlanetRadius(value);
        }
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
