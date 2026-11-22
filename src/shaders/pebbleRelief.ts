import { MAX_PEBBLE_HEIGHT_UV } from './regolithDetail';
import { regolithTiling } from './regolithTiling';

// The support grid covers 28 of the finest terrain cells on each axis.
export const PEBBLE_PATCH_RADIUS = 14;
export const PEBBLE_REACH = 4.8;

export const pebbleReliefVertex = /* glsl */ `
  ${regolithTiling}
  uniform sampler2D uPebbleHeights;
  uniform sampler2D uGroundSupport;
  uniform vec2 uPebbleGridStep;
  uniform vec3 uPebbleEye;
  uniform float uPebbleStrength;
  varying float vPebbleLift;

  // Collapse extra vertices continuously onto the coarser world lattice
  // before a moving patch swaps tessellation levels. Shared vertices stay put.
  vec2 pebbleGridPosition(vec2 local, out float pitch) {
    vec2 cell = local / uPebbleGridStep;
    vec2 distanceInCells = abs((modelMatrix[3].xz + local - uPebbleEye.xz) / uPebbleGridStep);
    vec2 fine = smoothstep(vec2(0.8), vec2(1.45), distanceInCells);
    vec2 medium = smoothstep(vec2(3.4), vec2(4.45), distanceInCells);
    cell = mix(cell, floor(cell * 8.0 + 0.0001) / 8.0, fine);
    cell = mix(cell, floor(cell * 2.0 + 0.0001) / 2.0, medium);
    vec2 spacing = mix(mix(vec2(1.0/16.0), vec2(1.0/8.0), fine), vec2(0.5), medium) * uPebbleGridStep;
    pitch = max(spacing.x, spacing.y);
    return cell * uPebbleGridStep;
  }

  vec4 pebbleSupport(vec2 local) {
    vec2 q = clamp(local / uPebbleGridStep + float(${PEBBLE_PATCH_RADIUS}), 0.0, float(${PEBBLE_PATCH_RADIUS * 2}));
    ivec2 a = min(ivec2(floor(q)), ivec2(${PEBBLE_PATCH_RADIUS * 2 - 1}));
    vec2 f = q - vec2(a);
    ivec2 d = a + ivec2(1, 0);
    ivec2 b = a + ivec2(0, 1);
    // Same diagonal as the visible terrain mesh.
    if (f.x + f.y <= 1.0) {
      return texelFetch(uGroundSupport, a, 0) * (1.0 - f.x - f.y)
        + texelFetch(uGroundSupport, d, 0) * f.x + texelFetch(uGroundSupport, b, 0) * f.y;
    }
    return texelFetch(uGroundSupport, a + ivec2(1), 0) * (f.x + f.y - 1.0)
      + texelFetch(uGroundSupport, d, 0) * (1.0 - f.y) + texelFetch(uGroundSupport, b, 0) * (1.0 - f.x);
  }

  float pebbleTap(vec2 uv, vec2 cell, float lod) {
    mat2 turn;
    return textureLod(uPebbleHeights, moonPatchUV(uv, cell, turn), lod).r;
  }

  float pebbleLayer(vec2 uv, float frequency, float pitch) {
    vec2 a, b, c;
    vec3 w;
    moonPatchWeights(uv, a, b, c, w);
    // Filter unresolved chips against vertex spacing, including the coarser outer mesh.
    float lod = max(0.0, log2(pitch * frequency * float(textureSize(uPebbleHeights, 0).x) * 0.65));
    float h = pebbleTap(uv, a, lod) * w.x;
    if (w.y > 0.003) h += pebbleTap(uv, b, lod) * w.y;
    if (w.z > 0.003) h += pebbleTap(uv, c, lod) * w.z;
    return h * ${MAX_PEBBLE_HEIGHT_UV.toFixed(10)} / frequency;
  }

  vec3 pebblePosition(vec2 local, vec4 support, float pitch) {
    vec2 ground = (modelMatrix * vec4(local.x, 0.0, local.y, 1.0)).xz;
    float range = distance(vec3(ground.x, support.w, ground.y), uPebbleEye);
    float reach = min(${PEBBLE_REACH.toFixed(1)}, float(${PEBBLE_PATCH_RADIUS - 1}) * min(uPebbleGridStep.x, uPebbleGridStep.y));
    float medium = 1.0 - smoothstep(reach * 0.52, reach, range);
    float fine = 1.0 - smoothstep(0.65, 1.55, range);
    float h = 0.0;
    if (medium > 0.0) h += medium * 0.46 * pebbleLayer(ground * 0.04348 + vec2(0.37, 0.11), 0.04348, pitch);
    if (fine > 0.0) h += fine * 0.85 * pebbleLayer(ground * 0.3448, 0.3448, pitch);
    vPebbleLift = uPebbleStrength * h;
    return vec3(local.x, support.w + vPebbleLift, local.y);
  }
`;

export const pebbleDiscard = 'if (vPebbleLift <= 0.0013) discard;';
