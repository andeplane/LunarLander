import { MeshStandardMaterial, Color } from 'three';
import { glslCommon } from './glsl_common';

/**
 * Shader parameters interface for MoonMaterial
 */
export interface MoonMaterialParams {
  // Toggles
  enableCraters: boolean;
  enableNoise: boolean;
  enableBumpMapping: boolean;
  enableColorVariation: boolean;

  // Base parameters
  scale: number; // Crater density (lower = larger craters)
  distortion: number; // Crater "wobble" (0 = perfect circles)
  bumpStrength: number; // Visual depth intensity
  detailScale: number; // Fine detail scale

  // Noise parameters
  noiseFrequency: number; // Noise frequency multiplier
  noiseAmplitude: number; // Noise amplitude
  distortionFrequency: number; // Distortion frequency multiplier

  // Crater parameters
  largeCraterScale: number; // Large crater scale multiplier
  mediumCraterScale: number; // Medium crater scale multiplier
  largeCraterSmoothMin: number; // Large crater smoothstep min
  largeCraterSmoothMax: number; // Large crater smoothstep max
  mediumCraterSmoothMin: number; // Medium crater smoothstep min
  mediumCraterSmoothMax: number; // Medium crater smoothstep max
  largeCraterWeight: number; // Large crater blend weight
  mediumCraterWeight: number; // Medium crater blend weight

  // Rock bump mapping
  rockDensity: number; // Threshold for rocks (0 = all rocks, 1 = no rocks)
  rockSize: number; // Frequency - lower = larger rocks
  rockSoftness: number; // Edge sharpness (0 = sharp, 1 = rounded)
  rockHeight: number; // How tall the rock bumps are

  // Color parameters
  colorVariationFrequency: number; // Color variation frequency
  baseColorBlend: number; // Base color blend factor
  brightnessBoost: number; // Brightness boost multiplier

  // Curvature parameters
  enableCurvature: boolean;
  planetRadius: number; // Virtual planet radius in meters
}

/**
 * MoonMaterial - Procedural lunar surface shader
 * 
 * Uses distorted Voronoi noise for crater patterns and procedural bump mapping
 * for visual depth. Works with existing CPU-generated terrain geometry.
 * 
 * Key features:
 * - Coordinate distortion for organic crater shapes (Ryan King Art technique)
 * - Cellular/Voronoi noise for crater patterns
 * - Procedural normal perturbation (bump mapping via finite differences)
 * - Gray lunar color palette with height-based variation
 */
export class MoonMaterial extends MeshStandardMaterial {
  private shaderUniforms: { [key: string]: { value: any } } | null = null;
  private params: MoonMaterialParams;

  constructor() {
    super({
      color: new Color(0xaaaaaa),
      roughness: 0.92, // Lunar regolith is very rough
      metalness: 0.0,
      flatShading: false,
    });

    // Initialize default parameters
    this.params = {
      enableCraters: false,
      enableNoise: true,
      enableBumpMapping: true,
      enableColorVariation: true,
      scale: 0.05,
      distortion: 0.35,
      bumpStrength: 0.4,
      detailScale: 0.5,
      noiseFrequency: 8.0,
      noiseAmplitude: 0.06,
      distortionFrequency: 0.5,
      largeCraterScale: 0.5,
      mediumCraterScale: 1.5,
      largeCraterSmoothMin: 0.15,
      largeCraterSmoothMax: 0.85,
      mediumCraterSmoothMin: 0.2,
      mediumCraterSmoothMax: 0.8,
      largeCraterWeight: 0.6,
      mediumCraterWeight: 0.4,
      rockDensity: 0.3,
      rockSize: 20.0,
      rockSoftness: 0.2,
      rockHeight: 0.5,
      colorVariationFrequency: 0.005,
      baseColorBlend: 0.6,
      brightnessBoost: 2.5,
      enableCurvature: true,
      planetRadius: 5000,
    };

    this.onBeforeCompile = (shader) => {
      // Store reference to uniforms for later updates
      this.shaderUniforms = shader.uniforms;

      // Initialize all uniforms
      shader.uniforms.uEnableCraters = { value: this.params.enableCraters ? 1.0 : 0.0 };
      shader.uniforms.uEnableNoise = { value: this.params.enableNoise ? 1.0 : 0.0 };
      shader.uniforms.uEnableBumpMapping = { value: this.params.enableBumpMapping ? 1.0 : 0.0 };
      shader.uniforms.uEnableColorVariation = { value: this.params.enableColorVariation ? 1.0 : 0.0 };
      
      shader.uniforms.uScale = { value: this.params.scale };
      shader.uniforms.uDistortion = { value: this.params.distortion };
      shader.uniforms.uBumpStrength = { value: this.params.bumpStrength };
      shader.uniforms.uDetailScale = { value: this.params.detailScale };
      
      shader.uniforms.uNoiseFrequency = { value: this.params.noiseFrequency };
      shader.uniforms.uNoiseAmplitude = { value: this.params.noiseAmplitude };
      shader.uniforms.uDistortionFrequency = { value: this.params.distortionFrequency };
      
      shader.uniforms.uLargeCraterScale = { value: this.params.largeCraterScale };
      shader.uniforms.uMediumCraterScale = { value: this.params.mediumCraterScale };
      shader.uniforms.uLargeCraterSmoothMin = { value: this.params.largeCraterSmoothMin };
      shader.uniforms.uLargeCraterSmoothMax = { value: this.params.largeCraterSmoothMax };
      shader.uniforms.uMediumCraterSmoothMin = { value: this.params.mediumCraterSmoothMin };
      shader.uniforms.uMediumCraterSmoothMax = { value: this.params.mediumCraterSmoothMax };
      shader.uniforms.uLargeCraterWeight = { value: this.params.largeCraterWeight };
      shader.uniforms.uMediumCraterWeight = { value: this.params.mediumCraterWeight };
      
      shader.uniforms.uRockDensity = { value: this.params.rockDensity };
      shader.uniforms.uRockSize = { value: this.params.rockSize };
      shader.uniforms.uRockSoftness = { value: this.params.rockSoftness };
      shader.uniforms.uRockHeight = { value: this.params.rockHeight };
      
      shader.uniforms.uColorVariationFrequency = { value: this.params.colorVariationFrequency };
      shader.uniforms.uBaseColorBlend = { value: this.params.baseColorBlend };
      shader.uniforms.uBrightnessBoost = { value: this.params.brightnessBoost };
      
      shader.uniforms.uEnableCurvature = { value: this.params.enableCurvature ? 1.0 : 0.0 };
      shader.uniforms.uPlanetRadius = { value: this.params.planetRadius };

      // ==========================================
      // VERTEX SHADER MODIFICATIONS
      // ==========================================
      
      // Add varying for world position
      shader.vertexShader = `
        varying vec3 vWorldPosition;
        uniform float uEnableCurvature;
        uniform float uPlanetRadius;
        ${shader.vertexShader}
      `;

      // Pass world position to fragment shader
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `
      );

      // Apply planetary curvature
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `
        vec4 worldPosition = modelMatrix * vec4( transformed, 1.0 );
        
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

      // Add uniforms, varyings, and noise functions
      shader.fragmentShader = `
        varying vec3 vWorldPosition;
        
        // Toggle uniforms
        uniform float uEnableCraters;
        uniform float uEnableNoise;
        uniform float uEnableBumpMapping;
        uniform float uEnableColorVariation;
        
        // Base parameters
        uniform float uScale;
        uniform float uDistortion;
        uniform float uBumpStrength;
        uniform float uDetailScale;
        
        // Noise parameters
        uniform float uNoiseFrequency;
        uniform float uNoiseAmplitude;
        uniform float uDistortionFrequency;
        
        // Crater parameters
        uniform float uLargeCraterScale;
        uniform float uMediumCraterScale;
        uniform float uLargeCraterSmoothMin;
        uniform float uLargeCraterSmoothMax;
        uniform float uMediumCraterSmoothMin;
        uniform float uMediumCraterSmoothMax;
        uniform float uLargeCraterWeight;
        uniform float uMediumCraterWeight;
        
        // Rock bump mapping
        uniform float uRockDensity;
        uniform float uRockSize;
        uniform float uRockSoftness;
        uniform float uRockHeight;
        
        // Color parameters
        uniform float uColorVariationFrequency;
        uniform float uBaseColorBlend;
        uniform float uBrightnessBoost;

        ${glslCommon}

        // ==========================================
        // OPTIMIZED 2D CELLULAR NOISE (for craters)
        // Using 2D instead of 3D - terrain is essentially a heightfield
        // ==========================================
        
        float cellular2D(vec2 P) {
          vec2 Pi = floor(P);
          vec2 Pf = P - Pi;
          
          float d = 1e30;
          
          // Search 3x3 neighborhood (9 iterations vs 27 for 3D)
          for (int i = -1; i <= 1; i++) {
            for (int j = -1; j <= 1; j++) {
              vec2 offset = vec2(float(i), float(j));
              vec2 cellPos = Pi + offset;
              
              // Simple hash for random offset
              vec2 p = fract(sin(vec2(
                dot(cellPos, vec2(127.1, 311.7)),
                dot(cellPos, vec2(269.5, 183.3))
              )) * 43758.5453);
              
              vec2 pointPos = offset + p - Pf;
              float dist = length(pointPos);
              d = min(d, dist);
            }
          }
          
          return d;
        }

        // ==========================================
        // OPTIMIZED LUNAR SURFACE HEIGHT FUNCTION
        // ==========================================
        
        float getSurfaceHeight(vec2 pos) {
          float scale = uScale;
          float height = 0.0;
          
          // A. Noise detail (if enabled)
          float noise = 0.0;
          if (uEnableNoise > 0.5) {
            noise = simplexNoise(pos * scale * uNoiseFrequency) * uNoiseAmplitude;
            height += noise;
          }
          
          // B. Craters (if enabled)
          if (uEnableCraters > 0.5) {
            // Distortion calculation
            float distortion = simplexNoise(pos * scale * uDistortionFrequency);
            vec2 distortedPos = pos + vec2(distortion) * uDistortion;
            
            // Large craters
            float largeCraters = 1.0 - cellular2D(distortedPos * scale * uLargeCraterScale);
            largeCraters = smoothstep(uLargeCraterSmoothMin, uLargeCraterSmoothMax, largeCraters);
            
            // Medium craters
            vec2 distortedPos2 = pos + vec2(distortion * 0.7) + vec2(100.0);
            float mediumCraters = 1.0 - cellular2D(distortedPos2 * scale * uMediumCraterScale);
            mediumCraters = smoothstep(uMediumCraterSmoothMin, uMediumCraterSmoothMax, mediumCraters);
            
            // Combine crater layers
            float craters = largeCraters * uLargeCraterWeight + mediumCraters * uMediumCraterWeight;
            height += craters;
          }
          
          return height;
        }

        // ==========================================
        // NORMAL PERTURBATION (Bump Mapping)
        // ==========================================
        
        vec3 perturbNormalArb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
          vec3 vSigmaX = dFdx(surf_pos);
          vec3 vSigmaY = dFdy(surf_pos);
          vec3 vN = surf_norm;
          vec3 R1 = cross(vSigmaY, vN);
          vec3 R2 = cross(vN, vSigmaX);
          float fDet = dot(vSigmaX, R1);
          fDet *= faceDirection;
          vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
          return normalize(abs(fDet) * surf_norm - vGrad);
        }

        // ==========================================
        // LUNAR REGOLITH TEXTURE (Dust/Gravel)
        // Multi-octave noise for realistic dusty surface
        // ==========================================
        
        float getRegolithHeight(vec2 pos) {
          float height = 0.0;
          
          // Fine dust texture (high frequency, low amplitude)
          float dust = simplexNoise(pos * uRockSize * 3.0) * 0.3;
          dust += simplexNoise(pos * uRockSize * 7.0) * 0.15;
          dust += simplexNoise(pos * uRockSize * 15.0) * 0.08;
          
          // Medium gravel/pebble undulations
          float gravel = simplexNoise(pos * uRockSize) * 0.5;
          
          // Combine: mostly dust with some gravel influence
          height = mix(dust, gravel, uRockDensity);
          
          // Apply softness as overall smoothing (higher = smoother)
          height = height * (1.0 - uRockSoftness * 0.5);
          
          return height * uRockHeight;
        }

        ${shader.fragmentShader}
      `;

      // ==========================================
      // INJECT HEIGHT CALCULATION EARLY (before color_fragment)
      // Uses screen-space derivatives for gradient - only 1 height sample!
      // ==========================================
      
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        // Calculate terrain position and surface height for coloring
        vec2 terrainPos = vWorldPosition.xz;
        float surfaceHeight = getSurfaceHeight(terrainPos);
        
        #include <color_fragment>
        
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
        
        // Height-based coloring (craters are darker, rims are lighter)
        vec3 surfaceColor = mix(darkMoon, lightMoon, surfaceHeight);
        
        // Blend base color with height-based color
        surfaceColor = mix(baseColor, surfaceColor, uBaseColorBlend);
        
        // Apply brightness boost
        diffuseColor.rgb *= surfaceColor * uBrightnessBoost;
        `
      );
      
      // ==========================================
      // INJECT NORMAL PERTURBATION (reuses cached gradient)
      // ==========================================

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `
        #include <normal_fragment_begin>

        // Use regolith texture for bump mapping (if enabled)
        if (uEnableBumpMapping > 0.5) {
          // Get regolith height at this position
          float regolithHeight = getRegolithHeight(terrainPos);
          // Screen-space derivatives for gradient
          vec2 regolithGradient = vec2(dFdx(regolithHeight), dFdy(regolithHeight));
          // Scale gradient for visible effect
          vec2 dHdxy = regolithGradient * 30.0;
          float moonFaceDir = gl_FrontFacing ? 1.0 : -1.0;
          normal = perturbNormalArb(vViewPosition, normal, dHdxy, moonFaceDir);
        }
        `
      );
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
   * Update shader uniforms from current parameters
   */
  private updateUniforms(): void {
    if (!this.shaderUniforms) return;

    // Update toggle uniforms (convert boolean to float)
    this.shaderUniforms.uEnableCraters.value = this.params.enableCraters ? 1.0 : 0.0;
    this.shaderUniforms.uEnableNoise.value = this.params.enableNoise ? 1.0 : 0.0;
    this.shaderUniforms.uEnableBumpMapping.value = this.params.enableBumpMapping ? 1.0 : 0.0;
    this.shaderUniforms.uEnableColorVariation.value = this.params.enableColorVariation ? 1.0 : 0.0;

    // Update base parameters
    this.shaderUniforms.uScale.value = this.params.scale;
    this.shaderUniforms.uDistortion.value = this.params.distortion;
    this.shaderUniforms.uBumpStrength.value = this.params.bumpStrength;
    this.shaderUniforms.uDetailScale.value = this.params.detailScale;

    // Update noise parameters
    this.shaderUniforms.uNoiseFrequency.value = this.params.noiseFrequency;
    this.shaderUniforms.uNoiseAmplitude.value = this.params.noiseAmplitude;
    this.shaderUniforms.uDistortionFrequency.value = this.params.distortionFrequency;

    // Update crater parameters
    this.shaderUniforms.uLargeCraterScale.value = this.params.largeCraterScale;
    this.shaderUniforms.uMediumCraterScale.value = this.params.mediumCraterScale;
    this.shaderUniforms.uLargeCraterSmoothMin.value = this.params.largeCraterSmoothMin;
    this.shaderUniforms.uLargeCraterSmoothMax.value = this.params.largeCraterSmoothMax;
    this.shaderUniforms.uMediumCraterSmoothMin.value = this.params.mediumCraterSmoothMin;
    this.shaderUniforms.uMediumCraterSmoothMax.value = this.params.mediumCraterSmoothMax;
    this.shaderUniforms.uLargeCraterWeight.value = this.params.largeCraterWeight;
    this.shaderUniforms.uMediumCraterWeight.value = this.params.mediumCraterWeight;

    // Update rock bump mapping
    this.shaderUniforms.uRockDensity.value = this.params.rockDensity;
    this.shaderUniforms.uRockSize.value = this.params.rockSize;
    this.shaderUniforms.uRockSoftness.value = this.params.rockSoftness;
    this.shaderUniforms.uRockHeight.value = this.params.rockHeight;

    // Update color parameters
    this.shaderUniforms.uColorVariationFrequency.value = this.params.colorVariationFrequency;
    this.shaderUniforms.uBaseColorBlend.value = this.params.baseColorBlend;
    this.shaderUniforms.uBrightnessBoost.value = this.params.brightnessBoost;

    // Update curvature parameters
    this.shaderUniforms.uEnableCurvature.value = this.params.enableCurvature ? 1.0 : 0.0;
    this.shaderUniforms.uPlanetRadius.value = this.params.planetRadius;

    // Mark material as needing update
    this.needsUpdate = true;
  }
}
