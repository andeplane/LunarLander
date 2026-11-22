import { PEBBLE_ARRIVAL_SECONDS, PEBBLE_FULL_PX, PEBBLE_TEXTURE_PX } from '../terrain/pebbleLod';

/** Shared vertex positions for the visible stone and its sun silhouette. */
export const pebbleReliefVertex = /* glsl */ `
  attribute vec4 chipGround; // world base XYZ and outline radius
  attribute vec4 chipForm;   // height, cos / sin of bearing, time first drawn
  attribute vec4 chipBed;    // local terrain slope, albedo, buried fraction
  attribute vec3 chipProfile; // horizontal half-extents and mineral exposure
  uniform vec3 uPebbleEye;
  uniform vec3 uPebbleForward;
  uniform float uPebbleProjection;
  uniform float uPebbleTime;
  uniform float uPebbleStrength;
  varying vec3 vChipSurface;

  vec3 chipPosition(out vec3 surfaceNormal) {
    mat2 turn = mat2(chipForm.y, chipForm.z, -chipForm.z, chipForm.y);
    vec2 axes = chipGround.w * chipProfile.xy;
    vec2 delta = turn * (position.xz * axes);
    vec3 offset = chipGround.xyz - uPebbleEye;
    float depth = dot(offset, uPebbleForward);
    float pixels = max(axes.x, axes.y) * uPebbleProjection / max(0.001, depth > 0.0 ? depth : length(offset));
    float relief = smoothstep(${PEBBLE_TEXTURE_PX.toFixed(1)}, ${PEBBLE_FULL_PX.toFixed(1)}, pixels)
      * smoothstep(0.0, ${PEBBLE_ARRIVAL_SECONDS.toFixed(2)}, uPebbleTime - chipForm.w);
    delta *= smoothstep(0.0, 0.5, relief);
    float yScale = chipForm.x * uPebbleStrength * relief;
    float exposed = position.y * yScale - chipForm.x * (chipBed.w * relief + (1.0 - relief) * 0.04);
    // Inverse-transpose of the nonuniform scale, bearing and terrain shear.
    float ny = normal.y / max(yScale, chipGround.w*0.015);
    vec2 nxz = turn * (normal.xz / axes) - chipBed.xy*ny;
    surfaceNormal = normalize(vec3(nxz.x, ny, nxz.y));
    vChipSurface = vec3(chipBed.z, clamp(exposed/chipForm.x, 0.0, 1.0), chipProfile.z);
    return chipGround.xyz + vec3(delta.x, dot(chipBed.xy, delta) + exposed, delta.y);
  }
`;

/** Triplanar stone detail remains continuous around the crown and exposed fractures. */
export const pebbleSurfaceFragment = /* glsl */ `
  vec3 planes = pow(abs(meshNormal), vec3(4.0));
  planes /= planes.x + planes.y + planes.z;
  // Each texel represents roughly half a millimetre to a millimetre of rock.
  float exposure = vChipSurface.z;
  vec3 p = vWorldPosition * mix(6.8, 4.0, exposure);
  vec4 sideX = texture2D(uChipDetail, p.zy + vec2(0.43, 0.19));
  vec4 top = texture2D(uChipDetail, p.xz);
  vec4 sideZ = texture2D(uChipDetail, p.xy + vec2(0.12, 0.71));
  vec4 grit = sideX*planes.x + top*planes.y + sideZ*planes.z;
  vec3 bump = vec3(0.0,sideX.g-0.5,sideX.r-0.5)*planes.x
    + vec3(top.r-0.5,0.0,top.g-0.5)*planes.y + vec3(sideZ.r-0.5,sideZ.g-0.5,0.0)*planes.z;
  bump -= meshNormal * dot(bump, meshNormal);
  moonNormal = normalize(meshNormal - bump * (2.0 * MOON_SLOPE_RANGE * mix(0.39, 0.91, exposure)));
  float dust = smoothstep(0.18, 0.96, meshNormal.y) * (0.64 - 0.29*exposure + 0.12*(1.0-grit.a));
  vec3 stone = mix(MOON_ROCK_COLOR*0.95, MOON_SOIL_COLOR*1.12, dust);
  moonAlbedo = stone * (0.81 + 0.46*vChipSurface.x) * (1.0 + (grit.b-0.5)*mix(0.74,1.25,exposure))
    * mix(0.93, 1.0, grit.a) * mix(0.88, 1.0, smoothstep(0.0, 0.26, vChipSurface.y));
`;
