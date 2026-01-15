import { MeshStandardMaterial, Color } from 'three';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';

/**
 * Shader parameters interface for RockMaterial
 */
export interface RockMaterialParams {
  enableCurvature: boolean;
  planetRadius: number; // Virtual planet radius in meters
}

/**
 * RockMaterial - Material for procedural rocks with curvature support
 * 
 * Extends MeshStandardMaterial and adds the same fake curvature shader
 * as MoonMaterial, so rocks follow the terrain curvature.
 */
export class RockMaterial extends MeshStandardMaterial {
  private shaderUniforms: { [key: string]: { value: any } } | null = null;
  private params: RockMaterialParams;

  constructor() {
    super({
      color: new Color(0xcccccc),  // Lighter gray for visibility
      roughness: 0.85,             // Moon rocks are dusty/rough
      metalness: 0.1,
      flatShading: false,          // Smooth normals for realistic look
    });

    // Initialize default parameters (these will be used when shader compiles)
    this.params = {
      enableCurvature: true,
      planetRadius: DEFAULT_PLANET_RADIUS,
    };

    this.onBeforeCompile = (shader) => {
      // Store reference to uniforms for later updates
      this.shaderUniforms = shader.uniforms;

      // Initialize curvature uniforms
      shader.uniforms.uEnableCurvature = { value: this.params.enableCurvature ? 1.0 : 0.0 };
      shader.uniforms.uPlanetRadius = { value: this.params.planetRadius };
      // Note: cameraPosition is automatically provided by Three.js

      // ==========================================
      // VERTEX SHADER MODIFICATIONS
      // ==========================================
      
      // Add uniforms for curvature
      shader.vertexShader = `
        uniform float uEnableCurvature;
        uniform float uPlanetRadius;
        ${shader.vertexShader}
      `;

      // Apply planetary curvature (same as MoonMaterial)
      // IMPORTANT: For InstancedMesh, we need to use instanceMatrix if available
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `
        #ifdef USE_INSTANCING
          vec4 worldPosition = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
        #else
          vec4 worldPosition = modelMatrix * vec4( transformed, 1.0 );
        #endif
        
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
   * Set a parameter value and update shader uniforms
   */
  setParam<K extends keyof RockMaterialParams>(key: K, value: RockMaterialParams[K]): void {
    this.params[key] = value;

    if (this.shaderUniforms) {
      if (key === 'enableCurvature') {
        this.shaderUniforms.uEnableCurvature.value = value ? 1.0 : 0.0;
      } else if (key === 'planetRadius') {
        this.shaderUniforms.uPlanetRadius.value = value;
      }
    }
    
    // Mark material as needing update to force shader recompilation
    // This ensures the shader uses the updated param values
    this.needsUpdate = true;
  }

  /**
   * Get a parameter value
   */
  getParam<K extends keyof RockMaterialParams>(key: K): RockMaterialParams[K] {
    return this.params[key];
  }
}
