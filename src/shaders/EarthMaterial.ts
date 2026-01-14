import * as THREE from 'three';

/**
 * Custom Earth material with realistic day/night cycle
 * 
 * Features:
 * - Day side texture with clouds
 * - Night side with city lights
 * - Smooth terminator transition
 * - Atmospheric glow at edges
 * - Cloud layer that only shows on day side
 */

const earthVertexShader = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vUv = uv;
  // Transform normal to world space (not view space)
  // so it matches the world-space sunDirection uniform
  vNormal = normalize(mat3(modelMatrix) * normal);
  vPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const earthFragmentShader = /* glsl */ `
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D cloudsMap;
uniform sampler2D specularMap;
uniform vec3 sunDirection;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vPosition;

void main() {
  vec3 normal = normalize(vNormal);
  
  // Calculate sun-facing amount (-1 = facing away, 1 = facing sun)
  float sunFacing = dot(normal, sunDirection);
  
  // Smooth transition from night to day
  // -0.2 to 0.3 creates a nice terminator region
  float dayStrength = smoothstep(-0.2, 0.3, sunFacing);
  
  // Sample textures
  vec3 dayColor = texture2D(dayMap, vUv).rgb;
  vec3 nightColor = texture2D(nightMap, vUv).rgb;
  float clouds = texture2D(cloudsMap, vUv).r;
  float specular = texture2D(specularMap, vUv).r;
  
  // Add clouds to day side (clouds are white, so add them)
  vec3 dayWithClouds = mix(dayColor, vec3(1.0), clouds * 0.7);
  
  // Night side shows city lights (boost them slightly)
  vec3 nightLights = nightColor * 1.5;
  
  // Mix day and night based on sun facing
  vec3 baseColor = mix(nightLights, dayWithClouds, dayStrength);
  
  // Add atmospheric glow at the terminator (twilight zone)
  float twilightZone = smoothstep(-0.3, 0.0, sunFacing) * smoothstep(0.3, 0.0, sunFacing);
  vec3 twilightColor = vec3(1.0, 0.4, 0.2); // Orange-red twilight
  baseColor = mix(baseColor, twilightColor, twilightZone * 0.3);
  
  // Fresnel effect for atmospheric rim on day side
  vec3 viewDirection = normalize(cameraPosition - vPosition);
  float fresnel = 1.0 - max(dot(viewDirection, normal), 0.0);
  fresnel = pow(fresnel, 3.0);
  
  // Blue atmospheric rim on day side
  vec3 atmosphereColor = vec3(0.3, 0.6, 1.0);
  float atmosphereStrength = fresnel * dayStrength * 0.5;
  baseColor = mix(baseColor, atmosphereColor, atmosphereStrength);
  
  // Add specular highlight on water (day side only)
  vec3 reflectDir = reflect(-sunDirection, normal);
  float spec = pow(max(dot(viewDirection, reflectDir), 0.0), 32.0);
  baseColor += vec3(1.0) * spec * specular * dayStrength * 0.5;
  
  gl_FragColor = vec4(baseColor, 1.0);
}
`;

export interface EarthMaterialOptions {
  dayMapPath: string;
  nightMapPath: string;
  cloudsMapPath: string;
  specularMapPath: string;
}

export class EarthMaterial extends THREE.ShaderMaterial {
  private sunDirectionUniform: THREE.Uniform<THREE.Vector3>;
  
  constructor(options: EarthMaterialOptions) {
    const textureLoader = new THREE.TextureLoader();
    
    // Load textures with proper settings
    const dayMap = textureLoader.load(options.dayMapPath);
    dayMap.colorSpace = THREE.SRGBColorSpace;
    dayMap.anisotropy = 8;
    
    const nightMap = textureLoader.load(options.nightMapPath);
    nightMap.colorSpace = THREE.SRGBColorSpace;
    nightMap.anisotropy = 8;
    
    const cloudsMap = textureLoader.load(options.cloudsMapPath);
    cloudsMap.anisotropy = 8;
    
    const specularMap = textureLoader.load(options.specularMapPath);
    specularMap.anisotropy = 8;
    
    const sunDirectionUniform = new THREE.Uniform(new THREE.Vector3(1, 0, 0));
    
    super({
      vertexShader: earthVertexShader,
      fragmentShader: earthFragmentShader,
      uniforms: {
        dayMap: { value: dayMap },
        nightMap: { value: nightMap },
        cloudsMap: { value: cloudsMap },
        specularMap: { value: specularMap },
        sunDirection: sunDirectionUniform,
      },
    });
    
    this.sunDirectionUniform = sunDirectionUniform;
  }
  
  /**
   * Update the sun direction for the shader
   * @param direction Normalized direction vector pointing toward the sun
   */
  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirectionUniform.value.copy(direction);
  }
  
  /**
   * Dispose of material and textures
   */
  dispose(): void {
    const uniforms = this.uniforms;
    (uniforms.dayMap.value as THREE.Texture)?.dispose();
    (uniforms.nightMap.value as THREE.Texture)?.dispose();
    (uniforms.cloudsMap.value as THREE.Texture)?.dispose();
    (uniforms.specularMap.value as THREE.Texture)?.dispose();
    super.dispose();
  }
}
