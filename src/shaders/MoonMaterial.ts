import { rockScreenVertex, rockViewUniforms } from '../environment/rockScreenLod';
import { Color, type DataTexture, MeshStandardMaterial, ShaderChunk, type Texture, Vector3 } from 'three';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';
import { SUN_SHADOW_FRAGMENT_PARS, type SunShadowUniforms } from '../rendering/SunShadows';
import {
  createRegolithDetailTexture,
  generateRegolithDetail,
  generateStoneDetail,
  type PebbleStamp,
  REGOLITH_SLOPE_RANGE,
} from './regolithDetail';
import { pebbleSurfaceFragment } from './pebbleRelief';
import { FINE_PEBBLE_FREQUENCY, MEDIUM_PEBBLE_FREQUENCY, regolithTiling } from './regolithTiling';
import { regolithNoise } from './regolithNoise';

/**
 * Shader parameters interface for MoonMaterial
 */
export interface MoonMaterialParams {
  /** Large-scale tonal mottling of the soil. */
  enableColorVariation: boolean;
  /** Overall albedo multiplier. */
  brightnessBoost: number;

  // Curvature parameters
  enableCurvature: boolean;
  /** Virtual planet radius in meters. */
  planetRadius: number;

  /** Regolith detail map (grain, pebbles, craterlets) on or off. */
  enableDetail: boolean;
  /** Additional sampled terrain layers: 0 = broad soil, 1 = clumps, 2 = clumps and grains. */
  groundTextureLayers: number;
  /** Multiplier for the surface normals of stones, including close-up chips. */
  rockBump: number;
  /** Strength of the detail normals (1 = as authored). */
  detailStrength: number;
  /** Physical height multiplier of nearby chips. Zero keeps their original ground shading. */
  pebbleHeight: number;
  /** Contrast of the detail albedo speckle (1 = as authored). */
  detailContrast: number;
  /** Strength of the procedural craterlets drawn below mesh resolution. */
  craterletStrength: number;

  /** 0 = Lambert, 1 = Lommel-Seeliger (dusty, no limb darkening). */
  backscatter: number;
  /** Extra brightness looking straight down-sun (opposition effect). */
  oppositionSurge: number;
  /** Light bounced into shadows from the sunlit ground, as irradiance. */
  ambientFill: number;
  /** 0 = ignore sun shadow maps, 1 = full shadows. */
  shadowStrength: number;

  /** Sun horizon fade (0 = below horizon, 1 = above horizon). */
  sunHorizonFade: number;

  /**
   * Debug view: 0 = normal render, 1 = mesh normal, 2 = detail normal,
   * 3 = sun visibility (shadows), 4 = albedo, 5 = lighting only.
   */
  debugMode: number;
}

export type MoonMaterialVariant = 'terrain' | 'rock';

export interface MoonMaterialOptions {
  variant?: MoonMaterialVariant;
  /** The lab can compare the previous 190 m detail-map layer with world-space soil. */
  broadRelief?: 'world' | 'atlas';
  /** Detail map override (tests, or a custom map). Defaults to the shared generated one. */
  detailMap?: Texture;
}

interface MoonMaterialUniforms {
  uEnableColorVariation: { value: number };
  uBrightnessBoost: { value: number };
  uEnableCurvature: { value: number };
  uPlanetRadius: { value: number };
  uSunDirection: { value: Vector3 };
  uDetailMap: { value: Texture };
  uGroundTextureLayers: { value: number };
  uRockBump: { value: number };
  uDetailStrength: { value: number };
  uDetailContrast: { value: number };
  uCraterletStrength: { value: number };
  uBackscatter: { value: number };
  uOppositionSurge: { value: number };
  uAmbientFill: { value: number };
  uShadowStrength: { value: number };
  uSunHorizonFade: { value: number };
  uDebugMode: { value: number };
}

const DETAIL_MAP_SIZE = 1024;
const DETAIL_MAP_SEED = 1969;

let sharedMaps: { detail: DataTexture; pebbles: PebbleStamp[] } | undefined;
let stoneDetail: DataTexture | undefined;

/**
 * The regolith detail map shared by terrain materials. Generated on first
 * use (a few hundred milliseconds) and kept for the lifetime of the page.
 */
export function getSharedRegolithDetailMap(): DataTexture {
  return getSharedMaps().detail;
}

/** Fractures and mineral grains shared by boulders and loose stone. */
export function getSharedStoneDetailMap(): DataTexture {
  stoneDetail ??= createRegolithDetailTexture(generateStoneDetail());
  return stoneDetail;
}

export function getSharedPebbleStamps(): readonly PebbleStamp[] {
  return getSharedMaps().pebbles;
}

function getSharedMaps() {
  if (!sharedMaps) {
    const field = generateRegolithDetail({ size: DETAIL_MAP_SIZE, seed: DETAIL_MAP_SEED });
    sharedMaps = { detail: createRegolithDetailTexture(field), pebbles: field.pebbles };
  }
  return sharedMaps;
}

/**
 * Anchor inside three's `lights_fragment_begin` chunk after which the
 * per-light regolith response is injected. If a three upgrade renames it the
 * material falls back to plain Lambert lighting; MoonMaterial.spec guards it.
 */
export const DIRECTIONAL_LIGHT_ANCHOR = 'getDirectionalLightInfo( directionalLight, directLight );';

const FRAGMENT_PARS = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vWorldNormal;

uniform float uEnableColorVariation;
uniform float uBrightnessBoost;
uniform vec3 uSunDirection;
uniform sampler2D uDetailMap;
uniform float uGroundTextureLayers;
uniform float uRockBump;
uniform float uDetailStrength;
uniform float uDetailContrast;
uniform float uCraterletStrength;
uniform float uBackscatter;
uniform float uOppositionSurge;
uniform float uAmbientFill;
uniform float uShadowStrength;
// Matches the fade CelestialSystem applies to the sun light as it sets
uniform float uSunHorizonFade;
uniform float uDebugMode;

const float MOON_SLOPE_RANGE = ${REGOLITH_SLOPE_RANGE.toFixed(4)};
// Lunar soil: warm grey, albedo ~0.14 (linear)
const vec3 MOON_SOIL_COLOR = vec3(0.122, 0.110, 0.094);
const vec3 MOON_ROCK_COLOR = vec3(0.108, 0.100, 0.090);

/**
 * Soft-limit the part of a detail slope that tilts the surface away from the
 * sun, so it approaches the limit instead of crossing the terminator.
 */
vec2 moonLimitSlope(vec2 slope, vec2 sunAlong, float limit) {
  float away = max(dot(slope, sunAlong), 0.0);
  return slope - sunAlong * (away - limit * away / (limit + away));
}

float moonHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Value noise in -1..1 that never repeats, unlike the tiled detail map. */
float moonNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = p - cell;
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = moonHash(cell);
  float b = moonHash(cell + vec2(1.0, 0.0));
  float c = moonHash(cell + vec2(0.0, 1.0));
  float d = moonHash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y) * 2.0 - 1.0;
}

${regolithTiling}

/**
 * Gradient noise in about -1..1. Unlike value noise it has no blobs sitting
 * on the lattice points, so no grid shows through from altitude.
 */
float moonGradientNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = p - cell;
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(moonHash2(cell) * 2.0 - 1.0, f);
  float b = dot(moonHash2(cell + vec2(1.0, 0.0)) * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(moonHash2(cell + vec2(0.0, 1.0)) * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(moonHash2(cell + vec2(1.0, 1.0)) * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y) * 1.6;
}

/**
 * Tonal mottling of the soil from 5 m to 2 km: seven octaves 2.7 apart, each
 * turned and shifted against the last and dropped once its wavelength is
 * down to a few pixels. Nothing in it is periodic.
 */
float moonMottle(vec2 p, float footprint) {
  float sum = 0.0;
  float wavelength = 5.0;
  float amplitude = 0.05;
  for (int i = 0; i < 7; i++) {
    float visible = 1.0 - smoothstep(wavelength * 0.12, wavelength * 0.4, footprint);
    if (visible > 0.0) {
      sum += moonGradientNoise(p / wavelength) * amplitude * visible;
    }
    p = vec2(0.8 * p.x + 0.6 * p.y, -0.6 * p.x + 0.8 * p.y) + 91.7;
    wavelength *= 2.7;
    amplitude *= 1.12;
  }
  return sum;
}

#if !defined(MOON_ROCK) && !defined(MOON_ATLAS_BROAD)
${regolithNoise}

// Broad slopes and albedo belong to this location on the Moon. The fine map
// still supplies angular fragments and dust at its original close-up scales.
vec3 moonBroadSoil(vec2 ground, float footprint) {
  const mat2 turn = mat2(0.8, 0.6, -0.6, 0.8);
  const vec2 bend = vec2(0.44, -0.31);
  float broadWeight = 1.0 - smoothstep(2.7, 9.0, footprint);
  if (broadWeight <= 0.0) return vec3(0.0);
  vec3 broad = regolithNoise(ground / 22.5 + vec2(5.4, -8.6), 1823u);
  vec3 field = vec3(broad.xy * 0.009, broad.z * 0.066) * broadWeight;
  float fineWeight = 1.0 - smoothstep(0.60, 2.0, footprint);
  if (fineWeight > 0.0) {
    vec2 p = turn * ground / 5.0 + bend * broad.z;
    vec3 fine = regolithNoise(p, 8147u);
    vec2 slope = fine.xy * turn + dot(fine.xy, bend) * broad.xy * (5.0 / 22.5);
    field += vec3(slope * 0.012, fine.z * 0.043) * fineWeight;
  }
  return field;
}
#endif

/** One randomly placed and turned copy of the detail map, slopes turned back. */
vec4 moonDetailTap(vec2 uv, vec2 dx, vec2 dy, vec2 vertex) {
  mat2 rot;
  vec2 at = moonPatchUV(uv, vertex, rot);
  vec4 texel = textureGrad(uDetailMap, at, rot * dx, rot * dy);
  vec2 slope = (texel.rg * 2.0 - 1.0) * rot;
  return vec4(slope, texel.b - 0.5, texel.a - 0.45);
}

/**
 * The detail map without its repetition. The plane is cut into triangles
 * about a third of a tile across; each corner owns a copy of the map with
 * its own random offset and rotation, and a pixel blends the three copies of
 * its triangle. The blend keeps the contrast of a single copy
 * (Heitz and Neyret 2018), so the ground does not turn flat where copies
 * meet. dx and dy are the screen derivatives of uv, taken by the caller
 * because the copies make uv discontinuous. Returns slope in xy, tone in z and cavity in w, all around zero.
 */
vec4 moonDetail(vec2 uv, vec2 dx, vec2 dy) {
  vec2 v1, v2, v3;
  vec3 w;
  moonPatchWeights(uv, v1, v2, v3, w);
  vec4 sum = moonDetailTap(uv, dx, dy, v1) * w.x;
  if (w.y > 0.003) sum += moonDetailTap(uv, dx, dy, v2) * w.y;
  if (w.z > 0.003) sum += moonDetailTap(uv, dx, dy, v3) * w.z;
  vec4 corrected = sum * inversesqrt(dot(w, w));
  #ifndef MOON_ATLAS_BROAD
    // Height is unsigned and its mean varies with the generated map. Applying
    // variance correction to that mean imprints the blend lattice on the soil.
    float retained = w.x + (w.y > 0.003 ? w.y : 0.0) + (w.z > 0.003 ? w.z : 0.0);
    corrected.w = sum.w / retained;
  #endif
  return corrected;
}

/**
 * One layer of procedural craterlets: at most one per grid cell, sized and
 * placed so its rim and ejecta stay inside the cell (one lookup, no
 * neighbours). Returns the height gradient in xy and an albedo offset in z.
 */
vec3 moonCraterLayer(vec2 p, float cell, float seed) {
  vec2 q = p / cell;
  vec2 id = floor(q);
  // Occupancy drifts over a dozen cells, so craterlets cluster and leave
  // bare patches instead of covering the ground evenly
  float occupancy = 0.38 + 0.24 * moonNoise(id * 0.083 + seed);
  float pick = moonHash(id + seed);
  if (pick > occupancy) return vec3(0.0);
  // Cumulative count ~ r^-2 inside the octave, like the mesh craters
  float sizeRoll = moonHash(id + seed + 17.7);
  float radius = 0.07 * inversesqrt(1.0 - 0.915 * sizeRoll);
  vec2 jitter = vec2(moonHash(id.yx + seed + 41.3), moonHash(id + seed + 73.1)) - 0.5;
  vec2 d = q - (id + 0.5 + jitter * (1.0 - 3.1 * radius));
  float dist = length(d);
  float t = dist / radius;
  if (t >= 1.5) return vec3(0.0);
  // Nearly all craterlets are old, shallow and the colour of the soil around
  // them; one in a dozen is fresh enough to be deep and one in forty has a
  // bright halo
  float age = moonHash(id.yx + seed + 91.7);
  float fresh = age * age * age * age;
  float steepness = mix(0.07, 0.4, fresh);
  float wall = t * (1.0 - smoothstep(0.75, 1.0, t));
  float apron = 0.55 * smoothstep(0.85, 1.0, t) * (1.0 - smoothstep(1.0, 1.5, t));
  vec2 gradient = d / max(dist, 1e-5) * (steepness * (wall - apron));
  float bright = 0.3 * smoothstep(0.86, 1.0, fresh) * (1.0 - smoothstep(0.4, 1.5, t));
  return vec3(gradient, bright);
}

/**
 * Craterlets too small for the mesh to carry at this distance. Octave n has
 * 2^n metre cells; only the four octaves whose craters are between about one
 * and sixteen pixels across are evaluated, cross-fading as the camera moves,
 * so the ground stays peppered with small craters from any altitude.
 */
vec3 moonCraterField(vec2 p, float footprint) {
  float level = log2(max(footprint, 1e-3) * 6.0);
  float base = floor(level);
  float blend = level - base;
  vec2 turned = vec2(0.6 * p.x + 0.8 * p.y, -0.8 * p.x + 0.6 * p.y);
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float n = base + float(i);
    // Below 2 m cells the mesh and the detail map carry the surface
    if (n < 1.0 || n > 9.0) continue;
    float weight = i == 0 ? 1.0 - blend : (i == 3 ? blend : 1.0);
    float cell = exp2(n);
    vec3 a = moonCraterLayer(p, cell, n * 13.1);
    vec3 b = moonCraterLayer(turned + cell * 0.37, cell * 1.31, n * 7.7 + 3.3);
    b.xy = vec2(0.6 * b.x - 0.8 * b.y, 0.8 * b.x + 0.6 * b.y);
    sum += (a + b) * weight;
  }
  return sum;
}

/**
 * Regolith is a dark, porous powder: it scatters light back towards the
 * source and shows almost no limb darkening. This returns the factor that
 * turns three's Lambert term into a Lambert / Lommel-Seeliger blend with an
 * opposition surge. All vectors are in the same space.
 */
float moonRegolithResponse(vec3 n, vec3 v, vec3 l) {
  float nl = max(dot(n, l), 0.0);
  float nv = max(dot(n, v), 0.0);
  float seeliger = min(2.0 / (nl + nv + 0.04), 3.0);
  float phaseAngle = acos(clamp(dot(v, l), -1.0, 1.0));
  float surge = 1.0 + uOppositionSurge * exp(-phaseAngle / 0.3);
  // Backscattering: dimmer when looking towards the light
  float phase = 1.0 - 0.3 * uBackscatter * smoothstep(0.6, 2.6, phaseAngle);
  return mix(1.0, seeliger, uBackscatter) * surge * phase;
}

#ifdef USE_SUN_SHADOWS
${SUN_SHADOW_FRAGMENT_PARS}
#endif
`;

/** Terrain: fine regolith detail and broader relief, all anchored in world metres. */
const TERRAIN_SURFACE = /* glsl */ `
  vec2 groundPos = vWorldPosition.xz;
  // Footprint is metres of ground per pixel (geometric mean, so grazing
  // views keep their detail). Each scale fades out once its features are
  // down to a pixel or two, and is not sampled at all beyond that.
  vec2 groundDx = dFdx(groundPos);
  vec2 groundDy = dFdy(groundPos);
  float footprint = sqrt(length(groundDx) * length(groundDy));
  float fineFade = 1.0 - smoothstep(0.045, 0.18, footprint);
  float mediumFade = 1.0 - smoothstep(0.36, 1.44, footprint);

  // Keep the 2.9 m and 23 m material layers that carry grains, pebbles and clods.
  vec4 fine = vec4(0.0);
  vec4 medium = vec4(0.0);
  if (uGroundTextureLayers > 1.5 && fineFade > 0.0) fine = moonDetail(groundPos * ${FINE_PEBBLE_FREQUENCY}, groundDx * ${FINE_PEBBLE_FREQUENCY}, groundDy * ${FINE_PEBBLE_FREQUENCY}) * fineFade;
  if (uGroundTextureLayers > 0.5 && mediumFade > 0.0) medium = moonDetail(groundPos * ${MEDIUM_PEBBLE_FREQUENCY} + vec2(0.37, 0.11), groundDx * ${MEDIUM_PEBBLE_FREQUENCY}, groundDy * ${MEDIUM_PEBBLE_FREQUENCY}) * mediumFade;

  vec2 materialSlope = medium.xy * (0.45 * MOON_SLOPE_RANGE);
  float tone = fine.z * 0.6 + medium.z * 0.38 + medium.w * 0.12;
  float widestPixel = max(length(groundDx), length(groundDy));
  #ifdef MOON_ATLAS_BROAD
    float coarseFade = 1.0 - smoothstep(3.0, 12.0, footprint);
    if (coarseFade > 0.0) {
      vec4 coarse = moonDetail(groundPos * 0.005263 + vec2(0.71, 0.53), groundDx * 0.005263, groundDy * 0.005263) * coarseFade;
      materialSlope += coarse.xy * (0.15 * MOON_SLOPE_RANGE);
      tone += coarse.z * 0.35 + coarse.w * 0.1;
    }
  #else
    vec3 soil = moonBroadSoil(groundPos, widestPixel);
    materialSlope += soil.xy;
    tone += soil.z;
  #endif
  // A normal map cannot shadow itself: at grazing sun, metre-sized bumps
  // tilted past the terminator would turn into large black blotches where
  // the real surface is mostly lit with small shadows. Compress the part of
  // the slopes that lean away from the sun so they only approach the
  // terminator, the broad scales and the grain each with their own limit.
  float meshNdotL = max(dot(meshNormal, uSunDirection), 0.0);
  vec2 sunGround = uSunDirection.xz;
  float sunGroundLength = max(length(sunGround), 1e-4);
  vec2 sunAlong = sunGround / sunGroundLength;
  // The widest pixel axis, so grazing views never alias the craterlets
  vec3 craterlets = moonCraterField(groundPos, widestPixel) * uCraterletStrength;
  vec2 broadSlope = (materialSlope + craterlets.xy) * uDetailStrength;
  float terminatorSlope = meshNdotL / sunGroundLength;
  broadSlope = moonLimitSlope(broadSlope, sunAlong, 0.5 * terminatorSlope + 0.02);
  // Magnified sun-facing edges would otherwise glow as broad bright smears
  broadSlope = moonLimitSlope(broadSlope, -sunAlong, 0.8 * terminatorSlope + 0.08);
  float grazing = mix(0.7, 1.0, smoothstep(0.03, 0.4, meshNdotL));
  vec2 grainSlope = fine.xy * (0.8 * MOON_SLOPE_RANGE * uDetailStrength * grazing);
  vec2 slope = broadSlope + moonLimitSlope(grainSlope, sunAlong, 0.4 * terminatorSlope + 0.03);
  moonNormal = normalize(meshNormal - vec3(slope.x, 0.0, slope.y) * max(meshNormal.y, 0.3));

  if (uEnableColorVariation > 0.5) {
    // Carries the surface where the detail scales have faded out
    tone += moonMottle(groundPos, footprint);
  }
  moonAlbedo = MOON_SOIL_COLOR * max(1.0 + (tone + craterlets.z) * uDetailContrast, 0.15);
`;

/** Rocks: triplanar projection so every face gets undistorted detail. */
const ROCK_SURFACE = /* glsl */ `
  vec3 weights = pow(abs(meshNormal), vec3(4.0));
  weights /= weights.x + weights.y + weights.z;
  vec3 rockPos = vWorldPosition * 2.4;
  vec4 sideX = texture2D(uDetailMap, rockPos.zy);
  vec4 top = texture2D(uDetailMap, rockPos.xz + vec2(0.31, 0.67));
  vec4 sideZ = texture2D(uDetailMap, rockPos.xy + vec2(0.59, 0.23));

  vec2 slopeX = sideX.rg * 2.0 - 1.0;
  vec2 slopeY = top.rg * 2.0 - 1.0;
  vec2 slopeZ = sideZ.rg * 2.0 - 1.0;
  vec3 bump =
    vec3(0.0, slopeX.y, slopeX.x) * weights.x +
    vec3(slopeY.x, 0.0, slopeY.y) * weights.y +
    vec3(slopeZ.x, slopeZ.y, 0.0) * weights.z;
  bump -= meshNormal * dot(bump, meshNormal);
  moonNormal = normalize(meshNormal - bump * (MOON_SLOPE_RANGE * uDetailStrength * uRockBump * 0.7));

  float tone = dot(weights, vec3(sideX.b, top.b, sideZ.b)) - 0.5;
  float cavity = 1.0 - dot(weights, vec3(sideX.a, top.a, sideZ.a));
  vec3 bareRock = MOON_ROCK_COLOR * max(1.0 + (tone * 1.1 - cavity * 0.24) * uDetailContrast, 0.15);
  // Dust settles on faces that point up
  vec3 dusted = MOON_SOIL_COLOR * max(1.0 + tone * 0.5 * uDetailContrast, 0.15);
  moonAlbedo = mix(bareRock, dusted, smoothstep(0.6, 0.97, meshNormal.y) * 0.6);
`;

/**
 * MoonMaterial - lunar surface shader for terrain and rocks
 *
 * Works with regular meshes (terrain) and instanced meshes (rocks).
 *
 * - A mipmapped regolith map supplies fine relief. Broader terrain slopes
 *   and albedo come from world-space noise filtered by the pixel footprint.
 * - Lighting is three's standard pipeline with a regolith response
 *   (Lambert / Lommel-Seeliger blend plus opposition surge) folded into
 *   every directional light, and no specular term at all.
 * - The sun light is attenuated by cascaded shadow maps (SunShadows) once
 *   `setSunShadows()` has been called.
 * - Planetary curvature is applied in the vertex shader.
 */
export class MoonMaterial extends MeshStandardMaterial {
  readonly variant: MoonMaterialVariant;
  private readonly shaderUniforms: MoonMaterialUniforms;
  private readonly rockView = rockViewUniforms();
  private sunShadowUniforms: SunShadowUniforms | null = null;
  private params: MoonMaterialParams;

  constructor(options: MoonMaterialOptions = {}) {
    super({
      color: new Color(0xffffff),
      roughness: 1.0,
      metalness: 0.0,
      flatShading: false,
    });

    this.variant = options.variant ?? 'terrain';
    this.defines = { ...this.defines };
    if (this.variant === 'rock') {
      this.defines.MOON_ROCK = '';
    } else if (options.broadRelief === 'atlas') {
      this.defines.MOON_ATLAS_BROAD = '';
    }

    // Initialize default parameters
    this.params = {
      enableColorVariation: true,
      brightnessBoost: 1.0,
      enableCurvature: true,
      planetRadius: DEFAULT_PLANET_RADIUS,
      enableDetail: true,
      groundTextureLayers: 2,
      rockBump: 1,
      detailStrength: 1.0,
      pebbleHeight: 1.0,
      detailContrast: 1.0,
      craterletStrength: 1.0,
      backscatter: 0.6,
      oppositionSurge: 0.35,
      ambientFill: 0.08,
      shadowStrength: 1.0,
      sunHorizonFade: 1.0,
      debugMode: 0,
    };

    // The uniform objects live on the material and are handed to every
    // compiled program variant, so values set before the first compile (or
    // between a mesh and an instanced variant) are never lost.
    this.shaderUniforms = {
      uEnableColorVariation: { value: 1.0 },
      uBrightnessBoost: { value: 1.0 },
      uEnableCurvature: { value: 1.0 },
      uPlanetRadius: { value: DEFAULT_PLANET_RADIUS },
      uSunDirection: { value: new Vector3(0, 1, 0) },
      uDetailMap: {
        value: options.detailMap ??
          (this.variant === 'rock' ? getSharedStoneDetailMap() : getSharedRegolithDetailMap()),
      },
      uGroundTextureLayers: { value: 2 },
      uRockBump: { value: 1 },
      uDetailStrength: { value: 1.0 },
      uDetailContrast: { value: 1.0 },
      uCraterletStrength: { value: 1.0 },
      uBackscatter: { value: 0.6 },
      uOppositionSurge: { value: 0.35 },
      uAmbientFill: { value: 0.08 },
      uShadowStrength: { value: 1.0 },
      uSunHorizonFade: { value: 1.0 },
      uDebugMode: { value: 0.0 },
    };
    this.updateUniforms();

    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.shaderUniforms);
      if (this.variant === 'rock') {
        Object.assign(shader.uniforms, this.rockView);
        shader.vertexShader = rockScreenVertex + shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n#ifdef USE_INSTANCING\ntransformed *= rockScreenScale();\n#endif'
        );
      }
      if (this.sunShadowUniforms) {
        Object.assign(shader.uniforms, this.sunShadowUniforms);
      }

      // ==========================================
      // VERTEX SHADER MODIFICATIONS
      // ==========================================

      shader.vertexShader = `
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        uniform float uEnableCurvature;
        uniform float uPlanetRadius;
        ${shader.vertexShader}
      `;

      // Pass world position and world normal to fragment shader (with instancing support)
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `
        #include <worldpos_vertex>
        #ifdef USE_INSTANCING
          vWorldPosition = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        // Three has already applied the inverse-transpose for nonuniform instance scale.
        vWorldNormal = inverseTransformDirection(transformedNormal, viewMatrix);
        `
      );

      // Apply planetary curvature (with instancing support)
      // NOTE: the local is named curvedWorldPosition (not worldPosition) because
      // Three.js's <worldpos_vertex> chunk declares its own `vec4 worldPosition`
      // when USE_ENVMAP/DISTANCE/USE_SHADOWMAP/USE_TRANSMISSION/spot coords are
      // enabled, and a redeclaration would break shader compilation.
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `
        #ifdef USE_INSTANCING
          vec4 curvedWorldPosition = modelMatrix * instanceMatrix * vec4( transformed, 1.0 );
        #else
          vec4 curvedWorldPosition = modelMatrix * vec4( transformed, 1.0 );
        #endif

        if (uEnableCurvature > 0.5) {
          vec2 deltaXZ = curvedWorldPosition.xz - cameraPosition.xz;
          float distSq = dot(deltaXZ, deltaXZ);
          float curvatureDrop = distSq / (2.0 * uPlanetRadius);
          curvedWorldPosition.y -= curvatureDrop;
        }

        vec4 mvPosition = viewMatrix * curvedWorldPosition;
        gl_Position = projectionMatrix * mvPosition;
        `
      );

      // ==========================================
      // FRAGMENT SHADER MODIFICATIONS
      // ==========================================

      shader.fragmentShader = `
        ${FRAGMENT_PARS}
        ${shader.fragmentShader}
      `;

      // Albedo, detail normal and sun visibility. Everything declared here is
      // at main() scope and is used again by the later injections.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `
        #include <color_fragment>

        vec3 meshNormal = normalize(vWorldNormal);
        vec3 moonNormal = meshNormal;
        vec3 moonAlbedo = MOON_SOIL_COLOR;
        if (uDetailStrength >= 0.0) {
          #ifdef MOON_ROCK
            ${ROCK_SURFACE}
          #elif defined(MOON_PEBBLE_STONE)
            ${pebbleSurfaceFragment}
          #else
            ${TERRAIN_SURFACE}
          #endif
        }
        moonAlbedo *= uBrightnessBoost;

        float moonSunVisibility = 1.0;
        #ifdef USE_SUN_SHADOWS
          if (uShadowStrength > 0.0 && uSunHorizonFade > 0.001 && dot(meshNormal, uSunDirection) > -0.02) {
            moonSunVisibility = mix(1.0, sunShadowVisibility(vWorldPosition, meshNormal), uShadowStrength);
          }
        #endif
        vec3 moonSunDirectionView = normalize(mat3(viewMatrix) * uSunDirection);
        #if defined(MOON_ROCK) || defined(MOON_PEBBLE_STONE)
          vec3 moonBaseNormalView = mat3(viewMatrix) * meshNormal;
        #endif

        diffuseColor.rgb *= moonAlbedo;
        `
      );

      // Three.js's 'normal' is in VIEW SPACE while moonNormal is in WORLD
      // SPACE, so it must be rotated by viewMatrix (a rigid transform, so the
      // plain 3x3 is fine).
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_begin>',
        `
        #include <normal_fragment_begin>
        normal = normalize(mat3(viewMatrix) * moonNormal);
        nonPerturbedNormal = normal;
        `
      );

      // Regolith response for every directional light, shadows for the sun
      // (the directional light that points along uSunDirection), and a small
      // bounce-light fill so shadows are not pure black.
      const lightsBegin = ShaderChunk.lights_fragment_begin.replace(
        DIRECTIONAL_LIGHT_ANCHOR,
        `
        ${DIRECTIONAL_LIGHT_ANCHOR}
        #if defined(MOON_ROCK) || defined(MOON_PEBBLE_STONE)
          // A fracture can catch light only on the exposed side of its parent surface.
          directLight.color *= smoothstep(0.0, 0.12, dot(moonBaseNormalView, directLight.direction));
        #endif
        directLight.color *= moonRegolithResponse(geometryNormal, geometryViewDir, directLight.direction);
        directLight.color *= mix(1.0, moonSunVisibility, step(0.9999, dot(directLight.direction, moonSunDirectionView)));
        `
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_begin>',
        `
        ${lightsBegin}
        #if defined( RE_IndirectDiffuse )
          irradiance += vec3(1.0, 0.96, 0.9) * (uAmbientFill * uSunHorizonFade);
          #ifdef MOON_PEBBLE_STONE
            // Sunlit dust reflects a little light onto the neighbour-facing rock faces.
            irradiance += vec3(1.0, 0.95, 0.88) * (max(uSunDirection.y, 0.0) * uSunHorizonFade)
              * (0.30 - 0.18*max(meshNormal.y,0.0));
          #endif
        #endif
        `
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `
        // Regolith has no specular lobe worth rendering
        outgoingLight = totalDiffuse + totalEmissiveRadiance;

        if (uDebugMode > 0.5) {
          vec3 debugColor = vec3(1.0, 0.0, 1.0); // Magenta = invalid mode
          if (uDebugMode < 1.5) {
            debugColor = meshNormal * 0.5 + 0.5;
          } else if (uDebugMode < 2.5) {
            debugColor = moonNormal * 0.5 + 0.5;
          } else if (uDebugMode < 3.5) {
            debugColor = vec3(moonSunVisibility);
          } else if (uDebugMode < 4.5) {
            debugColor = moonAlbedo;
          } else if (uDebugMode < 5.5) {
            debugColor = outgoingLight / max(diffuseColor.rgb, vec3(0.001)) * 0.2;
          }
          gl_FragColor = vec4(debugColor, 1.0);
          return;
        }

        #include <opaque_fragment>
        `
      );
    };
  }

  setRockCamera(eye: Vector3, focal: number) {
    const uniforms = this.sunShadowUniforms ?? this.rockView;
    uniforms.uRockEye.value.copy(eye);
    uniforms.uRockFocal.value = focal;
  }

  /**
   * Attach the shared sun shadow cascades. Recompiles the material once.
   */
  setSunShadows(uniforms: SunShadowUniforms, mapSize: number): void {
    this.sunShadowUniforms = uniforms;
    this.defines = { ...this.defines, USE_SUN_SHADOWS: '', SUN_SHADOW_MAP_SIZE: mapSize };
    this.needsUpdate = true;
  }

  /**
   * Update a parameter and refresh uniforms.
   * No-op when the value is unchanged (callers may invoke this every frame).
   */
  setParam<K extends keyof MoonMaterialParams>(key: K, value: MoonMaterialParams[K]): void {
    if (Object.is(this.params[key], value)) return;
    this.params[key] = value;
    this.updateUniforms();
  }

  /**
   * Get a parameter value
   */
  getParam<K extends keyof MoonMaterialParams>(key: K): MoonMaterialParams[K] {
    return this.params[key];
  }

  /**
   * Get all parameters
   */
  getParams(): MoonMaterialParams {
    return { ...this.params };
  }

  /**
   * Set all parameters at once.
   * Skips the uniform refresh when no value actually changed.
   */
  setParams(params: Partial<MoonMaterialParams>): void {
    let changed = false;
    for (const key of Object.keys(params) as (keyof MoonMaterialParams)[]) {
      if (!Object.is(this.params[key], params[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    Object.assign(this.params, params);
    this.updateUniforms();
  }

  /**
   * Set the direction towards the sun (normalized, world space). Used to
   * pick the sun out of the directional lights for shadowing.
   */
  setSunDirection(direction: Vector3): void {
    this.shaderUniforms.uSunDirection.value.copy(direction);
  }

  /**
   * Set sun horizon fade factor (0 = below horizon, 1 = above horizon).
   * Should be called each frame.
   */
  setSunHorizonFade(fade: number): void {
    this.params.sunHorizonFade = fade;
    this.shaderUniforms.uSunHorizonFade.value = fade;
  }

  /**
   * Update shader uniforms from current parameters
   */
  private updateUniforms(): void {
    const uniforms = this.shaderUniforms;
    const params = this.params;
    uniforms.uEnableColorVariation.value = params.enableColorVariation ? 1.0 : 0.0;
    uniforms.uBrightnessBoost.value = params.brightnessBoost;
    uniforms.uEnableCurvature.value = params.enableCurvature ? 1.0 : 0.0;
    uniforms.uPlanetRadius.value = params.planetRadius;
    uniforms.uGroundTextureLayers.value = params.groundTextureLayers;
    uniforms.uRockBump.value = params.rockBump;
    // A negative strength switches the detail branch off entirely
    uniforms.uDetailStrength.value = params.enableDetail ? params.detailStrength : -1.0;
    uniforms.uDetailContrast.value = params.detailContrast;
    uniforms.uCraterletStrength.value = params.craterletStrength;
    uniforms.uBackscatter.value = params.backscatter;
    uniforms.uOppositionSurge.value = params.oppositionSurge;
    uniforms.uAmbientFill.value = params.ambientFill;
    uniforms.uShadowStrength.value = params.shadowStrength;
    uniforms.uSunHorizonFade.value = params.sunHorizonFade;
    uniforms.uDebugMode.value = params.debugMode;

    // NOTE: needsUpdate is intentionally NOT set here. All params map to uniform
    // value updates, which Three.js picks up without recompiling the program.
  }
}
