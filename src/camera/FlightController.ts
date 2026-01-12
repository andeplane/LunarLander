import * as THREE from 'three';
import type { CameraConfig } from '../types';
import { InputManager } from '../core/InputManager';

/**
 * Flight controller responsible for:
 * - Free-flight 6DOF camera controls
 * - Smooth acceleration/deceleration
 * - Speed adjustment
 * - Camera movement based on input
 */
export class FlightController {
  private camera: THREE.PerspectiveCamera;
  private inputManager: InputManager;
  private config: CameraConfig;
  private velocity: THREE.Vector3 = new THREE.Vector3();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private rotation: THREE.Euler = new THREE.Euler();

  constructor(camera: THREE.PerspectiveCamera, inputManager: InputManager, config: CameraConfig) {
    this.camera = camera;
    this.inputManager = inputManager;
    this.config = config;
    // Properties will be used in future implementation
    void this.camera;
    void this.inputManager;
    void this.config;
    void this.rotation;
  }

  /**
   * Update camera position and rotation based on input
   */
  update(_deltaTime: number): void {
    // Implementation will be added in future tickets
    // Will handle keyboard input, mouse rotation, and smooth movement
    // Using _deltaTime to indicate parameter is reserved for future use
    void _deltaTime;
  }

  /**
   * Get current speed
   */
  getCurrentSpeed(): number {
    return this.velocity.length();
  }
}
