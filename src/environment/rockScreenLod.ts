import { Vector3, Vector4 } from 'three';

// Worker prefetch starts while an approaching rock is still smaller than a pixel.
export const ROCK_PREFETCH_PX = 0.75;
export const ROCK_HIDDEN_PX = 1.25;
export const ROCK_FULL_PX = 3;

export function rockViewUniforms() {
  return { uRockEye: { value: new Vector3() }, uRockView: { value: new Vector4(0, 0, 0, 0) } };
}

// Both the sun depth pass and the main pass use the pilot's eye and focal length.
export const rockScreenVertex = /* glsl */ `
  uniform vec3 uRockEye;
  uniform vec4 uRockView;
  #ifdef USE_INSTANCING
  float rockScreenScale() {
    if (uRockView.w <= 0.0) return 1.0;
    vec3 delta = (modelMatrix * instanceMatrix[3]).xyz - uRockEye;
    float depth = dot(delta, uRockView.xyz);
    float diameter = max(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz));
    float px = diameter * uRockView.w / max(0.001, depth > 0.0 ? depth : length(delta));
    return smoothstep(${ROCK_HIDDEN_PX.toFixed(2)}, ${ROCK_FULL_PX.toFixed(1)}, px);
  }
  #endif
`;
