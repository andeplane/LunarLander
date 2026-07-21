import { GUI } from 'lil-gui';
import type { MoonMaterial, MoonMaterialParams } from '../shaders/MoonMaterial';
import type { CelestialSystem } from '../environment/CelestialSystem';
import { isTouchDevice } from '../utils/mobile';

/**
 * Minimal surface of MoonMaterial needed for a live params view.
 * Kept structural so the helper can be unit tested with a stub.
 */
export interface MaterialParamAccess {
  getParam<K extends keyof MoonMaterialParams>(key: K): MoonMaterialParams[K];
  setParam<K extends keyof MoonMaterialParams>(key: K, value: MoonMaterialParams[K]): void;
}

/**
 * Create a live view over the material's params: every read delegates to
 * `getParam` and every write to `setParam` (plus `onSet`).
 *
 * A plain `material.getParams()` snapshot would go stale as soon as anything
 * else (e.g. console `setParam` calls via `window.debug`) touches the
 * material — and worse, dragging a GUI slider would then write the stale
 * snapshot values back. The live view keeps the GUI and the material in sync
 * by construction.
 */
export function createLiveMaterialParams(
  material: MaterialParamAccess,
  onSet?: () => void
): MoonMaterialParams {
  return new Proxy({} as MoonMaterialParams, {
    get: (_target, prop) => material.getParam(prop as keyof MoonMaterialParams),
    set: (_target, prop, value) => {
      material.setParam(
        prop as keyof MoonMaterialParams,
        value as MoonMaterialParams[keyof MoonMaterialParams]
      );
      onSet?.();
      return true;
    },
    has: (_target, prop) => material.getParam(prop as keyof MoonMaterialParams) !== undefined,
  });
}

/**
 * UI Controller for MoonMaterial shader parameters and lighting
 * Provides organized GUI controls using lil-gui
 * Hidden on mobile/touch devices
 */
export class ShaderUIController {
  private gui: GUI | null = null;
  private params: MoonMaterialParams;
  private celestialSystem: CelestialSystem | null = null;

  constructor(material: MoonMaterial, requestRender: () => void, celestialSystem?: CelestialSystem) {
    this.celestialSystem = celestialSystem ?? null;
    // Live view over material params: GUI reads/writes always hit the
    // material directly, so external setParam calls can't leave the GUI
    // holding (and later re-applying) stale values
    this.params = createLiveMaterialParams(material, requestRender);
    
    // Sync initial planetRadius to celestial system
    if (this.celestialSystem) {
      this.celestialSystem.setPlanetRadius(this.params.planetRadius);
    }
    
    // Skip GUI creation on touch devices
    if (isTouchDevice()) {
      return;
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
    if (!this.gui) return;
    const folder = this.gui.addFolder('Toggles');
    
    // Note: writes go through the live params view, which already updates the
    // material and requests a render — no onChange mirroring needed
    folder.add(this.params, 'enableColorVariation').name('Enable Color Variation');

    folder.open();
  }

  /**
   * Setup color parameters folder
   */
  private setupColorsFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('Colors');
    
    folder.add(this.params, 'colorVariationFrequency', 0.001, 0.02, 0.001)
      .name('Variation Frequency');

    folder.add(this.params, 'baseColorBlend', 0.0, 1.0, 0.1)
      .name('Base Color Blend');

    folder.add(this.params, 'brightnessBoost', 1.0, 5.0, 0.1)
      .name('Brightness Boost');
  }

  /**
   * Setup curvature parameters folder
   */
  private setupCurvatureFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('Curvature');
    
    folder.add(this.params, 'enableCurvature')
      .name('Enable Curvature');

    folder.add(this.params, 'planetRadius', 1000, 50000, 500)
      .name('Planet Radius (m)')
      .onChange((value: number) => {
        // Material update is handled by the live params view; only the
        // celestial system (sun, Earth, stars rotation) needs syncing here
        if (this.celestialSystem) {
          this.celestialSystem.setPlanetRadius(value);
        }
      });
    
    folder.open();
  }

  /**
   * Setup texture LOD parameters folder
   * Controls for distance-based texture blending and hex tiling
   */
  private setupTextureLodFolder(): void {
    if (!this.gui) return;
    const folder = this.gui.addFolder('Texture LOD');
    
    folder.add(this.params, 'enableTexture')
      .name('Enable Texture');

    folder.add(this.params, 'enableHexTiling')
      .name('Enable Hex Tiling');

    // Hex tiling controls (0 = disabled for debugging)
    folder.add(this.params, 'hexPatchScale', 0, 20, 0.5)
      .name('Hex Patch Scale');

    folder.add(this.params, 'hexContrastCorrection')
      .name('Hex Contrast Correct');

    // UV scale controls for height-based interpolation
    folder.add(this.params, 'nonHexUvScale', 0.05, 1.0, 0.01)
      .name('Non-Hex UV Scale');

    folder.add(this.params, 'hexUvScale', 0.05, 1.0, 0.01)
      .name('Hex UV Scale');

    folder.open();
  }

  /**
   * Setup lighting parameters folder
   * Controls for sun, earthshine, and spaceship lights
   */
  private setupLightingFolder(): void {
    if (!this.gui || !this.celestialSystem) return;
    
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
   * Re-read all controller values from their sources and update the display.
   * Call after changing material params outside the GUI (e.g. console
   * `setParam` via `window.debug`) so the sliders reflect the live values.
   */
  refreshDisplay(): void {
    if (!this.gui) return;
    for (const controller of this.gui.controllersRecursive()) {
      controller.updateDisplay();
    }
  }

  /**
   * Show or hide the GUI panel (hidden outside Explore mode).
   */
  setVisible(visible: boolean): void {
    if (!this.gui) return;
    if (visible) {
      this.gui.show();
    } else {
      this.gui.hide();
    }
  }

  /**
   * Dispose of the GUI
   */
  dispose(): void {
    if (this.gui) {
      this.gui.destroy();
    }
  }
}
