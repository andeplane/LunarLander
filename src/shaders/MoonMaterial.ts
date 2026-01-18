import { MeshStandardMaterial, Color, Texture, Vector3 } from 'three';
import { glslCommon } from './glsl_common';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';

/**
 * Shader parameters interface for MoonMaterial
 */
export interface MoonMaterialParams {
  // Toggles
  enableColorVariation: boolean;
  enableTexture: boolean;

  // Color parameters
  colorVariationFrequency: number; // Color variation frequency
  baseColorBlend: number; // Base color blend factor
  brightnessBoost: number; // Brightness boost multiplier

  // Curvature parameters
  enableCurvature: boolean;
  planetRadius: number; // Virtual planet radius in meters

  // Texture LOD parameters
  textureLowDetail?: Texture | null; // Low detail texture (shown when far)
  textureHighDetail?: Texture | null; // High detail texture (shown when close)
  textureLodDistance?: number; // Distance threshold for blending (in meters, default: 50)

  // Hex tiling parameters
  enableHexTiling?: boolean; // Enable hex tiling to eliminate repetition (default: true)
  hexPatchScale?: number; // Controls hex tile size (larger = smaller tiles = more breakup, default: 6)
  hexContrastCorrection?: boolean; // Enable contrast-corrected blending (default: true)
  
  // Texture UV scale (default: 0.2 = texture repeats every 5 meters)
  textureUvScale?: number;
  
  // Height-based UV scale interpolation
  nonHexUvScale?: number; // UV scale for non-hex tiling at low altitude (default: 0.22)
  hexUvScale?: number; // UV scale for hex tiling at high altitude (default: 0.1)
}

/**
 * MoonMaterial - Unified lunar surface shader for terrain and rocks
 * 
 * Works with both regular meshes (terrain) and instanced meshes (rocks).
 * Supports color variation, curvature, and optional texture mapping.
 * 
 * Key features:
 * - Gray lunar color palette with mare/highlands variation
 * - Planetary curvature support
 * - Instancing support for rocks
 * - Optional texture slot for future use
 */
export class MoonMaterial extends MeshStandardMaterial {
  private shaderUniforms: { [key: string]: { value: any } } | null = null;
  private params: MoonMaterialParams;

  constructor() {
    super({
      color: new Color(0xaaaaaa),
      roughness: 0.9, // Moon dust is extremely rough and non-reflective
      metalness: 0.1,
      flatShading: false,
    });

    // Initialize default parameters
    this.params = {
      enableColorVariation: true,
      enableTexture: true,
      colorVariationFrequency: 0.005,
      baseColorBlend: 0.6,
      brightnessBoost: 1.2,
      enableCurvature: true,
      planetRadius: DEFAULT_PLANET_RADIUS,
      textureLowDetail: null,
      textureHighDetail: null,
      textureLodDistance: 50.0, // 50 meters default blend distance
      enableHexTiling: true, // Enable hex tiling by default
      hexPatchScale: 6.0, // Default hex tile scale
      hexContrastCorrection: true, // Enable contrast correction by default
      textureUvScale: 0.8, // Default UV scale
      nonHexUvScale: 0.22, // Default non-hex UV scale
      hexUvScale: 0.1, // Default hex UV scale
    };

    this.onBeforeCompile = (shader) => {
      // Store reference to uniforms for later updates
      this.shaderUniforms = shader.uniforms;

      // Initialize uniforms
      shader.uniforms.uEnableColorVariation = { value: this.params.enableColorVariation ? 1.0 : 0.0 };
      shader.uniforms.uEnableTexture = { value: this.params.enableTexture ? 1.0 : 0.0 };
      shader.uniforms.uColorVariationFrequency = { value: this.params.colorVariationFrequency };
      shader.uniforms.uBaseColorBlend = { value: this.params.baseColorBlend };
      shader.uniforms.uBrightnessBoost = { value: this.params.brightnessBoost };
      shader.uniforms.uEnableCurvature = { value: this.params.enableCurvature ? 1.0 : 0.0 };
      shader.uniforms.uPlanetRadius = { value: this.params.planetRadius };
      
      // Sun direction uniform for horizon occlusion
      shader.uniforms.uSunDirection = { value: new Vector3(0, 1, 0) };
      
      // Texture LOD uniforms
      shader.uniforms.uTextureLowDetail = { value: this.params.textureLowDetail || null };
      shader.uniforms.uTextureHighDetail = { value: this.params.textureHighDetail || null };
      shader.uniforms.uTextureLodDistance = { value: this.params.textureLodDistance || 50.0 };
      shader.uniforms.uUseTextureLod = { 
        value: this.params.textureHighDetail ? 1.0 : 0.0 
      };
      
      // Hex tiling uniforms
      shader.uniforms.uEnableHexTiling = { value: this.params.enableHexTiling ? 1.0 : 0.0 };
      shader.uniforms.uHexPatchScale = { value: this.params.hexPatchScale || 6.0 };
      shader.uniforms.uHexContrastCorrection = { value: this.params.hexContrastCorrection ? 1.0 : 0.0 };
      shader.uniforms.uTextureUvScale = { value: this.params.textureUvScale || 0.8 };
      shader.uniforms.uNonHexUvScale = { value: this.params.nonHexUvScale || 0.22 };
      shader.uniforms.uHexUvScale = { value: this.params.hexUvScale || 0.1 };

      // ==========================================
      // VERTEX SHADER MODIFICATIONS
      // ==========================================
      
      // Add varying for world position, UV, and world normal
      shader.vertexShader = `
        varying vec3 vWorldPosition;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        uniform float uEnableCurvature;
        uniform float uPlanetRadius;
        ${shader.vertexShader}
      `;
      
      // Pass UV to fragment shader
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        `
        #include <uv_vertex>
        vUv = uv;
        `
      );

      // Pass world position and world normal to fragment shader (with instancing support)
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        #ifdef USE_INSTANCING
          vWorldPosition = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          vWorldNormal = normalize((modelMatrix * instanceMatrix * vec4(objectNormal, 0.0)).xyz);
        #else
          vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vWorldNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
        #endif
        `
      );

      // Apply planetary curvature (with instancing support)
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

      // ==========================================
      // FRAGMENT SHADER MODIFICATIONS
      // ==========================================

      // Add uniforms and varyings
      shader.fragmentShader = `
        varying vec3 vWorldPosition;
        varying vec2 vUv;
        varying vec3 vWorldNormal;
        
        // Toggle uniforms
        uniform float uEnableColorVariation;
        uniform float uEnableCurvature;
        uniform float uEnableTexture;
        
        // Color parameters
        uniform float uColorVariationFrequency;
        uniform float uBaseColorBlend;
        uniform float uBrightnessBoost;
        
        // Curvature parameters
        uniform float uPlanetRadius;
        
        // Sun direction for horizon occlusion
        uniform vec3 uSunDirection;
        
        // Texture LOD uniforms
        uniform sampler2D uTextureLowDetail;
        uniform sampler2D uTextureHighDetail;
        uniform float uTextureLodDistance;
        uniform float uUseTextureLod;
        
        // Hex tiling uniforms
        uniform float uEnableHexTiling;
        uniform float uHexPatchScale;
        uniform float uHexContrastCorrection;
        uniform float uTextureUvScale;
        uniform float uNonHexUvScale;
        uniform float uHexUvScale;

        ${glslCommon}

        ${shader.fragmentShader}
      `;

      // ==========================================
      // APPLY COLOR AND TEXTURE (before color_fragment)
      // ==========================================
      
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>
        
        // Calculate terrain position for color variation
        vec2 terrainPos = vWorldPosition.xz;
        
        // Lunar color palette
        vec3 darkMoon = vec3(0.08, 0.08, 0.10);    // Deep crater bottoms
        vec3 lightMoon = vec3(0.55, 0.53, 0.51);   // Crater rims / fresh ejecta
        
        // Large-scale color variation (mare vs highlands) - if enabled
        vec3 baseColor = vec3(0.25, 0.24, 0.23); // Default mid-tone
        if (uEnableColorVariation > 0.5) {
          float largeVariation = simplexNoise(terrainPos * uColorVariationFrequency) * 0.5 + 0.5;
          vec3 mareColor = vec3(0.12, 0.11, 0.13);   // Darker mare basalt
          vec3 highlandsColor = vec3(0.35, 0.33, 0.31); // Lighter highlands
          baseColor = mix(mareColor, highlandsColor, smoothstep(0.3, 0.7, largeVariation));
        }
        
        // Normal-based variation: upward-facing surfaces are lighter (dusty), sides/bottom darker
        vec3 worldNorm = normalize(vWorldNormal);
        float upFacing = worldNorm.y * 0.5 + 0.5; // 0 = down, 0.5 = side, 1 = up
        
        // Small-scale noise for local surface variation (breaks up uniformity on rocks)
        float localNoise = snoise3D(vWorldPosition * 2.0) * 0.15; // Higher frequency, subtle amplitude
        
        // Combine normal-based and noise-based variation for surface height
        float surfaceHeight = mix(0.3, 0.7, upFacing) + localNoise;
        surfaceHeight = clamp(surfaceHeight, 0.0, 1.0);
        
        vec3 surfaceColor = mix(darkMoon, lightMoon, surfaceHeight);
        
        // Blend base color with height-based color
        vec3 finalColor = mix(baseColor, surfaceColor, uBaseColorBlend);
        
        // Apply texture if enabled and available
        if (uEnableTexture > 0.5 && uUseTextureLod > 0.5) {
          // Height-based interpolation factor for hex tiling based on camera altitude
          // ≤5m: fully non-hex (factor = 0), ≥10m: fully hex (factor = 1)
          float cameraHeight = cameraPosition.y;
          float hexFactor = clamp((cameraHeight - 5.0) / (10.0 - 5.0), 0.0, 1.0);
          
          // Calculate separate UVs for non-hex and hex tiling using uniform values
          vec2 uvNonHex = terrainPos * uNonHexUvScale;
          vec2 uvHex = terrainPos * uHexUvScale;
          
          // Sample non-hex texture (regular sampling)
          vec3 nonHexColor = texture2D(uTextureHighDetail, uvNonHex).rgb;
          
          // Sample hex texture (always use hex tiling when hexFactor > 0)
          bool useContrastCorrect = uHexContrastCorrection > 0.5;
          vec3 hexColor = textureNoTileHex(uTextureHighDetail, uvHex, uHexPatchScale, useContrastCorrect);
          
          // Interpolate between non-hex and hex based on height
          vec3 texColor = mix(nonHexColor, hexColor, hexFactor);
          finalColor = mix(finalColor, texColor, 1.0);
        }

        diffuseColor.rgb *= finalColor * uBrightnessBoost;
        `
      );

      // ==========================================
      // NOTE: Per-fragment horizon occlusion was removed because it affects ALL lights
      // (including flashlight and spaceship lights), not just the sun.
      // The global sun intensity fade in CelestialSystem handles the main horizon effect.
      // ==========================================
    };
  }

  /**
   * Update a parameter and refresh uniforms
   */
  setParam<K extends keyof MoonMaterialParams>(key: K, value: MoonMaterialParams[K]): void {
    this.params[key] = value;
    this.updateUniforms();
  }

  /**
   * Get a parameter value
   */
  getParam<K extends keyof MoonMaterialParams>(key: K): MoonMaterialParams[K] {
    return this.params[key];
  }

  /**
   * Get all parameters
   */
  getParams(): MoonMaterialParams {
    return { ...this.params };
  }

  /**
   * Set all parameters at once
   */
  setParams(params: Partial<MoonMaterialParams>): void {
    Object.assign(this.params, params);
    this.updateUniforms();
  }

  /**
   * Set sun direction for horizon occlusion calculation
   * Should be called each frame with the current sun direction in world space
   * 
   * @param direction Sun direction vector (normalized, in world space)
   */
  setSunDirection(direction: Vector3): void {
    if (this.shaderUniforms && this.shaderUniforms.uSunDirection) {
      this.shaderUniforms.uSunDirection.value.copy(direction);
    }
  }

  /**
   * Update shader uniforms from current parameters
   */
  private updateUniforms(): void {
    if (!this.shaderUniforms) return;

    // Update toggle uniforms (convert boolean to float)
    this.shaderUniforms.uEnableColorVariation.value = this.params.enableColorVariation ? 1.0 : 0.0;
    this.shaderUniforms.uEnableTexture.value = this.params.enableTexture ? 1.0 : 0.0;

    // Update color parameters
    this.shaderUniforms.uColorVariationFrequency.value = this.params.colorVariationFrequency;
    this.shaderUniforms.uBaseColorBlend.value = this.params.baseColorBlend;
    this.shaderUniforms.uBrightnessBoost.value = this.params.brightnessBoost;

    // Update curvature parameters
    this.shaderUniforms.uEnableCurvature.value = this.params.enableCurvature ? 1.0 : 0.0;
    this.shaderUniforms.uPlanetRadius.value = this.params.planetRadius;

    // Update texture LOD parameters
    this.shaderUniforms.uTextureLowDetail.value = this.params.textureLowDetail || null;
    this.shaderUniforms.uTextureHighDetail.value = this.params.textureHighDetail || null;
    this.shaderUniforms.uTextureLodDistance.value = this.params.textureLodDistance || 50.0;
    this.shaderUniforms.uUseTextureLod.value = 
      this.params.textureHighDetail ? 1.0 : 0.0;

    // Update hex tiling parameters
    this.shaderUniforms.uEnableHexTiling.value = this.params.enableHexTiling ? 1.0 : 0.0;
    this.shaderUniforms.uHexPatchScale.value = this.params.hexPatchScale || 6.0;
    this.shaderUniforms.uHexContrastCorrection.value = this.params.hexContrastCorrection ? 1.0 : 0.0;
    this.shaderUniforms.uTextureUvScale.value = this.params.textureUvScale || 0.8;
    this.shaderUniforms.uNonHexUvScale.value = this.params.nonHexUvScale || 0.22;
    this.shaderUniforms.uHexUvScale.value = this.params.hexUvScale || 0.1;

    // Mark material as needing update
    this.needsUpdate = true;
  }
}
