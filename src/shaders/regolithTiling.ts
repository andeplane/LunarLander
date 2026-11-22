/** Addresses used by both the material and the world-space chip meshes. */
export const FINE_PEBBLE_FREQUENCY = 0.3448;
export const MEDIUM_PEBBLE_FREQUENCY = 0.04348;

export function patchTransform(x: number, z: number) {
  let key = Math.imul(x, 0x8da6b343) ^ Math.imul(z, 0xd8163841);
  key = Math.imul(key ^ (key >>> 16), 0x7feb352d);
  key = Math.imul(key ^ (key >>> 15), 0x846ca68b);
  key = (key ^ (key >>> 16)) >>> 0;
  const a = (key & 65535) / 65536,
    b = (key >>> 16) / 65536;
  const angle = a * 2 * Math.PI;
  return { angle, c: Math.cos(angle), s: Math.sin(angle), u: b, v: (a * 7.31 + b * 3.17) % 1 };
}

export const regolithTiling = /* glsl */ `
vec2 moonHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

vec2 moonPatchUV(vec2 uv, vec2 vertex, out mat2 rot) {
  #ifdef MOON_ATLAS_BROAD
    vec2 h = moonHash2(vertex);
  #else
    // Integer mixing gives the CPU and GPU the same rotations, including at negative cells.
    uvec2 cell = uvec2(ivec2(vertex));
    uint key = cell.x * 0x8da6b343u ^ cell.y * 0xd8163841u;
    key = (key ^ (key >> 16u)) * 0x7feb352du;
    key = (key ^ (key >> 15u)) * 0x846ca68bu;
    key ^= key >> 16u;
    vec2 h = vec2(key & 65535u, key >> 16u) / 65536.0;
  #endif
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
