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
  rockDensity: number; // Threshold for rocks (0 = no rocks, 1 = many rocks)
  rockSize: number; // Frequency - HIGHER = SMALLER rocks
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
      roughness: 0.9, // Moon dust is extremely rough and non-reflective
      metalness: 0.1,
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
      rockDensity: 0.5, // Density of scattered rocks
      rockSize: 150.0,  // Scale (Higher = smaller/more rocks)
      rockSoftness: 0.1, // Sharpness of rocks
      rockHeight: 1.5,   // Height intensity
      colorVariationFrequency: 0.005,
      baseColorBlend: 0.6,
      brightnessBoost: 1.2,
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
        // SCATTERED ROCK GENERATOR
        // Creates discrete rocks instead of wavy noise
        // ==========================================
        
        float hash(vec2 p) {
            return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float getRocks(vec2 uv, float scale, float density, float seedOffset) {
            vec2 cell = floor(uv * scale);
            vec2 local = fract(uv * scale) - 0.5;
            
            // Random ID for this cell
            float r = hash(cell + vec2(seedOffset));
            
            // Filter by density (inverted logic: high r = keep)
            if (r > density) return 0.0;
            
            // Random position offset within the cell (-0.4 to 0.4)
            float rx = hash(cell + vec2(1.0 + seedOffset, 2.0));
            float ry = hash(cell + vec2(3.0 + seedOffset, 4.0));
            vec2 offset = vec2(rx, ry) - 0.5;
            
            // Calculate distance
            float d = length(local - offset * 0.8);
            
            // Random rock size
            float size = 0.25 + 0.25 * r; 
            
            // Rock shape profile (sharp falloff for solid object look)
            // Using smoothstep for antialiasing the edge
            return smoothstep(size, size - 0.05, d) * sqrt(max(0.0, 1.0 - d/size)); 
        }

        float getMicroCraters(vec2 uv, float scale, float density) {
            vec2 cell = floor(uv * scale);
            vec2 local = fract(uv * scale) - 0.5;
            
            float r = hash(cell + vec2(42.0));
            if (r > density) return 0.0;
            
            vec2 offset = vec2(hash(cell), hash(cell + 13.0)) - 0.5;
            float d = length(local - offset);
            float size = 0.3 + 0.2 * r; 
            
            // Inverted pit shape
            return -1.0 * smoothstep(size, size * 0.5, d) * (1.0 - smoothstep(size * 0.1, 0.0, d));
        }

        float getRegolithHeight(vec2 pos) {
          float height = 0.0;
          
          // 1. Very fine high-freq noise for dust/sand texture (Base Regolith)
          float dust = simplexNoise(pos * uRockSize * 4.0);
          height += dust * 0.01; // Much subtler - smooth gray base

          // 2. Small scattered pebbles (High frequency, lower height)
          float pebbles = getRocks(pos, uRockSize * 2.0, uRockDensity * 0.5, 0.0);
          height += pebbles * 0.15; // Fewer, subtler pebbles
          
          // 3. Larger scattered rocks (Lower frequency, higher height)
          float rocks = getRocks(pos, uRockSize * 0.5, uRockDensity * 0.4, 10.0);
          height += rocks * 1.0;
          
          // 4. Micro craters (Negative height)
          float pits = getMicroCraters(pos, uRockSize * 0.2, 0.4); // Constant density for pits
          height += pits * 0.5;

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
        
        // Add subtle noise to albedo to match regolith roughness (only if noise enabled)
        if (uEnableNoise > 0.5) {
          float albedoNoise = simplexNoise(terrainPos * 50.0) * 0.02;
          surfaceColor += vec3(albedoNoise);
        }

        diffuseColor.rgb *= surfaceColor * uBrightnessBoost;
        `
      );
      
      // ==========================================
      // INJECT NORMAL PERTURBATION (world-space normal reconstruction)
      // ==========================================

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `
        #include <normal_fragment_begin>

        if (uEnableBumpMapping > 0.5) {
          // Get regolith height at this position
          float regolithHeight = getRegolithHeight(terrainPos);
          
          // Use screen-space derivatives for gradient (standard bump mapping approach)
          vec2 regolithGradient = vec2(dFdx(regolithHeight), dFdy(regolithHeight));
          
          // Negate gradient so bumps appear as rocks (not holes)
          // Scale gradient for visible effect
          vec2 dHdxy = -regolithGradient * uBumpStrength * 30.0;
          
          // Clamp gradient magnitude to prevent unrealistic normal tilts
          // Max slope of 1.0 (45°) prevents black pixels with flashlight while
          // still allowing legitimate shadows from side lighting (sun)
          float maxSlope = 1.0;  // Max 45 degree tilt
          float slopeMag = length(dHdxy);
          if (slopeMag > maxSlope) {
            dHdxy = dHdxy * (maxSlope / slopeMag);
          }
          
          // Use standard perturbNormalArb function
          float moonFaceDir = gl_FrontFacing ? 1.0 : -1.0;
          normal = perturbNormalArb(-vViewPosition, normal, dHdxy, moonFaceDir);
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
