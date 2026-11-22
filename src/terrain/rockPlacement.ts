/**
 * Deterministic rock population and placement for a terrain chunk.
 *
 * Runs in the chunk workers (instance matrices for rendering) and on the
 * main thread (gameplay queries), so it is free of three.js, keeps all its
 * working memory in module-level scratch buffers and allocates nothing per
 * rock.
 *
 * The population of a chunk is a pure function of (terrain seed, chunk grid
 * position, config): chunk LOD only filters rocks by diameter and selects
 * cheaper meshes, it never moves or resizes a rock.
 */
import alea from 'alea';
import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import {
  meshTierForLod,
  ROCK_TIERS,
  rockHeightRatio,
  rockShapeFor,
  rockTriangleBudget,
  sizeTierForDiameter,
} from '../environment/rockPrototypes';
import type { RockGenerationConfig } from '../types';

/** Instances of one prototype mesh in a chunk: one draw call. */
export interface RockPlacement {
  /** Shape id of the prototype (0..librarySize-1) */
  prototypeId: number;
  /** Mesh detail tier of the prototype (index into ROCK_TIERS) */
  tier: number;
  /** Flattened column-major Matrix4 per rock (16 floats), relative to the chunk center */
  matrices: Float32Array;
  /** Linear RGB tint per rock (3 floats), multiplied into the surface color */
  colors: Float32Array;
}

/** The part of a chunk's TerrainArgs that rock placement depends on. */
export interface RockChunk {
  seed: number;
  width: number;
  depth: number;
  /** World-space X of the chunk center */
  posX: number;
  /** World-space Z of the chunk center */
  posZ: number;
}

/** Terrain height at a position in chunk-local coordinates. */
export type RockHeightSampler = (x: number, z: number) => number;

/** Called for every rock of a chunk: chunk-local position and diameter. */
export type RockVisitor = (x: number, z: number, diameter: number) => void;

/** Defaults for the optional RockGenerationConfig fields. */
export const ROCK_FIELD_DEFAULTS = {
  fieldScale: 450,
  fieldPeakDensity: 3.6,
  plainsDensity: 0.15,
  maxTrianglesPerChunk: 250000,
} as const;

/** Spacing of the per-chunk density lookup grid, meters. */
const DENSITY_CELL = 25;
/**
 * Mean of the boulder-field mask (see rockFieldMask) over the terrain,
 * measured over 4·10⁶ samples. Used to keep the average density equal to
 * the configured power law whatever the peak / plains contrast.
 */
const FIELD_MASK_MEAN = 0.233;
/** Noise levels (0..1) where the boulder-field mask starts and saturates. */
const MASK_LOW = 0.46;
const MASK_HIGH = 0.8;
/** Share of the terrain slope a rock's base follows (the rest is buried). */
const SLOPE_ALIGNMENT = 0.85;
/** Steepest slope (rise / run) a rock tilts to. */
const MAX_TILT_SLOPE = 0.7;
/** Largest share of a rock's height that can end up below ground. */
const MAX_SINK = 0.5;
/** Largest random tilt added on top of the terrain slope (rise / run). */
const RANDOM_TILT = 0.08;

const TIER_TRIANGLES: readonly number[] = ROCK_TIERS.map((tier) => rockTriangleBudget(tier.detail));

// ---------------------------------------------------------------------------
// Random numbers: one mulberry32 stream per rock, seeded by hashing
// ---------------------------------------------------------------------------

let rngState = 0;

function nextRandom(): number {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function mixInt(value: number): number {
  let h = value | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
}

/** Seed shared by all rocks of a chunk. */
function chunkSeedFor(chunk: RockChunk): number {
  const gridX = Math.round(chunk.posX / chunk.width);
  const gridZ = Math.round(chunk.posZ / chunk.depth);
  return mixInt(
    mixInt(mixInt(Math.floor(chunk.seed) + 0x51ed27) ^ Math.imul(gridX, 0x9e3779b1)) ^
      Math.imul(gridZ, 0x632be5ab)
  );
}

// ---------------------------------------------------------------------------
// Boulder-field density
// ---------------------------------------------------------------------------

let fieldNoiseSeed = Number.NaN;
let fieldNoise: NoiseFunction2D | null = null;

function getFieldNoise(seed: number): NoiseFunction2D {
  if (fieldNoise === null || fieldNoiseSeed !== seed) {
    fieldNoise = createNoise2D(alea('rock-fields', seed));
    fieldNoiseSeed = seed;
  }
  return fieldNoise;
}

/**
 * Boulder-field mask in [0, 1] at a world position: 0 on the open plains,
 * rising to 1 in the middle of a boulder field. A world-space function, so
 * fields run straight across chunk borders.
 */
export function rockFieldMask(
  seed: number,
  worldX: number,
  worldZ: number,
  fieldScale: number
): number {
  const noise = getFieldNoise(seed);
  const u = worldX / fieldScale;
  const v = worldZ / fieldScale;
  const n =
    0.6 * noise(u, v) +
    0.27 * noise(u * 2.7 + 17.3, v * 2.7 - 4.1) +
    0.13 * noise(u * 5.3 - 9.2, v * 5.3 + 23.7);
  // smoothstep over the upper half of the noise range: wide sparse plains
  // with compact dense fields
  const t = Math.min(1, Math.max(0, (0.5 + 0.5 * n - MASK_LOW) / (MASK_HIGH - MASK_LOW)));
  return t * t * (3 - 2 * t);
}

/** Resolved density-field parameters. */
interface FieldParams {
  fieldScale: number;
  peak: number;
  plains: number;
}

function fieldParams(config: RockGenerationConfig): FieldParams {
  const peak = Math.max(1e-6, config.fieldPeakDensity ?? ROCK_FIELD_DEFAULTS.fieldPeakDensity);
  const plains = Math.min(
    peak,
    Math.max(0, config.plainsDensity ?? ROCK_FIELD_DEFAULTS.plainsDensity)
  );
  return {
    fieldScale: Math.max(1, config.fieldScale ?? ROCK_FIELD_DEFAULTS.fieldScale),
    peak,
    plains,
  };
}

/** Mean of the un-normalized density (plains + (peak - plains)·mask). */
function fieldMean(params: FieldParams): number {
  return params.plains + (params.peak - params.plains) * FIELD_MASK_MEAN;
}

/**
 * Local rock density relative to the terrain average at a world position
 * (before the per-chunk grid interpolation used by the placement itself).
 */
export function rockDensityMultiplier(
  seed: number,
  config: RockGenerationConfig,
  worldX: number,
  worldZ: number
): number {
  const params = fieldParams(config);
  const mask = rockFieldMask(seed, worldX, worldZ, params.fieldScale);
  return (params.plains + (params.peak - params.plains) * mask) / fieldMean(params);
}

// Per-chunk lookup grid of the mask, filled lazily (NaN = not computed yet).
// Its nodes on a chunk border sit at the same world positions as the
// neighbour's, so the interpolated density is continuous across chunks.
let maskGrid = new Float32Array(0);
let maskCellsX = 0;
let maskCellsZ = 0;
let maskChunk: RockChunk = { seed: 0, width: 1, depth: 1, posX: 0, posZ: 0 };
let maskFieldScale = 1;

function resetMaskGrid(chunk: RockChunk, fieldScale: number): void {
  maskCellsX = Math.max(1, Math.round(chunk.width / DENSITY_CELL));
  maskCellsZ = Math.max(1, Math.round(chunk.depth / DENSITY_CELL));
  const size = (maskCellsX + 1) * (maskCellsZ + 1);
  if (maskGrid.length < size) {
    maskGrid = new Float32Array(size);
  }
  maskGrid.fill(Number.NaN, 0, size);
  maskChunk = chunk;
  maskFieldScale = fieldScale;
}

function maskNode(ix: number, iz: number): number {
  const slot = iz * (maskCellsX + 1) + ix;
  let value = maskGrid[slot];
  if (Number.isNaN(value)) {
    value = rockFieldMask(
      maskChunk.seed,
      maskChunk.posX - maskChunk.width / 2 + (ix / maskCellsX) * maskChunk.width,
      maskChunk.posZ - maskChunk.depth / 2 + (iz / maskCellsZ) * maskChunk.depth,
      maskFieldScale
    );
    maskGrid[slot] = value;
  }
  return value;
}

/** Bilinear mask lookup at a chunk-local position. */
function sampleMask(x: number, z: number): number {
  const fx = Math.min(maskCellsX, Math.max(0, (x / maskChunk.width + 0.5) * maskCellsX));
  const fz = Math.min(maskCellsZ, Math.max(0, (z / maskChunk.depth + 0.5) * maskCellsZ));
  const ix = Math.min(maskCellsX - 1, Math.floor(fx));
  const iz = Math.min(maskCellsZ - 1, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const top = maskNode(ix, iz) * (1 - tx) + maskNode(ix + 1, iz) * tx;
  const bottom = maskNode(ix, iz + 1) * (1 - tx) + maskNode(ix + 1, iz + 1) * tx;
  return top * (1 - tz) + bottom * tz;
}

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

/** Smallest rock diameter shown at a chunk LOD. */
export function rockMinDiameterForLod(config: RockGenerationConfig, lodLevel: number): number {
  const scales = config.lodMinDiameterScale;
  if (scales.length === 0) {
    return config.minDiameter;
  }
  const index = Math.min(Math.max(0, Math.floor(lodLevel)), scales.length - 1);
  return config.minDiameter * scales[index];
}

/**
 * Average number of rocks at or above a diameter in a chunk of the given
 * area: N(>D)·area with the power law truncated at maxDiameter.
 */
export function expectedRockCount(
  config: RockGenerationConfig,
  area: number,
  diameter = config.minDiameter
): number {
  const d = Math.max(diameter, config.minDiameter);
  if (d >= config.maxDiameter) {
    return 0;
  }
  const e = config.powerLawExponent;
  return config.densityConstant * area * (d ** e - config.maxDiameter ** e);
}

/**
 * Enumerate the rocks of a chunk, in a fixed order.
 *
 * Candidates are scattered uniformly and kept with a probability following
 * the boulder-field density, which gives clustered fields with sharp
 * contrast to the plains. Diameters follow the truncated power law. Once
 * the chunk's triangle budget (counted with LOD 0 meshes) is spent, the
 * remaining candidates are dropped.
 *
 * While `visit` runs, the rock's private random stream is positioned right
 * after the draws used here, so placement can keep drawing from it.
 */
export function forEachRock(
  chunk: RockChunk,
  config: RockGenerationConfig,
  visit: RockVisitor
): void {
  const params = fieldParams(config);
  const mean = fieldMean(params);
  const area = chunk.width * chunk.depth;
  const e = config.powerLawExponent;
  const minPow = config.minDiameter ** e;
  const maxPow = config.maxDiameter ** e;
  if (!(config.maxDiameter > config.minDiameter) || !(mean > 0)) {
    return;
  }
  // Candidates at peak density; each survives with probability local / peak
  const candidates = Math.round(
    (config.densityConstant * area * (minPow - maxPow) * params.peak) / mean
  );
  if (candidates <= 0) {
    return;
  }
  const budget = config.maxTrianglesPerChunk ?? ROCK_FIELD_DEFAULTS.maxTrianglesPerChunk;
  const chunkSeed = chunkSeedFor(chunk);
  resetMaskGrid(chunk, params.fieldScale);
  const span = params.peak - params.plains;
  const inverseExponent = 1 / e;

  let triangles = 0;
  for (let i = 0; i < candidates; i++) {
    rngState = mixInt(chunkSeed ^ Math.imul(i + 1, 0x9e3779b1));
    const sizeUnit = nextRandom();
    const x = (nextRandom() - 0.5) * chunk.width;
    const z = (nextRandom() - 0.5) * chunk.depth;
    if (nextRandom() * params.peak >= params.plains + span * sampleMask(x, z)) {
      continue;
    }
    // Inverse CDF of the truncated power law: sizeUnit 0 → minDiameter
    const diameter = (minPow + sizeUnit * (maxPow - minPow)) ** inverseExponent;
    triangles += TIER_TRIANGLES[sizeTierForDiameter(diameter)];
    if (triangles > budget) {
      return;
    }
    visit(x, z, diameter);
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

let heightRatios = new Float32Array(0);
let heightRatioCount = 0;

/** Prototype height / diameter per shape id, cached for the library size. */
function getHeightRatios(librarySize: number): Float32Array {
  if (heightRatioCount !== librarySize) {
    heightRatios = new Float32Array(librarySize);
    for (let i = 0; i < librarySize; i++) {
      heightRatios[i] = rockHeightRatio(i);
    }
    heightRatioCount = librarySize;
  }
  return heightRatios;
}

// Scratch storage for the rocks of the chunk being placed, in visit order
let scratchCapacity = 0;
let scratchMatrices = new Float32Array(0);
let scratchColors = new Float32Array(0);
let scratchKeys = new Uint16Array(0);
let groupCounts = new Int32Array(0);

function ensureScratch(capacity: number): void {
  if (capacity <= scratchCapacity) {
    return;
  }
  const next = Math.max(capacity, scratchCapacity * 2, 256);
  const matrices = new Float32Array(next * 16);
  matrices.set(scratchMatrices);
  const colors = new Float32Array(next * 3);
  colors.set(scratchColors);
  const keys = new Uint16Array(next);
  keys.set(scratchKeys);
  scratchMatrices = matrices;
  scratchColors = colors;
  scratchKeys = keys;
  scratchCapacity = next;
}

/**
 * Place the rocks of a chunk for one chunk LOD.
 *
 * Each rock stands on its prototype's base (prototypes are Y-up with the
 * base at y = 0), yawed randomly, tilted to the local terrain slope and
 * sunk into the regolith by a fraction of its height. Rocks are grouped by
 * (mesh tier, shape): every group is one instanced draw call.
 *
 * @param chunk - Chunk identity and size
 * @param lodLevel - Chunk LOD: drops small rocks and one mesh tier per level
 * @param librarySize - Number of shapes in the prototype library
 * @param config - Rock generation config
 * @param sampleHeight - Terrain height at chunk-local (x, z)
 * @returns Groups ordered by tier, then shape id
 */
export function placeRocks(
  chunk: RockChunk,
  lodLevel: number,
  librarySize: number,
  config: RockGenerationConfig,
  sampleHeight: RockHeightSampler
): RockPlacement[] {
  const shapes = Math.max(1, Math.floor(librarySize));
  const lod = Math.max(0, Math.floor(lodLevel));
  const minDiameter = rockMinDiameterForLod(config, lod);
  const ratios = getHeightRatios(shapes);
  const chunkHash = chunkSeedFor(chunk) >>> 0;
  const bigRockDiameter = ROCK_TIERS[1].minDiameter;
  const centralDifferenceDiameter = ROCK_TIERS[2].minDiameter;
  let count = 0;

  forEachRock(chunk, config, (x, z, diameter) => {
    if (diameter < minDiameter) {
      return;
    }
    const sizeTier = sizeTierForDiameter(diameter);
    const shape = rockShapeFor(sizeTier, lod, shapes, chunkHash, nextRandom());
    const yaw = nextRandom() * Math.PI * 2;
    const tiltX = (nextRandom() - 0.5) * 2 * RANDOM_TILT;
    const tiltZ = (nextRandom() - 0.5) * 2 * RANDOM_TILT;
    const scaleX = diameter * (0.88 + 0.24 * nextRandom());
    const scaleZ = diameter * (0.88 + 0.24 * nextRandom());
    const scaleY = diameter * (0.82 + 0.36 * nextRandom());
    const burialUnit = nextRandom();
    const brightness = 0.85 + 0.3 * nextRandom();
    const warmth = (nextRandom() - 0.5) * 0.06;

    // Terrain height and slope under the rock, probed over its footprint.
    // Small rocks make do with two extra samples.
    const reach = Math.min(1.5, Math.max(0.25, diameter * 0.5));
    const ground = sampleHeight(x, z);
    let slopeX: number;
    let slopeZ: number;
    if (diameter >= centralDifferenceDiameter) {
      slopeX = (sampleHeight(x + reach, z) - sampleHeight(x - reach, z)) / (2 * reach);
      slopeZ = (sampleHeight(x, z + reach) - sampleHeight(x, z - reach)) / (2 * reach);
    } else {
      slopeX = (sampleHeight(x + reach, z) - ground) / reach;
      slopeZ = (sampleHeight(x, z + reach) - ground) / reach;
    }
    const slope = Math.hypot(slopeX, slopeZ);
    const follow = (slope > MAX_TILT_SLOPE ? MAX_TILT_SLOPE / slope : 1) * SLOPE_ALIGNMENT;

    // Up axis: the (partly followed) terrain normal plus a small random tilt
    let upX = -(slopeX * follow + tiltX);
    let upY = 1;
    let upZ = -(slopeZ * follow + tiltZ);
    const upInv = 1 / Math.hypot(upX, upY, upZ);
    upX *= upInv;
    upY *= upInv;
    upZ *= upInv;

    // Yawed X axis, made perpendicular to up; Z = X × up keeps it right-handed
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    const along = cosYaw * upX + sinYaw * upZ;
    let xx = cosYaw - upX * along;
    let xy = -upY * along;
    let xz = sinYaw - upZ * along;
    const xInv = 1 / Math.hypot(xx, xy, xz);
    xx *= xInv;
    xy *= xInv;
    xz *= xInv;
    const zx = xy * upZ - xz * upY;
    const zy = xz * upX - xx * upZ;
    const zz = xx * upY - xy * upX;

    // Burial: 14-30 % of the height, 8-16 % for big boulders, plus whatever
    // the uphill edge needs where the base does not follow the slope (never
    // more than half the rock: on a cliff it would vanish into the ground)
    const height = ratios[shape] * scaleY;
    const fraction =
      diameter >= bigRockDiameter ? 0.08 + 0.08 * burialUnit : 0.14 + 0.16 * burialUnit;
    const sink = Math.min(
      MAX_SINK * height,
      fraction * height + 0.5 * diameter * slope * (1 - follow)
    );

    ensureScratch(count + 1);
    const m = count * 16;
    scratchMatrices[m] = xx * scaleX;
    scratchMatrices[m + 1] = xy * scaleX;
    scratchMatrices[m + 2] = xz * scaleX;
    scratchMatrices[m + 3] = 0;
    scratchMatrices[m + 4] = upX * scaleY;
    scratchMatrices[m + 5] = upY * scaleY;
    scratchMatrices[m + 6] = upZ * scaleY;
    scratchMatrices[m + 7] = 0;
    scratchMatrices[m + 8] = zx * scaleZ;
    scratchMatrices[m + 9] = zy * scaleZ;
    scratchMatrices[m + 10] = zz * scaleZ;
    scratchMatrices[m + 11] = 0;
    scratchMatrices[m + 12] = x - upX * sink;
    scratchMatrices[m + 13] = ground - upY * sink;
    scratchMatrices[m + 14] = z - upZ * sink;
    scratchMatrices[m + 15] = 1;
    const c = count * 3;
    scratchColors[c] = brightness * (1 + warmth);
    scratchColors[c + 1] = brightness;
    scratchColors[c + 2] = brightness * (1 - warmth);
    scratchKeys[count] = meshTierForLod(sizeTier, lod) * shapes + shape;
    count++;
  });

  if (count === 0) {
    return [];
  }

  // Counting sort into (tier, shape) groups
  const groupTotal = ROCK_TIERS.length * shapes;
  if (groupCounts.length < groupTotal) {
    groupCounts = new Int32Array(groupTotal);
  }
  groupCounts.fill(0, 0, groupTotal);
  for (let i = 0; i < count; i++) {
    groupCounts[scratchKeys[i]]++;
  }
  const result: RockPlacement[] = [];
  for (let key = 0; key < groupTotal; key++) {
    const size = groupCounts[key];
    if (size === 0) {
      groupCounts[key] = -1;
      continue;
    }
    // From here on the entry holds the group's index in `result`
    groupCounts[key] = result.length;
    result.push({
      prototypeId: key % shapes,
      tier: Math.floor(key / shapes),
      matrices: new Float32Array(size * 16),
      colors: new Float32Array(size * 3),
    });
  }
  const filled = new Int32Array(result.length);
  for (let i = 0; i < count; i++) {
    const group = groupCounts[scratchKeys[i]];
    const placement = result[group];
    const slot = filled[group]++;
    const from = i * 16;
    const to = slot * 16;
    for (let k = 0; k < 16; k++) {
      placement.matrices[to + k] = scratchMatrices[from + k];
    }
    placement.colors[slot * 3] = scratchColors[i * 3];
    placement.colors[slot * 3 + 1] = scratchColors[i * 3 + 1];
    placement.colors[slot * 3 + 2] = scratchColors[i * 3 + 2];
  }
  return result;
}
