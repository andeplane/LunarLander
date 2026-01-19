/**
 * CurvedStandardMaterial - Standard PBR material with planetary curvature
 * 
 * Used for artificial objects (balls, spaceship, etc.) that need to curve
 * with the planet like the terrain does, but don't need lunar surface texturing.
 * 
 * Uses the same curvature formula as MoonMaterial:
 *   curvatureDrop = distance² / (2 * planetRadius)
 */
import { MeshStandardMaterial, type MeshStandardMaterialParameters } from 'three';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';

export interface CurvedStandardMaterialParams extends MeshStandardMaterialParameters {
  planetRadius?: number;
  enableCurvature?: boolean;
}

export class CurvedStandardMaterial extends MeshStandardMaterial {
  private shaderUniforms: { [key: string]: { value: unknown } } | null = null;
  private _planetRadius: number;
  private _enableCurvature: boolean;

  constructor(params?: CurvedStandardMaterialParams) {
    // Extract our custom params before passing to super
    const { planetRadius, enableCurvature, ...standardParams } = params ?? {};
    
    super(standardParams);

    this._planetRadius = planetRadius ?? DEFAULT_PLANET_RADIUS;
    this._enableCurvature = enableCurvature ?? true;

    this.onBeforeCompile = (shader) => {
      // Store uniforms for later updates
      this.shaderUniforms = shader.uniforms;

      // Add curvature uniforms
      shader.uniforms.uPlanetRadius = { value: this._planetRadius };
      shader.uniforms.uEnableCurvature = { value: this._enableCurvature ? 1.0 : 0.0 };

      // Add uniform declarations to vertex shader
      shader.vertexShader = `
        uniform float uPlanetRadius;
        uniform float uEnableCurvature;
        ${shader.vertexShader}
      `;

      // Replace projection to apply curvature
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `
        vec4 worldPosition = modelMatrix * vec4(transformed, 1.0);
        
        // Apply planetary curvature (same formula as MoonMaterial)
        if (uEnableCurvature > 0.5) {
          vec2 deltaXZ = worldPosition.xz - cameraPosition.xz;
          float distSq = dot(deltaXZ, deltaXZ);
          float curvatureDrop = distSq / (2.0 * uPlanetRadius);
          worldPosition.y -= curvatureDrop;
        }
        
        vec4 mvPosition = viewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;
        `
      );
    };
  }

  /**
   * Get the planet radius used for curvature calculation.
   */
  get planetRadius(): number {
    return this._planetRadius;
  }

  /**
   * Set the planet radius and update shader uniform.
   */
  set planetRadius(value: number) {
    this._planetRadius = value;
    if (this.shaderUniforms?.uPlanetRadius) {
      this.shaderUniforms.uPlanetRadius.value = value;
    }
  }

  /**
   * Get whether curvature is enabled.
   */
  get enableCurvature(): boolean {
    return this._enableCurvature;
  }

  /**
   * Set whether curvature is enabled and update shader uniform.
   */
  set enableCurvature(value: boolean) {
    this._enableCurvature = value;
    if (this.shaderUniforms?.uEnableCurvature) {
      this.shaderUniforms.uEnableCurvature.value = value ? 1.0 : 0.0;
    }
  }
}
