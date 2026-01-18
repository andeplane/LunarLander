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
  /** Altitude below which speed starts reducing (meters) */
  slowdownAltitude: number;
  /** Speed multiplier at minimum altitude (0.0 to 1.0) */
  slowdownFactor: number;
}

/**
 * Rock generation configuration based on scientific lunar distribution
 * 
 * Uses power-law size-frequency distribution: N(>D) = A * D^exponent
 * Where N(>D) is the number of rocks per m² with diameter > D
 * 
 * Based on Rüsch et al. 2024 lunar surface measurements:
 * - > 1 m: ~500 per km² (0.0005 per m²)
 * - > 0.3 m: ~5,000 per km² (0.005 per m²)
 * - > 0.1 m: ~200,000 per km² (0.2 per m²)
 */
export interface RockGenerationConfig {
  /** Smallest visible rock in meters (affects total density) */
  minDiameter: number;
  /** Largest boulders in meters (rare) */
  maxDiameter: number;
  /** Density constant A in N(>D) = A * D^exponent (per m² at D=1m) */
  densityConstant: number;
  /** Power-law exponent (typically -2.5 for lunar terrain) */
  powerLawExponent: number;
  /** Per-LOD multiplier for minDiameter (e.g., [1, 1, 1, 2, 4, 6]) */
  lodMinDiameterScale: number[];
}

/**
 * Crater generation configuration based on lunar crater size-frequency distribution
 * 
 * Uses power-law distribution: S(D) ≈ 22,000 · D^(-2.4) craters per km²
 * Based on Apollo 11 site data for craters 2-40m diameter.
 */
export interface CraterGenerationConfig {
  /** Random seed for deterministic crater placement */
  seed: number;
  /** Craters per km² at reference size (1m radius) */
  density: number;
  /** Minimum crater radius in meters */
  minRadius: number;
  /** Maximum crater radius in meters */
  maxRadius: number;
  /** Size-frequency distribution exponent (typically -2.0 to -3.0, lunar: -2.4) */
  powerLawExponent: number;
  /** Crater depth = radius * depthRatio * 2 (0.2 typical for small craters) */
  depthRatio: number;
  /** Rim height as fraction of depth (0-1, typical: 0.04) */
  rimHeight: number;
  /** Rim extends beyond crater radius by this fraction (e.g., 0.1 = 10%) */
  rimWidth: number;
  /** Floor shape: 0 = parabolic bowl, 1 = flat floor (for large craters) */
  floorFlatness: number;
}
