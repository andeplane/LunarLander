import { MeshStandardMaterial, Color } from 'three';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';

/**
 * Shader parameters interface for RockMaterial
 */
export interface RockMaterialParams {
  enableCurvature: boolean;
  planetRadius: number; // Virtual planet radius in meters
  brightnessBoost: number; // Brightness multiplier (match MoonMaterial default of 1.2)
  baseColorBlend: number; // Base color blend factor (match MoonMaterial default of 0.6)
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
      brightnessBoost: 1.2, // Match MoonMaterial default
      baseColorBlend: 0.6, // Match MoonMaterial default
    };

    this.onBeforeCompile = (shader) => {
      // Store reference to uniforms for later updates
      this.shaderUniforms = shader.uniforms;

      // Initialize curvature, brightness, and color blend uniforms
      shader.uniforms.uEnableCurvature = { value: this.params.enableCurvature ? 1.0 : 0.0 };
      shader.uniforms.uPlanetRadius = { value: this.params.planetRadius };
      shader.uniforms.uBrightnessBoost = { value: this.params.brightnessBoost };
      shader.uniforms.uBaseColorBlend = { value: this.params.baseColorBlend };
      // Note: cameraPosition is automatically provided by Three.js

      // ==========================================
      // VERTEX SHADER MODIFICATIONS
      // ==========================================
      
      // Add uniforms and varying for curvature and lighting
      shader.vertexShader = `
        varying vec3 vWorldPosition; // Curved world position for lighting
        uniform float uEnableCurvature;
        uniform float uPlanetRadius;
        ${shader.vertexShader}
      `;

      // Apply planetary curvature and store curved world position
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
        
        // Store CURVED world position (after curvature) for fragment shader lighting
        vWorldPosition = worldPosition.xyz;
        
        vec4 mvPosition = viewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;
        `
      );

      // ==========================================
      // FRAGMENT SHADER MODIFICATIONS
      // ==========================================
      
      // Add varying and uniforms for fragment shader
      shader.fragmentShader = `
        varying vec3 vWorldPosition; // Curved world position for lighting
        uniform float uBrightnessBoost;
        uniform float uBaseColorBlend;
        ${shader.fragmentShader}
      `;

      // Apply lunar color palette matching MoonMaterial exactly
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        
        // Lunar color palette (match MoonMaterial exactly)
        vec3 darkMoon = vec3(0.08, 0.08, 0.10);    // Deep crater bottoms
        vec3 lightMoon = vec3(0.55, 0.53, 0.51);   // Crater rims / fresh ejecta
        vec3 baseColor = vec3(0.25, 0.24, 0.23);   // Default mid-tone
        
        // Use average height (0.5) to match terrain mid-tone
        // This approximates what terrain produces when color variation/noise are disabled
        float surfaceHeight = 0.5;
        vec3 surfaceColor = mix(darkMoon, lightMoon, surfaceHeight);
        
        // Blend base color with height-based color (match MoonMaterial's uBaseColorBlend)
        vec3 rockColor = mix(baseColor, surfaceColor, uBaseColorBlend);
        
        // Apply color and brightness boost (match MoonMaterial)
        diffuseColor.rgb *= rockColor * uBrightnessBoost;
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
      } else if (key === 'brightnessBoost') {
        this.shaderUniforms.uBrightnessBoost.value = value;
      } else if (key === 'baseColorBlend') {
        this.shaderUniforms.uBaseColorBlend.value = value;
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
