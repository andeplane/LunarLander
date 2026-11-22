/**
 * Procedural crater field for lunar terrain.
 *
 * Model
 * - Population: a crater-saturated surface. Cumulative size-frequency
 *   N(>r) = density * r^powerLawExponent craters per km² (r in meters), from
 *   minRadius up to maxRadius. Placement is deterministic per chunk cell.
 * - Age: every crater has a freshness in [0, 1], heavily skewed toward 0
 *   (degraded). Small craters degrade faster than large ones. Freshness
 *   drives depth, rim height, crest sharpness and ejecta.
 * - Profile: an interior bowl and an exterior ejecta curve joined by a cubic
 *   polynomial smooth-min, windowed so it reaches exactly 0 at the cutoff
 *   radius. C1-smooth everywhere (rim crest and cutoff included).
 * - Outline: a few low-order angular harmonics (ellipticity + gentle lobes)
 *   scale the radius by a few percent, so rims are never perfect circles and
 *   never polygonal.
 * - Combination: plain additive superposition (order-independent), so small
 *   craters show up on the floors, walls and rims of large ones.
 *
 * Evaluation
 * - Meshes: rasterizeCraters visits only the vertices inside each crater's
 *   bounding circle of a regular grid.
 * - Point queries: CraterIndex buckets small craters on a uniform grid and
 *   keeps the few large ones in a short list.
 * Both paths sum the same per-crater function (craterHeight) in the same
 * canonical order, so they agree bit for bit.
 */

import alea from 'alea';
import type { TerrainArgs } from './terrain';

/**
 * Configuration for crater generation (passed via TerrainArgs)
 */
export interface CraterParams {
  seed: number;
  /** Craters per km² with radius >= 1 m (reference size of the power law) */
  density: number;
  /** Minimum crater radius in meters */
  minRadius: number;
  /** Maximum crater radius in meters */
  maxRadius: number;
  /** Cumulative size-frequency exponent (negative; -2 = equilibrium) */
  powerLawExponent: number;
  /** Depth / diameter of a perfectly fresh crater (~0.2) */
  depthRatio: number;
  /** Rim height / diameter of a perfectly fresh crater (~0.04) */
  rimHeight: number;
  /** Ejecta blanket extent beyond the rim, in crater radii (1.5 = out to 2.5 R) */
  rimWidth: number;
  /** Extra floor flattening for all craters, 0..1 (large craters flatten on their own) */
  floorFlatness: number;
  /** Depth / diameter of the most degraded craters (default 0.04) */
  degradedDepthRatio?: number;
  /** Age skew: 3 = ages spread evenly up to erasure, higher = more degraded (default 3) */
  freshnessExponent?: number;
  /**
   * Radius where the equilibrium population ends: larger craters follow the
   * steeper production slope and are fresher. Default none (no break).
   */
  breakRadius?: number;
  /** Cumulative size-frequency exponent above breakRadius (default -3.2) */
  steepExponent?: number;
}

export const DEFAULT_DEGRADED_DEPTH_RATIO = 0.04;
export const DEFAULT_FRESHNESS_EXPONENT = 3;
export const DEFAULT_STEEP_EXPONENT = -3.2;

/**
 * A single crater. All fields are derived once at creation so the per-point
 * evaluation is a handful of multiplications.
 */
export interface Crater {
  /** World X of the center */
  centerX: number;
  /** World Z of the center */
  centerZ: number;
  /** Nominal rim-crest radius in meters */
  radius: number;
  /** 0 = fully degraded, 1 = perfectly fresh */
  freshness: number;
  /** Floor depth below the surrounding surface, meters */
  depth: number;
  /** Nominal rim crest height above the surrounding surface, meters */
  rimHeight: number;
  /** Smooth-min blend width between bowl and ejecta, meters */
  blend: number;
  /** Bowl shape: 1 = parabola, lower = flatter floor (quartic share) */
  floorMix: number;
  /** Normalized radius (r / R) where the profile reaches exactly 0 */
  cutoff: number;
  /** World-space radius beyond which the crater contributes nothing */
  influenceRadius: number;
  /** Angular harmonics (n = 2..5) of the radius scale: cos / sin coefficients */
  h2c: number;
  h2s: number;
  h3c: number;
  h3s: number;
  h4c: number;
  h4s: number;
  h5c: number;
  h5s: number;
  // Precomputed for the hot path
  invRadius: number;
  influenceSq: number;
  invCutoffSpan: number;
}

/** Fully specified shape used to build a Crater (tests, tools). */
export interface CraterShape {
  centerX: number;
  centerZ: number;
  radius: number;
  freshness: number;
  /** Multiplier on the depth (natural variation), default 1 */
  depthScale?: number;
  /**
   * Rim-to-floor depth / diameter this crater had when fresh, default
   * params.depthRatio. Small craters form shallower (see freshDepthRatio).
   */
  freshDepthRatio?: number;
  /** Harmonic coefficients [h2c, h2s, h3c, h3s, h4c, h4s, h5c, h5s], default none */
  harmonics?: readonly number[];
}

/** Blend width as a fraction of depth: wide rounded shoulder -> crisp crest. */
const BLEND_DEGRADED = 0.6;
const BLEND_FRESH = 0.2;
/** The ejecta window must end beyond the bowl/ejecta blend zone (see craterHeight). */
const MIN_EJECTA_EXTENT = 0.5;
/** Craters at least this large (radius, m) start to get flatter floors. */
const FLAT_FLOOR_START_RADIUS = 30;
const FLAT_FLOOR_FULL_RADIUS = 120;

function clamp01(value: number): number {
  return value <= 0 ? 0 : value >= 1 ? 1 : value;
}

function smoothstep01(t: number): number {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

/**
 * Collect the crater parameters from flattened TerrainArgs. Single source of
 * truth for the worker, the height sampler and the benchmark.
 */
export function craterParamsFromTerrainArgs(
  args: Pick<
    TerrainArgs,
    | 'craterSeed'
    | 'craterDensity'
    | 'craterMinRadius'
    | 'craterMaxRadius'
    | 'craterPowerLawExponent'
    | 'craterDepthRatio'
    | 'craterRimHeight'
    | 'craterRimWidth'
    | 'craterFloorFlatness'
    | 'craterDegradedDepthRatio'
    | 'craterFreshnessExponent'
    | 'craterBreakRadius'
    | 'craterSteepExponent'
  >
): CraterParams {
  return {
    seed: args.craterSeed,
    density: args.craterDensity,
    minRadius: args.craterMinRadius,
    maxRadius: args.craterMaxRadius,
    powerLawExponent: args.craterPowerLawExponent,
    depthRatio: args.craterDepthRatio,
    rimHeight: args.craterRimHeight,
    rimWidth: args.craterRimWidth,
    floorFlatness: args.craterFloorFlatness,
    degradedDepthRatio: args.craterDegradedDepthRatio,
    freshnessExponent: args.craterFreshnessExponent,
    breakRadius: args.craterBreakRadius,
    steepExponent: args.craterSteepExponent,
  };
}

/**
 * Build a crater from an explicit shape.
 *
 * Fresh (freshness 1): rim-to-floor depth / diameter = the fresh depth ratio,
 * rim = rimHeight * diameter (scaled down with the fresh depth ratio for
 * craters that form shallow), narrow crest blend, full ejecta blanket.
 * Degraded (freshness 0): depth/diameter = degradedDepthRatio, no rim, wide
 * rounded shoulder.
 */
export function createCrater(shape: CraterShape, params: CraterParams): Crater {
  const { radius } = shape;
  const freshness = clamp01(shape.freshness);
  const degradedDepthRatio = params.degradedDepthRatio ?? DEFAULT_DEGRADED_DEPTH_RATIO;
  const diameter = 2 * radius;

  const freshRatio = shape.freshDepthRatio ?? params.depthRatio;
  const depthOverDiameter = degradedDepthRatio + (freshRatio - degradedDepthRatio) * freshness;
  // Rims erode faster than bowls fill in
  const rimScale = params.depthRatio > 0 ? freshRatio / params.depthRatio : 1;
  const rimHeight = diameter * params.rimHeight * rimScale * freshness * Math.sqrt(freshness);
  // Depth ratios are measured from the rim crest; the floor lies that far
  // below the crest, not below the surrounding surface
  const depth = diameter * depthOverDiameter * (shape.depthScale ?? 1) - rimHeight;
  const blend = depth * (BLEND_DEGRADED + (BLEND_FRESH - BLEND_DEGRADED) * freshness);

  const sizeFlatness = smoothstep01(
    (radius - FLAT_FLOOR_START_RADIUS) / (FLAT_FLOOR_FULL_RADIUS - FLAT_FLOOR_START_RADIUS)
  );
  const flatness = clamp01(params.floorFlatness + 0.6 * sizeFlatness);
  const floorMix = 1 - 0.75 * flatness;

  const cutoff = 1 + Math.max(params.rimWidth, MIN_EJECTA_EXTENT);

  const h = shape.harmonics ?? [];
  const h2c = h[0] ?? 0;
  const h2s = h[1] ?? 0;
  const h3c = h[2] ?? 0;
  const h3s = h[3] ?? 0;
  const h4c = h[4] ?? 0;
  const h4s = h[5] ?? 0;
  const h5c = h[6] ?? 0;
  const h5s = h[7] ?? 0;
  // Upper bound of the radius scale 1 + sum(harmonics) over all angles
  const maxScale =
    1 + Math.hypot(h2c, h2s) + Math.hypot(h3c, h3s) + Math.hypot(h4c, h4s) + Math.hypot(h5c, h5s);
  const influenceRadius = cutoff * radius * maxScale;

  return {
    centerX: shape.centerX,
    centerZ: shape.centerZ,
    radius,
    freshness,
    depth,
    rimHeight,
    blend,
    floorMix,
    cutoff,
    influenceRadius,
    h2c,
    h2s,
    h3c,
    h3s,
    h4c,
    h4s,
    h5c,
    h5s,
    invRadius: 1 / radius,
    influenceSq: influenceRadius * influenceRadius,
    invCutoffSpan: 1 / (cutoff - 1),
  };
}

/**
 * Height contribution of one crater at an offset (dx, dz) from its center.
 *
 * With s = r / (R * angularScale):
 *   bowl(s)   = (depth + rim) * s² * (mix + (1 - mix) * s²) - depth
 *   ejecta(s) = rim * s^-3 * window(s),  window = (1 - u²)², u = (s-1)/(cutoff-1)
 *   height    = smoothMin(bowl, ejecta, blend)        for s < cutoff, else 0
 *
 * The bowl rises through the rim while the ejecta falls, so their smooth
 * minimum is a rounded crest whose width grows with `blend`. The window has
 * zero value and slope at the cutoff and zero slope at s = 1, and the bowl is
 * always more than `blend` above the ejecta by s = 1.5 (the minimum cutoff),
 * so the profile is C1 everywhere and exactly 0 from the cutoff outward.
 */
export function craterHeight(crater: Crater, dx: number, dz: number): number {
  const distanceSq = dx * dx + dz * dz;
  if (distanceSq >= crater.influenceSq) return 0;

  let s = 0;
  if (distanceSq > 1e-18) {
    const distance = Math.sqrt(distanceSq);
    const invDistance = 1 / distance;
    // cos/sin of n * angle by angle-addition recurrence (no atan2)
    const c1 = dx * invDistance;
    const s1 = dz * invDistance;
    const c2 = c1 * c1 - s1 * s1;
    const s2 = 2 * c1 * s1;
    const c3 = c2 * c1 - s2 * s1;
    const s3 = s2 * c1 + c2 * s1;
    const c4 = c2 * c2 - s2 * s2;
    const s4 = 2 * c2 * s2;
    const c5 = c4 * c1 - s4 * s1;
    const s5 = s4 * c1 + c4 * s1;
    const scale =
      1 +
      crater.h2c * c2 +
      crater.h2s * s2 +
      crater.h3c * c3 +
      crater.h3s * s3 +
      crater.h4c * c4 +
      crater.h4s * s4 +
      crater.h5c * c5 +
      crater.h5s * s5;
    s = (distance * crater.invRadius) / scale;
    if (s >= crater.cutoff) return 0;
  }

  const ss = s * s;
  const mix = crater.floorMix;
  const bowl = (crater.depth + crater.rimHeight) * ss * (mix + (1 - mix) * ss) - crater.depth;
  // Inside half the radius the ejecta curve is far more than `blend` above
  // the bowl (blend <= 0.6 * depth), so the smooth-min is just the bowl.
  if (ss < 0.25) return bowl;

  let ejecta = crater.rimHeight / (s * ss);
  if (s > 1) {
    const u = (s - 1) * crater.invCutoffSpan;
    const window = 1 - u * u;
    ejecta *= window * window;
  }

  const blend = crater.blend;
  const diff = bowl - ejecta;
  if (diff >= blend) return ejecta;
  if (diff <= -blend) return bowl;
  // Cubic polynomial smooth-min (C2 in its inputs)
  const t = 1 - Math.abs(diff) / blend;
  return (diff < 0 ? bowl : ejecta) - (t * t * t * blend) / 6;
}

/**
 * Radial profile of a crater in polar form (distance + angle around the
 * center). Convenience wrapper around craterHeight.
 */
export function craterHeightProfile(distance: number, angle: number, crater: Crater): number {
  return craterHeight(crater, distance * Math.cos(angle), distance * Math.sin(angle));
}

/**
 * Simple string hash for seeding random generator (same as in ChunkWorker)
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Craters per km² with radius above `radius`: density * r^exponent up to the
 * break radius and the steeper production slope beyond it, continuous at the
 * break.
 */
export function cumulativeCraterDensity(radius: number, params: CraterParams): number {
  const breakRadius = params.breakRadius ?? Infinity;
  if (radius <= breakRadius) return params.density * radius ** params.powerLawExponent;
  const steep = params.steepExponent ?? DEFAULT_STEEP_EXPONENT;
  return params.density * breakRadius ** params.powerLawExponent * (radius / breakRadius) ** steep;
}

/** Radius at which cumulativeCraterDensity equals `count` (its inverse). */
export function radiusForCumulativeDensity(count: number, params: CraterParams): number {
  const breakRadius = params.breakRadius ?? Infinity;
  const atBreak =
    breakRadius === Infinity ? 0 : params.density * breakRadius ** params.powerLawExponent;
  if (count >= atBreak) return (count / params.density) ** (1 / params.powerLawExponent);
  const steep = params.steepExponent ?? DEFAULT_STEEP_EXPONENT;
  return breakRadius * (count / atBreak) ** (1 / steep);
}

/** Small craters form in loose regolith and start out shallower (Stopar 2017). */
const SHALLOW_FRESH_RADIUS = 25;
const DEEP_FRESH_RADIUS = 200;
const SHALLOW_FRESH_SHARE = 0.6;

/**
 * Rim-to-floor depth / diameter of a newly formed crater: 60% of
 * params.depthRatio up to 25 m radius (0.12 for 0.2), rising with log radius
 * to the full ratio at 200 m.
 */
export function freshDepthRatio(radius: number, params: CraterParams): number {
  const t = smoothstep01(
    Math.log(radius / SHALLOW_FRESH_RADIUS) / Math.log(DEEP_FRESH_RADIUS / SHALLOW_FRESH_RADIUS)
  );
  return params.depthRatio * (SHALLOW_FRESH_SHARE + (1 - SHALLOW_FRESH_SHARE) * t);
}

/** Depth / diameter is (DIFFUSION_SCALE / (b + K))² as diffusion K accumulates. */
const DIFFUSION_SCALE = 0.07;

/**
 * Freshness (1 = just formed, 0 = about to be erased) of a crater whose
 * accumulated topographic diffusion is the fraction `age` of what erases it.
 * Follows the diffusion curve of Minton et al. 2019: depth drops quickly at
 * first and slowly later, so a population with evenly spread ages is mostly
 * shallow with a tail of sharp craters.
 */
export function freshnessForAge(age: number, freshRatio: number, degradedRatio: number): number {
  if (!(freshRatio > degradedRatio)) return 0;
  const start = DIFFUSION_SCALE / Math.sqrt(freshRatio);
  const end = DIFFUSION_SCALE / Math.sqrt(degradedRatio);
  const ratio = (DIFFUSION_SCALE / (start + (end - start) * clamp01(age))) ** 2;
  return clamp01((ratio - degradedRatio) / (freshRatio - degradedRatio));
}

/**
 * Poisson-distributed count. Knuth's product method for small means, a
 * rounded normal approximation above (exp(-mean) underflows for the ~1000
 * craters of a saturated chunk).
 */
export function samplePoissonCount(mean: number, random: () => number): number {
  if (!(mean > 0)) return 0;
  if (mean < 30) {
    const limit = Math.exp(-mean);
    let count = 0;
    let product = random();
    while (product > limit) {
      count++;
      product *= random();
    }
    return count;
  }
  // Box-Muller; 1 - random() keeps the log argument in (0, 1]
  const gaussian = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Math.max(0, Math.round(mean + Math.sqrt(mean) * gaussian));
}

/**
 * Parse grid key "x,z" to [gridX, gridZ]
 */
export function parseGridKey(gridKey: string): [number, number] {
  const [x, z] = gridKey.split(',').map(Number);
  return [x, z];
}

/**
 * Radius that splits a cell's craters into a "small" population (influence
 * well under a chunk, only the 3x3 neighbor cells can reach this chunk) and
 * a sparse "large" population that is scanned over a wider cell window.
 */
function populationSplitRadius(chunkWidth: number, chunkDepth: number, cutoff: number): number {
  return Math.min(chunkWidth, chunkDepth) / (10 * cutoff);
}

/** Upper bound of influenceRadius / radius: cutoff times the largest harmonic scale. */
const MAX_HARMONIC_SUM = 0.08 + 0.025 + 0.02 + 0.012;

function maxInfluenceFactor(params: CraterParams): number {
  return (1 + Math.max(params.rimWidth, MIN_EJECTA_EXTENT)) * (1 + MAX_HARMONIC_SUM);
}

/**
 * Generate one size band [bandMin, bandMax) of the craters centered in a
 * chunk cell. Each (cell, band) pair has its own RNG stream.
 */
function generateBand(
  gridX: number,
  gridZ: number,
  chunkWidth: number,
  chunkDepth: number,
  params: CraterParams,
  bandName: string,
  bandMin: number,
  bandMax: number
): Crater[] {
  const craters: Crater[] = [];
  if (!(bandMax > bandMin) || !(params.density > 0)) return craters;

  const random = alea(hashString(`crater:${params.seed}:${bandName}:${gridX},${gridZ}`));

  const chunkAreaKm2 = (chunkWidth * chunkDepth) / 1_000_000;
  const densityAtMin = cumulativeCraterDensity(bandMin, params);
  const densityAtMax = cumulativeCraterDensity(bandMax, params);
  const count = samplePoissonCount((densityAtMin - densityAtMax) * chunkAreaKm2, random);

  const ageExponent = 3 / (params.freshnessExponent ?? DEFAULT_FRESHNESS_EXPONENT);
  const degradedRatio = params.degradedDepthRatio ?? DEFAULT_DEGRADED_DEPTH_RATIO;
  const breakRadius = params.breakRadius ?? Infinity;

  for (let i = 0; i < count; i++) {
    const centerX = (gridX + random() - 0.5) * chunkWidth;
    const centerZ = (gridZ + random() - 0.5) * chunkDepth;
    // Inverse CDF of the cumulative size-frequency distribution
    const radius = radiusForCumulativeDensity(
      densityAtMin + random() * (densityAtMax - densityAtMin),
      params
    );

    // In equilibrium the mix of degradation states is the same at every
    // size. Craters above the break are younger than their lifetime, so the
    // larger they are the fresher the oldest of them is.
    const oldest = radius > breakRadius ? (breakRadius / radius) ** 1.2 : 1;
    const freshRatio = freshDepthRatio(radius, params);
    const freshness = freshnessForAge(oldest * random() ** ageExponent, freshRatio, degradedRatio);
    const depthScale = 0.85 + 0.3 * random();

    // Outline: slight ellipticity for some craters (squared draw keeps most
    // nearly round) plus gentle 3-5 lobed irregularity
    const ellipticity = 0.08 * random() ** 2;
    const phase2 = 2 * Math.PI * random();
    const amp3 = 0.025 * random();
    const phase3 = 2 * Math.PI * random();
    const amp4 = 0.02 * random();
    const phase4 = 2 * Math.PI * random();
    const amp5 = 0.012 * random();
    const phase5 = 2 * Math.PI * random();

    craters.push(
      createCrater(
        {
          centerX,
          centerZ,
          radius,
          freshness,
          depthScale,
          freshDepthRatio: freshRatio,
          harmonics: [
            ellipticity * Math.cos(phase2),
            ellipticity * Math.sin(phase2),
            amp3 * Math.cos(phase3),
            amp3 * Math.sin(phase3),
            amp4 * Math.cos(phase4),
            amp4 * Math.sin(phase4),
            amp5 * Math.cos(phase5),
            amp5 * Math.sin(phase5),
          ],
        },
        params
      )
    );
  }

  return craters;
}

// Per-(params, cell, band) cache. Neighboring chunks share 6 of their 9
// cells, so workers and the main-thread sampler regenerate very little.
const CELL_CACHE_LIMIT = 768;
const cellCache = new Map<string, Crater[]>();

function cachedBand(
  gridX: number,
  gridZ: number,
  chunkWidth: number,
  chunkDepth: number,
  params: CraterParams,
  paramsKey: string,
  bandName: string,
  bandMin: number,
  bandMax: number
): Crater[] {
  const key = `${paramsKey}|${bandName}|${gridX},${gridZ}`;
  let band = cellCache.get(key);
  if (band === undefined) {
    band = generateBand(gridX, gridZ, chunkWidth, chunkDepth, params, bandName, bandMin, bandMax);
    if (cellCache.size >= CELL_CACHE_LIMIT) {
      // Map iterates in insertion order: drop the oldest entry
      for (const oldest of cellCache.keys()) {
        cellCache.delete(oldest);
        break;
      }
    }
    cellCache.set(key, band);
  }
  return band;
}

/** Drop all cached crater cells (tests / benchmarks that need cold timings). */
export function clearCraterCellCache(): void {
  cellCache.clear();
}

/**
 * Canonical evaluation order: largest first, ties broken by position. Every
 * consumer sums contributions in this order, so two chunks that share a
 * vertex add the same numbers in the same sequence and agree exactly.
 */
function compareCraters(a: Crater, b: Crater): number {
  return b.radius - a.radius || a.centerX - b.centerX || a.centerZ - b.centerZ;
}

/** Smallest radius of the sparse "large" band of a cell (see populationSplitRadius). */
function largeBandMinRadius(chunkWidth: number, chunkDepth: number, params: CraterParams): number {
  const cutoff = 1 + Math.max(params.rimWidth, MIN_EJECTA_EXTENT);
  return Math.min(
    Math.max(populationSplitRadius(chunkWidth, chunkDepth, cutoff), params.minRadius),
    params.maxRadius
  );
}

type SizeBand = [name: string, bandMin: number, bandMax: number];

/**
 * Size bands of a cell, each with its own RNG stream and scan window: 'S'
 * (reaches only the 3x3 neighbour cells), 'L' (reaches at most one chunk) and
 * the very sparse 'XL', which is scanned over as many cell rings as its
 * largest crater can bridge.
 */
function sizeBands(chunkWidth: number, chunkDepth: number, params: CraterParams): SizeBand[] {
  const split = largeBandMinRadius(chunkWidth, chunkDepth, params);
  const giant = Math.min(
    Math.max(Math.min(chunkWidth, chunkDepth) / maxInfluenceFactor(params), split),
    params.maxRadius
  );
  return [
    ['S', params.minRadius, split],
    ['L', split, giant],
    ['XL', giant, params.maxRadius],
  ];
}

/** World-space rectangle. */
export interface CraterBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * The large craters (radius >= minRadius) that can affect a rectangle of any
 * size, in canonical order. They are the same craters, from the same RNG
 * streams, that generateCratersForRegion gives the chunks, so distant
 * terrain built from this list lines up with the chunk meshes.
 *
 * Only the sparse large band of each cell is generated, which keeps this
 * cheap over thousands of cells; minRadius below that band's lower bound is
 * raised to it. Cells are not cached.
 */
export function generateLargeCratersInBounds(
  bounds: CraterBounds,
  chunkWidth: number,
  chunkDepth: number,
  params: CraterParams,
  minRadius: number
): Crater[] {
  const result: Crater[] = [];
  if (!(params.density > 0)) return result;

  const bands = sizeBands(chunkWidth, chunkDepth, params).slice(1);
  for (const [bandName, bandMin, bandMax] of bands) {
    if (!(bandMax > bandMin) || bandMax <= minRadius) continue;

    const reach = bandMax * maxInfluenceFactor(params);
    const gridX0 = Math.round((bounds.minX - reach) / chunkWidth);
    const gridX1 = Math.round((bounds.maxX + reach) / chunkWidth);
    const gridZ0 = Math.round((bounds.minZ - reach) / chunkDepth);
    const gridZ1 = Math.round((bounds.maxZ + reach) / chunkDepth);

    for (let gridX = gridX0; gridX <= gridX1; gridX++) {
      for (let gridZ = gridZ0; gridZ <= gridZ1; gridZ++) {
        const band = generateBand(
          gridX,
          gridZ,
          chunkWidth,
          chunkDepth,
          params,
          bandName,
          bandMin,
          bandMax
        );
        for (let i = 0; i < band.length; i++) {
          const crater = band[i];
          const reachRadius = crater.influenceRadius;
          if (
            crater.radius >= minRadius &&
            crater.centerX + reachRadius >= bounds.minX &&
            crater.centerX - reachRadius <= bounds.maxX &&
            crater.centerZ + reachRadius >= bounds.minZ &&
            crater.centerZ - reachRadius <= bounds.maxZ
          ) {
            result.push(crater);
          }
        }
      }
    }
  }

  return result.sort(compareCraters);
}

/**
 * All craters that can affect a chunk (plus an optional margin around it),
 * in canonical order.
 *
 * Small craters come from the 3x3 neighbor cells; large ones (whose influence
 * can exceed a chunk) from as many cell rings as their reach requires, so no
 * crater is ever missing on one side of a chunk border.
 *
 * @param gridKey - Chunk grid key "x,z"
 * @param chunkWidth - Chunk width in meters
 * @param chunkDepth - Chunk depth in meters
 * @param params - Crater generation parameters
 * @param margin - Extra reach around the chunk bounds in meters (mesh skirt,
 *   rock probes slightly outside the chunk)
 */
export function generateCratersForRegion(
  gridKey: string,
  chunkWidth: number,
  chunkDepth: number,
  params: CraterParams,
  margin: number = 0
): Crater[] {
  const [gridX, gridZ] = parseGridKey(gridKey);
  const result: Crater[] = [];
  if (!(params.density > 0)) return result;

  const minX = (gridX - 0.5) * chunkWidth - margin;
  const maxX = (gridX + 0.5) * chunkWidth + margin;
  const minZ = (gridZ - 0.5) * chunkDepth - margin;
  const maxZ = (gridZ + 0.5) * chunkDepth + margin;

  const influenceFactor = maxInfluenceFactor(params);
  const minRadius = params.minRadius;
  const maxRadius = params.maxRadius;
  const paramsKey = [
    params.seed,
    params.density,
    minRadius,
    maxRadius,
    params.powerLawExponent,
    params.depthRatio,
    params.rimHeight,
    params.rimWidth,
    params.floorFlatness,
    params.degradedDepthRatio ?? DEFAULT_DEGRADED_DEPTH_RATIO,
    params.freshnessExponent ?? DEFAULT_FRESHNESS_EXPONENT,
    params.breakRadius ?? Infinity,
    params.steepExponent ?? DEFAULT_STEEP_EXPONENT,
    chunkWidth,
    chunkDepth,
  ].join(':');

  for (const [bandName, bandMin, bandMax] of sizeBands(chunkWidth, chunkDepth, params)) {
    if (!(bandMax > bandMin)) continue;
    // A crater centered n cells away is at least (n - 1) chunks from this
    // chunk's bounds, so scan every ring its reach can bridge.
    const reach = bandMax * influenceFactor + margin;
    const ringsX = Math.max(1, Math.ceil(reach / chunkWidth));
    const ringsZ = Math.max(1, Math.ceil(reach / chunkDepth));

    for (let dx = -ringsX; dx <= ringsX; dx++) {
      for (let dz = -ringsZ; dz <= ringsZ; dz++) {
        const band = cachedBand(
          gridX + dx,
          gridZ + dz,
          chunkWidth,
          chunkDepth,
          params,
          paramsKey,
          bandName,
          bandMin,
          bandMax
        );
        for (let i = 0; i < band.length; i++) {
          const crater = band[i];
          const reachRadius = crater.influenceRadius;
          if (
            crater.centerX + reachRadius >= minX &&
            crater.centerX - reachRadius <= maxX &&
            crater.centerZ + reachRadius >= minZ &&
            crater.centerZ - reachRadius <= maxZ
          ) {
            result.push(crater);
          }
        }
      }
    }
  }

  return result.sort(compareCraters);
}

/**
 * Crater height modification at a world point: the additive sum of every
 * crater's contribution (brute force over the list; use a CraterIndex for
 * repeated queries).
 */
export function getCraterHeightModAt(
  worldX: number,
  worldZ: number,
  craters: readonly Crater[]
): number {
  let total = 0;
  for (let i = 0; i < craters.length; i++) {
    const crater = craters[i];
    total += craterHeight(crater, worldX - crater.centerX, worldZ - crater.centerZ);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Spatial index for point queries
// ---------------------------------------------------------------------------

/** Default bucket edge length in meters. */
export const CRATER_INDEX_BUCKET_SIZE = 8;

/**
 * Uniform-grid index over a crater list.
 *
 * Craters whose radius is at least `largeRadius` are kept in `largeCount`
 * leading entries of the (canonically sorted, largest first) list and tested
 * on every query; all others are referenced from the buckets they overlap.
 */
export interface CraterIndex {
  craters: readonly Crater[];
  /** Number of leading craters tested on every query */
  largeCount: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  invBucketSize: number;
  bucketsX: number;
  bucketsZ: number;
  /** CSR offsets into bucketItems, length bucketsX * bucketsZ + 1 */
  bucketStarts: Uint32Array;
  /** Crater indices per bucket, ascending (= canonical order) */
  bucketItems: Uint32Array;
}

/**
 * Build a point-query index for the rectangle [minX, maxX] x [minZ, maxZ].
 *
 * @param craters - Craters in canonical order (as returned by
 *   generateCratersForRegion); other orders are sorted into a copy first
 */
export function buildCraterIndex(
  craters: readonly Crater[],
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  bucketSize: number = CRATER_INDEX_BUCKET_SIZE
): CraterIndex {
  let sorted = craters;
  for (let i = 1; i < craters.length; i++) {
    if (compareCraters(craters[i - 1], craters[i]) > 0) {
      sorted = [...craters].sort(compareCraters);
      break;
    }
  }

  // A crater this large would be listed in 25+ buckets; test it directly
  const largeRadius = bucketSize;
  let largeCount = 0;
  while (largeCount < sorted.length && sorted[largeCount].radius >= largeRadius) largeCount++;

  const invBucketSize = 1 / bucketSize;
  const bucketsX = Math.max(1, Math.ceil((maxX - minX) * invBucketSize));
  const bucketsZ = Math.max(1, Math.ceil((maxZ - minZ) * invBucketSize));
  const bucketStarts = new Uint32Array(bucketsX * bucketsZ + 1);

  // Bucket range covered by a crater's influence square, clamped to the grid
  // (returns false when it lies entirely outside)
  const range = { x0: 0, x1: 0, z0: 0, z1: 0 };
  const bucketRange = (crater: Crater): boolean => {
    const reach = crater.influenceRadius;
    const x0 = Math.floor((crater.centerX - reach - minX) * invBucketSize);
    const x1 = Math.floor((crater.centerX + reach - minX) * invBucketSize);
    const z0 = Math.floor((crater.centerZ - reach - minZ) * invBucketSize);
    const z1 = Math.floor((crater.centerZ + reach - minZ) * invBucketSize);
    if (x1 < 0 || z1 < 0 || x0 >= bucketsX || z0 >= bucketsZ) return false;
    range.x0 = Math.max(0, x0);
    range.x1 = Math.min(bucketsX - 1, x1);
    range.z0 = Math.max(0, z0);
    range.z1 = Math.min(bucketsZ - 1, z1);
    return true;
  };

  // Pass 1: count entries per bucket (stored at bucket + 1 for the prefix sum)
  for (let i = largeCount; i < sorted.length; i++) {
    if (!bucketRange(sorted[i])) continue;
    for (let bz = range.z0; bz <= range.z1; bz++) {
      for (let bx = range.x0; bx <= range.x1; bx++) {
        bucketStarts[bz * bucketsX + bx + 1]++;
      }
    }
  }
  for (let b = 0; b < bucketsX * bucketsZ; b++) {
    bucketStarts[b + 1] += bucketStarts[b];
  }

  // Pass 2: fill, ascending crater index within each bucket
  const bucketItems = new Uint32Array(bucketStarts[bucketsX * bucketsZ]);
  const cursor = bucketStarts.slice(0, bucketsX * bucketsZ);
  for (let i = largeCount; i < sorted.length; i++) {
    if (!bucketRange(sorted[i])) continue;
    for (let bz = range.z0; bz <= range.z1; bz++) {
      for (let bx = range.x0; bx <= range.x1; bx++) {
        bucketItems[cursor[bz * bucketsX + bx]++] = i;
      }
    }
  }

  return {
    craters: sorted,
    largeCount,
    minX,
    minZ,
    maxX,
    maxZ,
    invBucketSize,
    bucketsX,
    bucketsZ,
    bucketStarts,
    bucketItems,
  };
}

/**
 * Crater height modification at a world point via the index. Returns exactly
 * what getCraterHeightModAt returns for the indexed list (same contributions,
 * same order); points outside the indexed rectangle fall back to that brute
 * force scan.
 */
export function sampleCraterIndex(index: CraterIndex, worldX: number, worldZ: number): number {
  const craters = index.craters;
  if (worldX < index.minX || worldX > index.maxX || worldZ < index.minZ || worldZ > index.maxZ) {
    return getCraterHeightModAt(worldX, worldZ, craters);
  }

  let total = 0;
  for (let i = 0; i < index.largeCount; i++) {
    const crater = craters[i];
    total += craterHeight(crater, worldX - crater.centerX, worldZ - crater.centerZ);
  }

  const bx = Math.min(index.bucketsX - 1, Math.floor((worldX - index.minX) * index.invBucketSize));
  const bz = Math.min(index.bucketsZ - 1, Math.floor((worldZ - index.minZ) * index.invBucketSize));
  const bucket = bz * index.bucketsX + bx;
  const items = index.bucketItems;
  const end = index.bucketStarts[bucket + 1];
  for (let k = index.bucketStarts[bucket]; k < end; k++) {
    const crater = craters[items[k]];
    total += craterHeight(crater, worldX - crater.centerX, worldZ - crater.centerZ);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Mesh rasterization
// ---------------------------------------------------------------------------

/** Craters with a radius below this many vertex spacings are left out of a mesh. */
export const LOD_FADE_START = 1.25;
/** Craters with a radius above this many vertex spacings are drawn at full strength. */
export const LOD_FADE_END = 2.5;

/**
 * Mesh-only weight of a crater on a grid with the given vertex spacing.
 *
 * A crater spanning only a couple of vertices cannot be represented and just
 * adds aliasing noise on coarse LODs, so it is faded out smoothly (no pop at
 * LOD transitions) between LOD_FADE_END and LOD_FADE_START spacings. Point
 * sampling never applies this weight.
 */
export function craterLodWeight(radius: number, vertexSpacing: number): number {
  if (!(vertexSpacing > 0)) return 1;
  return smoothstep01((radius / vertexSpacing - LOD_FADE_START) / (LOD_FADE_END - LOD_FADE_START));
}

/**
 * Add craters to a regular height grid.
 *
 * Each crater only touches the vertices inside its influence circle (index
 * ranges are computed per crater and per row), so the cost is proportional
 * to the cratered area instead of craters x vertices.
 *
 * @param heights - Row-major grid, heights[row * xs.length + column]
 * @param xs - World X of every column, ascending and evenly spaced
 * @param zs - World Z of every row, ascending and evenly spaced
 * @param craters - Craters in canonical order (world coordinates)
 * @param vertexSpacing - Grid spacing used for the LOD fade (see
 *   craterLodWeight); 0 applies every crater at full strength
 */
export function rasterizeCraters(
  heights: Float64Array,
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  craters: readonly Crater[],
  vertexSpacing: number = 0
): void {
  const columns = xs.length;
  const rows = zs.length;
  if (columns < 2 || rows < 2) return;

  const x0 = xs[0];
  const z0 = zs[0];
  const invStepX = (columns - 1) / (xs[columns - 1] - x0);
  const invStepZ = (rows - 1) / (zs[rows - 1] - z0);

  for (let c = 0; c < craters.length; c++) {
    const crater = craters[c];
    const weight = craterLodWeight(crater.radius, vertexSpacing);
    if (weight === 0) continue;

    const { centerX, centerZ, influenceRadius, influenceSq } = crater;
    // Ranges are padded by one vertex so floating-point error in the index
    // estimate can never exclude a vertex; craterHeight does the exact test.
    const rowStart = Math.max(0, Math.floor((centerZ - influenceRadius - z0) * invStepZ) - 1);
    const rowEnd = Math.min(rows - 1, Math.ceil((centerZ + influenceRadius - z0) * invStepZ) + 1);

    for (let row = rowStart; row <= rowEnd; row++) {
      const dz = zs[row] - centerZ;
      const spanSq = influenceSq - dz * dz;
      if (spanSq <= 0) continue;
      const span = Math.sqrt(spanSq);
      const colStart = Math.max(0, Math.floor((centerX - span - x0) * invStepX) - 1);
      const colEnd = Math.min(columns - 1, Math.ceil((centerX + span - x0) * invStepX) + 1);
      const rowOffset = row * columns;
      for (let col = colStart; col <= colEnd; col++) {
        heights[rowOffset + col] += weight * craterHeight(crater, xs[col] - centerX, dz);
      }
    }
  }
}
