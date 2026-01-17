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
