import { GUI } from 'lil-gui';
import { MoonMaterial, type MoonMaterialParams } from '../shaders/MoonMaterial';

/**
 * UI Controller for MoonMaterial shader parameters
 * Provides organized GUI controls using lil-gui
 */
export class ShaderUIController {
  private gui: GUI;
  private material: MoonMaterial;
  private params: MoonMaterialParams;

  constructor(material: MoonMaterial) {
    this.material = material;
    // Get initial params - we'll use onChange handlers instead of Proxy
    this.params = material.getParams();
    
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
   * Setup bump mapping parameters folder
   */
  private setupBumpMappingFolder(): void {
    const folder = this.gui.addFolder('Bump Mapping');
    
    folder.add(this.params, 'bumpStrength', 0.0, 2.0, 0.1)
      .name('Bump Strength')
      .onChange((value: number) => this.material.setParam('bumpStrength', value));

    folder.add(this.params, 'bumpMultiplier', 10.0, 200.0, 10.0)
      .name('Bump Multiplier')
      .onChange((value: number) => this.material.setParam('bumpMultiplier', value));
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
   * Dispose of the GUI
   */
  dispose(): void {
    this.gui.destroy();
  }
}
