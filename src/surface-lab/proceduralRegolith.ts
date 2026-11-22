import { regolithNoise } from '../shaders/regolithNoise';

/**
 * Returns (dh/dx, dh/dz, albedo offset) at a ground position in metres.
 * The pixel footprint filters the field. It never changes feature positions.
 */
export const proceduralRegolith = /* glsl */ `
  ${regolithNoise}

  // At most one feature per occupied cell. Its entire profile fits inside,
  // so finding the nearest feature never requires a neighbouring-cell search.
  vec3 regolithFeature(vec2 p, float footprintInCells, uint seed, bool pebble) {
    uint bits = regolithHash(ivec2(floor(p)), seed);
    if ((bits & 255u) > 100u) return vec3(0.0);
    float sizeRoll = float((bits >> 8u) & 255u) / 255.0;
    float radius = 0.045 + 0.17 * sizeRoll * sizeRoll;
    float visible = 1.0 - smoothstep(0.16, 0.55, footprintInCells / radius);
    vec2 jitter = vec2((bits >> 16u) & 255u, bits >> 24u) / 255.0 - 0.5;
    vec2 d = fract(p) - 0.5 - jitter * (1.0 - 2.9 * radius);
    float t = length(d) / radius;
    if (t >= 1.45 || visible <= 0.0) return vec3(0.0);
    float age = float(regolithHash(ivec2(floor(p)), seed + 1u) >> 24u) / 255.0;
    if (pebble) {
      // Angular fragments have a flat top and an irregular bevel. The three
      // slab directions form a convex boundary with a closed, compact support.
      float a = age * 6.2831853;
      vec2 dir = vec2(cos(a), sin(a));
      mat2 rot = mat2(dir.x, dir.y, -dir.y, dir.x);
      vec2 q = rot * d / radius;
      vec2 face = vec2(1.15, 0.0) * sign(q.x);
      vec2 axis = vec2(0.36, 0.96);
      if (abs(dot(q, axis)) > dot(q, face)) face = axis * sign(dot(q, axis));
      axis = vec2(-0.73, 0.74);
      if (abs(dot(q, axis)) > dot(q, face)) face = axis * sign(dot(q, axis));
      float edge = dot(q, face);
      float mask = 1.0 - smoothstep(0.82, 1.0, edge);
      vec2 slope = -(face * rot) * smoothstep(0.16, 0.65, edge) * (0.24 + 0.28 * age);
      return vec3(slope, 0.32 * (age - 0.4)) * (visible * mask);
    }
    float fresh = age * age;
    float wall = t * (1.0 - smoothstep(0.72, 1.02, t));
    float apron = smoothstep(0.82, 1.02, t) * (1.0 - smoothstep(1.02, 1.45, t));
    vec2 slope = d / max(length(d), 1e-7) * (wall - 0.48 * apron) * (0.12 + 0.43 * fresh);
    float tone = fresh * (0.13 * apron - 0.08 * (1.0 - smoothstep(0.6, 1.0, t)));
    return vec3(slope, tone) * visible;
  }

  // The photo was high-pass filtered once. Its zero-mean residual lets us
  // preserve contrast across patch boundaries with three mipmapped reads.
  float regolithGrainTap(vec2 ground, vec2 dx, vec2 dy, ivec2 cell) {
    uint h = regolithHash(cell, 4201u);
    mat2 turn = (h & 1u) == 0u ? mat2(1.0) : mat2(0, 1, -1, 0);
    if ((h & 2u) != 0u) turn = -turn;
    if ((h & 4u) != 0u) turn[0] = -turn[0];
    vec2 offset = vec2((h >> 8u) & 4095u, h >> 20u) / 4096.0;
    const vec2 scale = vec2(1.0 / 2.4, 1.0 / 1.6);
    float grain = textureGrad(uLabGrainMap, (turn * ground) * scale + offset,
      (turn * dx) * scale, (turn * dy) * scale).r;
    return (grain - 128.0 / 255.0) * (255.0 / 220.0);
  }

  float regolithGrain(vec2 ground, vec2 dx, vec2 dy) {
    vec2 q = mat2(1.0, 0.0, -0.57735027, 1.15470054) * (ground * 1.7);
    ivec2 base = ivec2(floor(q));
    vec2 f = fract(q);
    bool upper = f.x + f.y > 1.0;
    ivec2 corner = upper ? base + ivec2(1) : base;
    int direction = upper ? -1 : 1;
    vec2 w = upper ? 1.0 - f : f;
    vec3 weights = vec3(1.0 - w.x - w.y, w);
    weights *= weights;
    weights /= length(weights);
    return weights.x * regolithGrainTap(ground, dx, dy, corner)
      + weights.y * regolithGrainTap(ground, dx, dy, corner + ivec2(direction, 0))
      + weights.z * regolithGrainTap(ground, dx, dy, corner + ivec2(0, direction));
  }

  vec3 sampleProceduralRegolith(vec2 ground, vec2 dx, vec2 dy) {
    float footprint = max(length(dx), length(dy));
    const mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
    // Hybrid spends its near-field budget on the grain map. Five more widely
    // spaced soil bands and their scattered features carry the larger scales.
    mat2 bandTurn = uLabHybrid ? turn * turn : turn;
    float bandStep = uLabHybrid ? 0.32 * 0.32 : 0.32;
    mat2 basis = mat2(1.0);
    vec3 field = vec3(0.0);
    // Fixed world bands from 760 m down to 2.7 mm. Filtering only changes
    // their contribution. The unfiltered coarser field bends the next one
    // so the direction and spacing of the simplex lattice do not show through.
    float wavelength = 760.0;
    float warp = 0.0;
    vec2 warpGradient = vec2(0.0);
    const vec2 warpDirection = vec2(0.51, -0.38);
    for (int i = 0; i < 12; i++) {
      float ratio = footprint / wavelength;
      if (ratio >= 0.5 || (uLabHybrid && i >= 5)) break;
      int bandIndex = uLabHybrid ? i * 2 : i;
      // Bound the warped pixel footprint as well, especially at grazing angles.
      float stretch = 1.0 + length(warpDirection) * length(warpGradient) * wavelength;
      float weight = 1.0 - smoothstep(0.12, 0.5, ratio * stretch);
      vec2 p = (basis * ground) / wavelength + vec2(5.31, -7.83) * float(bandIndex + 1);
      uint seed = uint(bandIndex + 1) * 2246822519u;
      vec3 band = regolithNoise(p + warpDirection * warp, seed);
      vec2 gradient = band.xy * basis + dot(band.xy, warpDirection) * warpGradient * wavelength;
      // The broad differences mostly change soil colour. Save noticeable
      // relief for individual fragments, impact rims and close-up grains.
      float relief = mix(0.021, 0.003, smoothstep(0.006, 0.24, wavelength));
      float tone = bandIndex < 4 ? 0.083 : (bandIndex > 8 ? 0.105 : 0.056);
      if (uLabHybrid) tone *= 1.25;
      field += vec3(gradient * relief, band.z * tone) * weight;
      if (bandIndex % 2 == 0 || bandIndex == 9) {
        vec3 feature = regolithFeature(p, ratio, seed + 37u, wavelength < 0.15);
        field += vec3(feature.xy * basis, feature.z);
      }
      warp = band.z;
      warpGradient = gradient / wavelength;
      basis = bandTurn * basis;
      wavelength *= bandStep;
    }
    if (uLabHybrid && footprint < 0.048) {
      float visible = 1.0 - smoothstep(0.012, 0.048, footprint);
      field.z += regolithGrain(ground, dx, dy) * visible;
    }
    return field;
  }
`;
