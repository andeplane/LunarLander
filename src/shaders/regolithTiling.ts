/** Shared by ground shading and pebble displacement so both address the same stamp. */
export const regolithTiling = /* glsl */ `
vec2 moonHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec2 moonPatchUV(vec2 uv, vec2 vertex, out mat2 rot) {
  vec2 h = moonHash2(vertex);
  float angle = h.x * 6.2831853;
  vec2 turn = vec2(cos(angle), sin(angle));
  rot = mat2(turn.x, turn.y, -turn.y, turn.x);
  return rot * uv + vec2(h.y, fract(h.x * 7.31 + h.y * 3.17));
}

void moonPatchWeights(vec2 uv, out vec2 v1, out vec2 v2, out vec2 v3, out vec3 w) {
  vec2 skewed = mat2(1.0, 0.0, -0.57735027, 1.15470054) * (uv * 3.464);
  vec2 base = floor(skewed);
  vec3 bary = vec3(fract(skewed), 0.0);
  bary.z = 1.0 - bary.x - bary.y;
  w = bary.z > 0.0 ? vec3(bary.z, bary.y, bary.x) : vec3(-bary.z, 1.0 - bary.y, 1.0 - bary.x);
  v1 = bary.z > 0.0 ? base : base + vec2(1.0, 1.0);
  v2 = bary.z > 0.0 ? base + vec2(0.0, 1.0) : base + vec2(1.0, 0.0);
  v3 = bary.z > 0.0 ? base + vec2(1.0, 0.0) : base + vec2(0.0, 1.0);
  // Sharpen the blend so most of a triangle shows one clean copy
  w = w * w * w;
  w /= w.x + w.y + w.z;
}
`;
