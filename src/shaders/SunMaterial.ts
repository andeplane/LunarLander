import * as THREE from 'three';

/**
 * Custom Sun material with intense emissive glow
 * 
 * The sun appears as a bright glowing sphere that will trigger
 * the bloom post-processing effect. Uses a custom shader for
 * a realistic solar appearance with limb darkening.
 */

const sunVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vUv = uv;
  vNormal = normalize(normalMatrix * normal);
  
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = -mvPosition.xyz;
  
  gl_Position = projectionMatrix * mvPosition;
}
`;

const sunFragmentShader = /* glsl */ `
uniform vec3 sunColor;
uniform float intensity;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vViewPosition;

void main() {
  vec3 normal = normalize(vNormal);
  vec3 viewDir = normalize(vViewPosition);
  
  // Limb darkening - edges of sun appear slightly darker
  float cosAngle = max(dot(normal, viewDir), 0.0);
  
  // Limb darkening coefficients (realistic solar values)
  float limbDarkening = 0.3 + 0.7 * pow(cosAngle, 0.5);
  
  // Corona/glow effect at edges
  float edge = 1.0 - cosAngle;
  float corona = pow(edge, 2.0) * 0.5;
  
  // Final color with high intensity for bloom
  vec3 color = sunColor * intensity * limbDarkening;
  
  // Add slight orange tint to corona
  vec3 coronaColor = vec3(1.0, 0.8, 0.4) * intensity * corona;
  color += coronaColor;
  
  gl_FragColor = vec4(color, 1.0);
}
`;

export interface SunMaterialOptions {
  color?: THREE.Color | number;
  intensity?: number;
}

export class SunMaterial extends THREE.ShaderMaterial {
  constructor(options: SunMaterialOptions = {}) {
    const color = options.color instanceof THREE.Color 
      ? options.color 
      : new THREE.Color(options.color ?? 0xffffee);
    
    const intensity = options.intensity ?? 3.0;
    
    super({
      vertexShader: sunVertexShader,
      fragmentShader: sunFragmentShader,
      uniforms: {
        sunColor: { value: color },
        intensity: { value: intensity },
      },
      // Disable depth write so sun doesn't occlude stars
      depthWrite: false,
      // Render after skybox but before terrain
      transparent: false,
    });
  }
  
  /**
   * Set the sun color
   */
  setColor(color: THREE.Color | number): void {
    if (color instanceof THREE.Color) {
      this.uniforms.sunColor.value.copy(color);
    } else {
      this.uniforms.sunColor.value.set(color);
    }
  }
  
  /**
   * Set the intensity (affects bloom strength)
   */
  setIntensity(intensity: number): void {
    this.uniforms.intensity.value = intensity;
  }
}
