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
}
