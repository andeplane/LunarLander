import { Vector3 } from 'three';

// Worker prefetch starts while an approaching rock is still smaller than a pixel.
export const ROCK_PREFETCH_PX = 0.35;
export const ROCK_HIDDEN_PX = 0.55;
export const ROCK_FULL_PX = 1.5;

export function rockViewUniforms() {
  return { uRockEye: { value: new Vector3() }, uRockFocal: { value: 0 } };
}

// Both the sun depth pass and the main pass use the pilot's eye and focal length.
export const rockScreenVertex = /* glsl */ `
  uniform vec3 uRockEye;
  uniform float uRockFocal;
  #ifdef USE_INSTANCING
  float rockScreenScale() {
    if (uRockFocal <= 0.0) return 1.0;
    vec3 delta = (modelMatrix * instanceMatrix[3]).xyz - uRockEye;
    float diameter = max(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz));
    float px = diameter * uRockFocal / max(0.001, length(delta));
    return sqrt(smoothstep(${ROCK_HIDDEN_PX}, ${ROCK_FULL_PX}, px));
  }
  #endif
`;
