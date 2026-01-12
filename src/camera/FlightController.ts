import * as THREE from 'three';
import type { CameraConfig } from '../types';
import { InputManager } from '../core/InputManager';

/**
 * Flight controller responsible for:
 * - Free-flight 5DOF camera controls (no roll)
 * - Smooth acceleration/deceleration
 * - Speed adjustment via scroll wheel
 * - Camera movement based on input
 */
export class FlightController {
  private camera: THREE.PerspectiveCamera;
  private inputManager: InputManager;
  private config: CameraConfig;
  
  // Current velocity in world space
  private velocity: THREE.Vector3 = new THREE.Vector3();
  
  // Current speed multiplier (adjusted by scroll wheel)
  private speedMultiplier: number = 1.0;
  
  // Shift key speed boost multiplier
  private readonly shiftSpeedMultiplier: number = 3.0;
  
  // Euler angles for rotation (pitch, yaw only - no roll)
  private pitch: number = 0; // Up/down rotation
  private yaw: number = 0;   // Left/right rotation
  
  // Reusable vectors to avoid per-frame allocations
  private readonly moveDirection: THREE.Vector3 = new THREE.Vector3();
  private readonly forward: THREE.Vector3 = new THREE.Vector3();
  private readonly right: THREE.Vector3 = new THREE.Vector3();
  private readonly up: THREE.Vector3 = new THREE.Vector3(0, 1, 0);

  constructor(camera: THREE.PerspectiveCamera, inputManager: InputManager, config: CameraConfig) {
    this.camera = camera;
    this.inputManager = inputManager;
    this.config = config;
    
    // Initialize rotation from camera's current orientation
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = euler.y;
    this.pitch = euler.x;
  }

  /**
   * Update camera position and rotation based on input
   */
  update(deltaTime: number): void {
    this.handleMouseLook();
    this.handleSpeedAdjustment();
    this.handleMovement(deltaTime);
    this.applyTransform();
  }

  /**
   * Handle mouse look (pitch and yaw)
   */
  private handleMouseLook(): void {
    if (!this.inputManager.isPointerLockActive()) return;

    const mouseDelta = this.inputManager.getMouseDelta();
    
    // Apply mouse sensitivity
    this.yaw -= mouseDelta.x * this.config.mouseSensitivity;
    this.pitch -= mouseDelta.y * this.config.mouseSensitivity;
    
    // Clamp pitch to prevent flipping (slightly less than 90 degrees)
    const maxPitch = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
  }

  /**
   * Handle scroll wheel speed adjustment
   */
  private handleSpeedAdjustment(): void {
    const scrollDelta = this.inputManager.getScrollDelta();
    
    if (scrollDelta !== 0) {
      // Scroll down increases speed, scroll up decreases
      const scrollFactor = 1.0 - scrollDelta * 0.001;
      this.speedMultiplier *= scrollFactor;
      
      // Clamp to min/max speed range
      const minMultiplier = this.config.minSpeed / this.config.baseSpeed;
      const maxMultiplier = this.config.maxSpeed / this.config.baseSpeed;
      this.speedMultiplier = Math.max(minMultiplier, Math.min(maxMultiplier, this.speedMultiplier));
    }
  }

  /**
   * Handle keyboard movement input
   */
  private handleMovement(deltaTime: number): void {
    // Calculate forward and right vectors from yaw only (ignore pitch for movement)
    this.forward.set(
      -Math.sin(this.yaw),
      0,
      -Math.cos(this.yaw)
    ).normalize();
    
    this.right.set(
      Math.cos(this.yaw),
      0,
      -Math.sin(this.yaw)
    ).normalize();

    // Build movement direction from input
    this.moveDirection.set(0, 0, 0);

    // Forward/backward (W/S)
    if (this.inputManager.isKeyPressed('w')) {
      this.moveDirection.add(this.forward);
    }
    if (this.inputManager.isKeyPressed('s')) {
      this.moveDirection.sub(this.forward);
    }

    // Strafe left/right (A/D)
    if (this.inputManager.isKeyPressed('a')) {
      this.moveDirection.sub(this.right);
    }
    if (this.inputManager.isKeyPressed('d')) {
      this.moveDirection.add(this.right);
    }

    // Up/down (E for up, Q for down)
    if (this.inputManager.isKeyPressed('e')) {
      this.moveDirection.add(this.up);
    }
    if (this.inputManager.isKeyPressed('q')) {
      this.moveDirection.sub(this.up);
    }

    // Normalize if moving diagonally
    if (this.moveDirection.lengthSq() > 0) {
      this.moveDirection.normalize();
    }

    // Calculate target velocity with shift speed boost
    const shiftBoost = this.inputManager.isKeyPressed('shift') ? this.shiftSpeedMultiplier : 1.0;
    const targetSpeed = this.config.baseSpeed * this.speedMultiplier * shiftBoost;
    const targetVelocity = this.moveDirection.multiplyScalar(targetSpeed);

    // Smooth acceleration/deceleration using exponential decay
    const smoothing = 1.0 - Math.exp(-this.config.acceleration * deltaTime);
    this.velocity.lerp(targetVelocity, smoothing);

    // Apply velocity to position
    this.camera.position.addScaledVector(this.velocity, deltaTime);
  }

  /**
   * Apply rotation transform to camera
   */
  private applyTransform(): void {
    // Apply rotation using YXZ order (yaw, pitch, roll)
    // This prevents gimbal lock and gives intuitive FPS-style controls
    this.camera.quaternion.setFromEuler(
      new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')
    );
  }

  /**
   * Get current speed in m/s
   */
  getCurrentSpeed(): number {
    return this.velocity.length();
  }

  /**
   * Get current altitude (Y position)
   */
  getAltitude(): number {
    return this.camera.position.y;
  }

  /**
   * Get current speed multiplier
   */
  getSpeedMultiplier(): number {
    return this.speedMultiplier;
  }
}
