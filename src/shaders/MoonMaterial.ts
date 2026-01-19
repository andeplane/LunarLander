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
  
  // Micro-detail parameters (Elevated-inspired)
  enableMicroDetail?: boolean; // Enable micro-normal perturbation (default: true)
  microDetailStrength?: number; // Strength of normal perturbation (default: 0.3)
  microDetailFrequency?: number; // Base frequency for detail noise (default: 2.0)
  microDetailOctaves?: number; // Number of noise octaves (default: 4)
  microDetailFadeStart?: number; // Distance where detail starts fading (default: 5.0 meters)
  microDetailFadeEnd?: number; // Distance where detail fully fades (default: 100.0 meters)
  
  // Enhanced lighting parameters
  enableFresnelRim?: boolean; // Enable fresnel rim lighting (default: true)
  fresnelRimStrength?: number; // Intensity of rim lighting (default: 0.15)
  fresnelRimPower?: number; // Fresnel exponent (default: 3.0)
  fresnelRimColor?: [number, number, number]; // Rim light color RGB (default: [0.6, 0.6, 0.7])
  
  enableSpecular?: boolean; // Enable subtle specular highlights (default: true)
  specularStrength?: number; // Specular intensity (default: 0.12)
  specularPower?: number; // Specular sharpness (default: 8.0)
  
  // Sun horizon fade (0 = below horizon, 1 = above horizon)
  sunHorizonFade?: number;
  
  // Debug mode (0 = normal, 1-6 = debug visualizations)
  debugMode?: number;
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
      
      // Micro-detail defaults (Elevated-inspired)
      enableMicroDetail: true,
      microDetailStrength: 0.3,
      microDetailFrequency: 2.0,
      microDetailOctaves: 4,
      microDetailFadeStart: 5.0,
      microDetailFadeEnd: 100.0,
      
      // Enhanced lighting defaults
      enableFresnelRim: true,
      fresnelRimStrength: 0.15,
      fresnelRimPower: 3.0,
      fresnelRimColor: [0.6, 0.6, 0.7],
      
      enableSpecular: true,
      specularStrength: 0.12,
      specularPower: 8.0,
      
      // Debug mode (0 = normal render)
      debugMode: 0,
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
      
      // Micro-detail uniforms (Elevated-inspired)
      shader.uniforms.uEnableMicroDetail = { value: this.params.enableMicroDetail ? 1.0 : 0.0 };
      shader.uniforms.uMicroDetailStrength = { value: this.params.microDetailStrength || 0.3 };
      shader.uniforms.uMicroDetailFrequency = { value: this.params.microDetailFrequency || 2.0 };
      shader.uniforms.uMicroDetailOctaves = { value: this.params.microDetailOctaves || 4 };
      shader.uniforms.uMicroDetailFadeStart = { value: this.params.microDetailFadeStart || 5.0 };
      shader.uniforms.uMicroDetailFadeEnd = { value: this.params.microDetailFadeEnd || 100.0 };
      
      // Enhanced lighting uniforms
      shader.uniforms.uEnableFresnelRim = { value: this.params.enableFresnelRim ? 1.0 : 0.0 };
      shader.uniforms.uFresnelRimStrength = { value: this.params.fresnelRimStrength || 0.15 };
      shader.uniforms.uFresnelRimPower = { value: this.params.fresnelRimPower || 3.0 };
      shader.uniforms.uFresnelRimColor = { 
        value: new Vector3(
          this.params.fresnelRimColor?.[0] || 0.6,
          this.params.fresnelRimColor?.[1] || 0.6,
          this.params.fresnelRimColor?.[2] || 0.7
        )
      };
      
      shader.uniforms.uEnableSpecular = { value: this.params.enableSpecular ? 1.0 : 0.0 };
      shader.uniforms.uSpecularStrength = { value: this.params.specularStrength || 0.12 };
      shader.uniforms.uSpecularPower = { value: this.params.specularPower || 8.0 };
      
      // Sun horizon fade uniform (0 = below horizon, 1 = above horizon)
      shader.uniforms.uSunHorizonFade = { value: this.params.sunHorizonFade ?? 1.0 };
      
      // Debug mode uniform
      shader.uniforms.uDebugMode = { value: this.params.debugMode || 0.0 };

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
        
        // Micro-detail uniforms (Elevated-inspired)
        uniform float uEnableMicroDetail;
        uniform float uMicroDetailStrength;
        uniform float uMicroDetailFrequency;
        uniform float uMicroDetailOctaves;
        uniform float uMicroDetailFadeStart;
        uniform float uMicroDetailFadeEnd;
        
        // Enhanced lighting uniforms
        uniform float uEnableFresnelRim;
        uniform float uFresnelRimStrength;
        uniform float uFresnelRimPower;
        uniform vec3 uFresnelRimColor;
        
        uniform float uEnableSpecular;
        uniform float uSpecularStrength;
        uniform float uSpecularPower;
        
        // Sun horizon fade factor (0 = sun below horizon, 1 = sun above horizon)
        // This matches the fade applied to the main sun directional light in CelestialSystem.
        // Used to fade custom lighting effects (fresnel, specular) when the sun sets
        // due to planetary curvature, ensuring they match the overall scene lighting.
        uniform float uSunHorizonFade;
        
        // Debug mode uniform
        uniform float uDebugMode;

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
        
        // Calculate distance to fragment for detail fading
        float fragmentDistance = length(vWorldPosition - cameraPosition);
        
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
        
        // Base mesh normal
        vec3 meshNormal = normalize(vWorldNormal);
        
        // ==========================================
        // MICRO-DETAIL NORMAL PERTURBATION (Elevated-inspired)
        // ==========================================
        vec3 worldNorm = meshNormal;
        
        // Declare these outside if blocks for debug access
        float detailFade = 0.0;
        vec3 microNormal = vec3(0.0, 1.0, 0.0); // Default: pointing up
        
        if (uEnableMicroDetail > 0.5) {
          // Calculate detail fade based on distance
          detailFade = 1.0 - smoothstep(uMicroDetailFadeStart, uMicroDetailFadeEnd, fragmentDistance);
          
          if (detailFade > 0.01) {
            // Compute micro-normal using derivative-based FBM
            // Use integer octaves (convert from float uniform)
            int octaves = int(uMicroDetailOctaves);
            microNormal = computeMicroNormal(
              terrainPos, 
              uMicroDetailFrequency, 
              uMicroDetailStrength * detailFade,
              octaves
            );
            
            // Blend micro-normal with mesh normal
            worldNorm = blendNormals(meshNormal, microNormal, detailFade);
          }
        }
        
        // Normal-based variation: upward-facing surfaces are lighter (dusty), sides/bottom darker
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

        // ==========================================
        // DEBUG VISUALIZATION
        // Mode 0: Normal render
        // Mode 1: meshNormal (vertex normal)
        // Mode 2: microNormal (detail normal)
        // Mode 3: worldNorm (blended normal)
        // Mode 4: detailFade (distance fade)
        // Mode 5: viewDir (direction to camera)
        // Mode 6: gl_FrontFacing
        // ==========================================
        if (uDebugMode > 0.5) {
          vec3 debugColor = vec3(1.0, 0.0, 1.0); // Magenta = invalid mode
          
          if (uDebugMode < 1.5) {
            // Mode 1: meshNormal - should NOT change with camera rotation
            debugColor = meshNormal * 0.5 + 0.5;
          } else if (uDebugMode < 2.5) {
            // Mode 2: microNormal - should NOT change with camera rotation
            debugColor = microNormal * 0.5 + 0.5;
          } else if (uDebugMode < 3.5) {
            // Mode 3: worldNorm (blended) - should NOT change with camera rotation
            debugColor = worldNorm * 0.5 + 0.5;
          } else if (uDebugMode < 4.5) {
            // Mode 4: detailFade - should NOT change with camera rotation
            debugColor = vec3(detailFade);
          } else if (uDebugMode < 5.5) {
            // Mode 5: viewDir - should NOT change with camera rotation (only position)
            vec3 vd = normalize(cameraPosition - vWorldPosition);
            debugColor = vd * 0.5 + 0.5;
          } else if (uDebugMode < 6.5) {
            // Mode 6: gl_FrontFacing - MIGHT change with camera rotation!
            debugColor = gl_FrontFacing ? vec3(1.0) : vec3(0.0);
          }
          
          diffuseColor.rgb = debugColor;
        } else {
          diffuseColor.rgb *= finalColor * uBrightnessBoost;
        }
        `
      );

      // ==========================================
      // NOTE: We do NOT override normal_fragment_begin
      // Three.js's vNormal is in VIEW SPACE, our worldNorm is in WORLD SPACE
      // Mixing them causes camera-angle-dependent lighting bugs
      // Our custom fresnel/specular use worldNorm directly for micro-detail effects
      // ==========================================
      
      // ==========================================
      // ADD FRESNEL RIM LIGHTING AND SPECULAR
      // Added after standard lighting calculations
      // ==========================================
      
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `
        // In debug mode, output debug color directly and skip ALL lighting
        if (uDebugMode > 0.5) {
          // Output debug color directly, bypassing all lighting
          gl_FragColor = vec4(diffuseColor.rgb, 1.0);
          return;
        }
        
        // DEBUG: Temporarily disable custom fresnel/specular to isolate bug
        // Mode 7 = disable fresnel only, Mode 8 = disable specular only, Mode 9 = disable both
        bool skipFresnel = uDebugMode > 6.5 && uDebugMode < 8.5; // 7 or 8
        bool skipSpecular = uDebugMode > 7.5; // 8 or 9
        
        // Normal mode: apply custom lighting effects
        // ==========================================
        // FRESNEL RIM LIGHTING (dusty lunar surface glow)
        // Simulates light scattering from lunar dust at grazing angles.
        // Only visible when there's a light source (sun) above the horizon.
        // ==========================================
        if (uEnableFresnelRim > 0.5 && !skipFresnel) {
          // View direction (from fragment to camera)
          vec3 toCamera = cameraPosition - vWorldPosition;
          float distToCamera = length(toCamera);
          
          // Safety: skip fresnel if camera is too close (would cause NaN from normalize)
          if (distToCamera > 0.001) {
            vec3 viewDir = toCamera / distToCamera; // Safe normalize
            
            // Fresnel term: stronger at grazing angles
            float dotVN = dot(viewDir, worldNorm);
            float fresnel = pow(max(1.0 - max(dotVN, 0.0), 0.0), uFresnelRimPower);
            
            // Apply rim light (adds subtle glow at edges)
            vec3 rimLight = fresnel * uFresnelRimColor * uFresnelRimStrength;
            
            // Apply horizon fade - no rim glow when sun is below horizon
            // (if there's no light source, there's no light to scatter)
            outgoingLight += rimLight * uSunHorizonFade;
          }
        }
        
        // ==========================================
        // ENHANCED SPECULAR (subtle lunar regolith highlights)
        // Simulates dust particles catching and reflecting sunlight.
        // Only visible when there's a light source (sun) above the horizon.
        // ==========================================
        if (uEnableSpecular > 0.5 && !skipSpecular) {
          // View direction (with safety check)
          vec3 toCamera = cameraPosition - vWorldPosition;
          float distToCamera = length(toCamera);
          
          // Safety: skip specular if camera is too close (would cause NaN from normalize)
          if (distToCamera > 0.001) {
            vec3 viewDir = toCamera / distToCamera; // Safe normalize
            
            // Sun direction (use the uniform we already have)
            vec3 sunDir = normalize(uSunDirection);
            
            // Half-vector for Blinn-Phong specular
            // Safety: check if sunDir + viewDir is near zero (sun behind camera)
            vec3 halfSum = sunDir + viewDir;
            float halfLen = length(halfSum);
            
            if (halfLen > 0.001) {
              vec3 halfVec = halfSum / halfLen; // Safe normalize
              
              // Specular term
              float spec = pow(max(dot(worldNorm, halfVec), 0.0), uSpecularPower);
              
              // Only apply specular when sun is above horizon (dot with normal > 0)
              float sunFacing = max(dot(worldNorm, sunDir), 0.0);
              spec *= sunFacing;
              
              // Subtle warm-tinted specular (dust particles catching sunlight)
              vec3 specColor = vec3(1.0, 0.95, 0.9) * uSpecularStrength;
              
              // Apply horizon fade - no specular when sun is below horizon
              outgoingLight += spec * specColor * uSunHorizonFade;
            }
          }
        }
        
        #include <opaque_fragment>
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
   * Set sun horizon fade factor
   * Should be called each frame with the current horizon fade (0 = below horizon, 1 = above horizon)
   * 
   * @param fade Horizon fade factor (0-1)
   */
  setSunHorizonFade(fade: number): void {
    if (this.shaderUniforms && this.shaderUniforms.uSunHorizonFade) {
      this.shaderUniforms.uSunHorizonFade.value = fade;
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
    
    // Update micro-detail parameters
    this.shaderUniforms.uEnableMicroDetail.value = this.params.enableMicroDetail ? 1.0 : 0.0;
    this.shaderUniforms.uMicroDetailStrength.value = this.params.microDetailStrength || 0.3;
    this.shaderUniforms.uMicroDetailFrequency.value = this.params.microDetailFrequency || 2.0;
    this.shaderUniforms.uMicroDetailOctaves.value = this.params.microDetailOctaves || 4;
    this.shaderUniforms.uMicroDetailFadeStart.value = this.params.microDetailFadeStart || 5.0;
    this.shaderUniforms.uMicroDetailFadeEnd.value = this.params.microDetailFadeEnd || 100.0;
    
    // Update enhanced lighting parameters
    this.shaderUniforms.uEnableFresnelRim.value = this.params.enableFresnelRim ? 1.0 : 0.0;
    this.shaderUniforms.uFresnelRimStrength.value = this.params.fresnelRimStrength || 0.15;
    this.shaderUniforms.uFresnelRimPower.value = this.params.fresnelRimPower || 3.0;
    this.shaderUniforms.uFresnelRimColor.value.set(
      this.params.fresnelRimColor?.[0] || 0.6,
      this.params.fresnelRimColor?.[1] || 0.6,
      this.params.fresnelRimColor?.[2] || 0.7
    );
    
    this.shaderUniforms.uEnableSpecular.value = this.params.enableSpecular ? 1.0 : 0.0;
    this.shaderUniforms.uSpecularStrength.value = this.params.specularStrength || 0.12;
    this.shaderUniforms.uSpecularPower.value = this.params.specularPower || 8.0;
    
    // Update sun horizon fade
    this.shaderUniforms.uSunHorizonFade.value = this.params.sunHorizonFade ?? 1.0;
    
    // Update debug mode
    this.shaderUniforms.uDebugMode.value = this.params.debugMode || 0.0;

    // Mark material as needing update
    this.needsUpdate = true;
  }
}
