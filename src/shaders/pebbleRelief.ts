/** Shared vertex positions for the visible stone and its sun silhouette. */
export const pebbleReliefVertex = /* glsl */ `
  attribute vec4 chipGround; // world base XYZ and outline radius
  attribute vec4 chipForm;   // height, cos / sin of bearing, visibility range
  attribute vec4 chipBed;    // local terrain slope, albedo, buried fraction
  attribute vec2 chipWidth;  // half-extents of the original mark
  uniform vec3 uPebbleEye;
  uniform float uPebbleStrength;
  varying vec2 vChipSurface;

  vec3 chipPosition(out vec3 surfaceNormal) {
    mat2 turn = mat2(chipForm.y, chipForm.z, -chipForm.z, chipForm.y);
    vec2 axes = chipGround.w * chipWidth;
    vec2 delta = turn * (position.xz * axes);
    float range = distance(chipGround.xyz, uPebbleEye);
    float relief = 1.0 - smoothstep(chipForm.w*0.68, chipForm.w, range);
    float yScale = chipForm.x * uPebbleStrength * relief;
    float exposed = position.y * yScale - chipForm.x * chipBed.w;
    // Inverse-transpose of the nonuniform scale, bearing and terrain shear.
    float ny = normal.y / max(yScale, chipGround.w*0.015);
    vec2 nxz = turn * (normal.xz / axes) - chipBed.xy*ny;
    surfaceNormal = normalize(vec3(nxz.x, ny, nxz.y));
    vChipSurface = vec2(chipBed.z, clamp(exposed/chipForm.x, 0.0, 1.0));
    return chipGround.xyz + vec3(delta.x, dot(chipBed.xy, delta) + exposed, delta.y);
  }
`;

/** Use the individual fracture planes for lighting, with a little rounding at the worn edges. */
export const pebbleSurfaceFragment = /* glsl */ `
  vec3 planes = pow(abs(meshNormal), vec3(4.0));
  planes /= planes.x + planes.y + planes.z;
  vec3 p = vWorldPosition * 2.32;
  vec4 sideX = texture2D(uDetailMap, p.zy);
  vec4 top = texture2D(uDetailMap, p.xz);
  vec4 sideZ = texture2D(uDetailMap, p.xy);
  vec4 grit = sideX*planes.x + top*planes.y + sideZ*planes.z;
  vec3 rockPos = vWorldPosition*48.0;
  float mineral = dot(planes, vec3(moonNoise(rockPos.zy),moonNoise(rockPos.xz),moonNoise(rockPos.xy)));
  float footprint = max(length(dFdx(vWorldPosition)),length(dFdy(vWorldPosition)));
  mineral *= 1.0-smoothstep(0.004,0.018,footprint);
  vec3 bump = vec3(0.0,sideX.g-0.5,sideX.r-0.5)*planes.x
    + vec3(top.r-0.5,0.0,top.g-0.5)*planes.y + vec3(sideZ.r-0.5,sideZ.g-0.5,0.0)*planes.z;
  moonNormal = normalize(meshNormal - bump*0.65);
  float dust = smoothstep(0.12, 0.92, meshNormal.y);
  vec3 stone = mix(MOON_ROCK_COLOR*0.9, MOON_SOIL_COLOR*1.20, dust*0.75);
  moonAlbedo = stone * (0.74 + 0.56*vChipSurface.x) * (1.0 + (grit.b-0.5)*0.75 + mineral*0.12)
    * mix(0.81, 1.0, smoothstep(0.0, 0.29, vChipSurface.y));
`;
