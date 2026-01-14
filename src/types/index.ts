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
