/** Integer-hashed, world-space simplex noise with analytic slopes (xy) and value (z). */
export const regolithNoise = /* glsl */ `
  #ifndef LUNAR_REGOLITH_NOISE_DEFINED
  #define LUNAR_REGOLITH_NOISE_DEFINED
  uint regolithHash(ivec2 cell, uint seed) {
    uvec2 p = uvec2(cell);
    uint state = (p.x * 1597334677u ^ p.y * 3812015801u ^ seed) * 747796405u + 2891336453u;
    uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
    return (word >> 22u) ^ word;
  }

  // A simplex corner's gradient and value, evaluated in the same pass.
  vec3 regolithCorner(ivec2 id, vec2 d, uint seed) {
    float k = max(0.5 - dot(d, d), 0.0);
    float h = float(regolithHash(id, seed) >> 16u) / 65536.0 * 4.0;
    vec2 g = vec2(abs(h - 2.0) - 1.0, abs(mod(h + 1.0, 4.0) - 2.0) - 1.0);
    g *= inversesqrt(dot(g, g));
    float ramp = dot(g, d);
    float k3 = k * k * k;
    return vec3(k * g - 8.0 * ramp * d, k * ramp) * k3;
  }

  vec3 regolithNoise(vec2 p, uint seed) {
    const float skew = 0.366025404;
    const float unskew = 0.211324865;
    vec2 cell = floor(p + dot(p, vec2(skew)));
    vec2 d = p - (cell - dot(cell, vec2(unskew)));
    vec2 stepToMiddle = d.x > d.y ? vec2(1, 0) : vec2(0, 1);
    ivec2 id = ivec2(cell);
    return 70.0 * (regolithCorner(id, d, seed)
      + regolithCorner(id + ivec2(stepToMiddle), d - stepToMiddle + unskew, seed)
      + regolithCorner(id + ivec2(1), d - 1.0 + 2.0 * unskew, seed));
  }
  #endif
`;
