import { MeshStandardMaterial, Color } from 'three';
import { glslCommon } from './glsl_common';

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
  constructor() {
    super({
      color: new Color(0xaaaaaa),
      roughness: 0.92, // Lunar regolith is very rough
      metalness: 0.0,
      flatShading: false,
    });

    this.onBeforeCompile = (shader) => {
      // Add uniforms for tunability
      shader.uniforms.uScale = { value: 0.05 }; // Controls crater density (lower = larger craters)
      shader.uniforms.uDistortion = { value: 0.35 }; // Controls crater "wobble" (0 = perfect circles)
      shader.uniforms.uBumpStrength = { value: 0.4 }; // Visual depth intensity
      shader.uniforms.uDetailScale = { value: 0.5 }; // Fine detail scale

      // ==========================================
      // VERTEX SHADER MODIFICATIONS
      // ==========================================
      
      // Add varying for world position
      shader.vertexShader = `
        varying vec3 vWorldPosition;
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

      // ==========================================
      // FRAGMENT SHADER MODIFICATIONS
      // ==========================================

      // Add uniforms, varyings, and noise functions
      shader.fragmentShader = `
        varying vec3 vWorldPosition;
        uniform float uScale;
        uniform float uDistortion;
        uniform float uBumpStrength;
        uniform float uDetailScale;

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
        
        // Simplified: 2 crater layers instead of 3, 2D cellular instead of 3D
        float getSurfaceHeight(vec2 pos) {
          float scale = uScale;
          
          // A. Single noise sample for micro detail
          float noise = simplexNoise(pos * scale * 8.0) * 0.06;
          
          // B. Single distortion calculation (reused)
          float distortion = simplexNoise(pos * scale * 0.5);
          vec2 distortedPos = pos + vec2(distortion) * uDistortion;
          
          // C. Large craters (primary detail)
          float largeCraters = 1.0 - cellular2D(distortedPos * scale * 0.5);
          largeCraters = smoothstep(0.15, 0.85, largeCraters);
          
          // D. Medium craters (secondary detail) - reuse distortion with offset
          vec2 distortedPos2 = pos + vec2(distortion * 0.7) + vec2(100.0);
          float mediumCraters = 1.0 - cellular2D(distortedPos2 * scale * 1.5);
          mediumCraters = smoothstep(0.2, 0.8, mediumCraters);
          
          // Combine crater layers
          float craters = largeCraters * 0.6 + mediumCraters * 0.4;
          
          //return craters + noise;
          return noise;
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

        ${shader.fragmentShader}
      `;

      // ==========================================
      // INJECT NORMAL PERTURBATION
      // ==========================================
      
      // ==========================================
      // INJECT HEIGHT CALCULATION EARLY (before color_fragment)
      // Uses screen-space derivatives for gradient - only 1 height sample!
      // ==========================================
      
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        // Calculate height ONCE - use dFdx/dFdy for gradient (free GPU operation)
        vec2 terrainPos = vWorldPosition.xz;
        float surfaceHeight = getSurfaceHeight(terrainPos);
        
        // Screen-space derivatives give us the gradient for FREE
        vec2 heightGradient = vec2(dFdx(surfaceHeight), dFdy(surfaceHeight));
        
        #include <color_fragment>
        
        // Lunar color palette
        vec3 darkMoon = vec3(0.08, 0.08, 0.10);    // Deep crater bottoms
        vec3 lightMoon = vec3(0.55, 0.53, 0.51);   // Crater rims / fresh ejecta
        
        // Large-scale color variation (mare vs highlands) - cheap 2D noise
        float largeVariation = simplexNoise(terrainPos * 0.005) * 0.5 + 0.5;
        vec3 mareColor = vec3(0.12, 0.11, 0.13);   // Darker mare basalt
        vec3 highlandsColor = vec3(0.35, 0.33, 0.31); // Lighter highlands
        vec3 baseColor = mix(mareColor, highlandsColor, smoothstep(0.3, 0.7, largeVariation));
        
        // Height-based coloring (craters are darker, rims are lighter)
        vec3 surfaceColor = mix(darkMoon, lightMoon, surfaceHeight);
        
        // Blend base color with height-based color
        surfaceColor = mix(baseColor, surfaceColor, 0.6);
        
        // Apply to diffuse color
        diffuseColor.rgb *= surfaceColor * 2.5; // Boost overall brightness
        `
      );
      
      // ==========================================
      // INJECT NORMAL PERTURBATION (reuses cached gradient)
      // ==========================================

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `
        #include <normal_fragment_begin>

        // Use cached screen-space gradient for normal perturbation
        vec2 dHdxy = heightGradient * uBumpStrength * 80.0; // Scale bump strength

        // Perturb normal based on height gradient
        float moonFaceDir = gl_FrontFacing ? 1.0 : -1.0;
        normal = perturbNormalArb(vViewPosition, normal, dHdxy, moonFaceDir);
        `
      );
    };
  }
}
