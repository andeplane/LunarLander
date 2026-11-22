/**
 * Camera configuration for flight controls
 */
export interface CameraConfig {
  fov: number;
  near: number;
  far: number;
  baseSpeed: number;
  minSpeed: number;
  maxSpeed: number;
  acceleration: number;
  mouseSensitivity: number;
  /** Minimum altitude above ground level (meters) */
  minAltitudeAGL: number;
}

/**
 * Rock generation configuration based on scientific lunar distribution
 *
 * Uses power-law size-frequency distribution: N(>D) = A * D^exponent
 * Where N(>D) is the number of rocks per m² with diameter > D, averaged over
 * the terrain. Locally the density follows a low-frequency field: boulder
 * fields carry several times the average, the plains between them almost
 * nothing.
 *
 * Rüsch et al. 2024 lunar surface measurements for reference:
 * - > 1 m: ~500 per km² (0.0005 per m²)
 * - > 0.3 m: ~5,000 per km² (0.005 per m²)
 */
export interface RockGenerationConfig {
  /** Smallest rock in meters at LOD 0 (affects total count) */
  minDiameter: number;
  /** Largest boulders in meters (rare) */
  maxDiameter: number;
  /** Density constant A in N(>D) = A * D^exponent (per m² at D=1m), terrain average */
  densityConstant: number;
  /** Power-law exponent (negative; steeper = relatively more small rocks) */
  powerLawExponent: number;
  /** Per-LOD multiplier for minDiameter; LODs beyond the list use its last entry */
  lodMinDiameterScale: number[];
  /** Wavelength in meters of the boulder-field density pattern (default 450) */
  fieldScale?: number;
  /**
   * Relative weight of the density in the middle of a boulder field (default
   * 3.6). Only the ratio to plainsDensity matters: the average over the
   * terrain always equals the power law.
   */
  fieldPeakDensity?: number;
  /** Relative weight of the density on the open plains (default 0.15) */
  plainsDensity?: number;
  /**
   * Hard cap on rock triangles in one chunk at LOD 0 (default 250000). Rocks
   * beyond it are left out, at every LOD, so the population never changes
   * with distance.
   */
  maxTrianglesPerChunk?: number;
}

/**
 * Crater generation configuration: a crater-saturated lunar surface.
 *
 * Cumulative size-frequency N(>r) = density * r^powerLawExponent craters per
 * km² (r = radius in meters). Every crater gets a freshness (age) that sets
 * its depth, rim and crest sharpness; most are old, soft and shallow.
 */
export interface CraterGenerationConfig {
  /** Random seed for deterministic crater placement */
  seed: number;
  /** Craters per km² with radius >= 1 m (lunar equilibrium is ~12,000) */
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
  /** Age skew: freshness = u^exponent, higher = more degraded craters (default 3) */
  freshnessExponent?: number;
  /** Radius above which the size-frequency slope steepens (default none) */
  breakRadius?: number;
  /** Cumulative size-frequency exponent above the break (default -3.2) */
  steepExponent?: number;
}
