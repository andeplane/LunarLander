import * as THREE from 'three';
import type { CameraConfig } from '../types';
import type { InputManager } from '../core/InputManager';
import type { ChunkManager } from '../terrain/ChunkManager';
import { movementAmount } from '../utils/input';

/**
 * Flight controller responsible for:
 * - Free-flight 5DOF camera controls (no roll)
 * - Smooth acceleration/deceleration
 * - Speed adjustment via scroll wheel
 * - Camera movement based on input
 * - Terrain collision prevention
 */
export class FlightController {
  private camera: THREE.PerspectiveCamera;
  private inputManager: InputManager;
  private config: CameraConfig;
  private chunkManager: ChunkManager | null = null;
  
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
  private readonly targetPosition: THREE.Vector3 = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera, 
    inputManager: InputManager, 
    config: CameraConfig,
    chunkManager?: ChunkManager
  ) {
    this.camera = camera;
    this.inputManager = inputManager;
    this.config = config;
    this.chunkManager = chunkManager ?? null;
    
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
   * Also handles touch look on mobile devices
   */
  private handleMouseLook(): void {
    // Handle pointer lock (desktop)
    if (this.inputManager.isPointerLockActive()) {
      const mouseDelta = this.inputManager.getMouseDelta();

      // Apply mouse sensitivity
      this.yaw -= mouseDelta.x * this.config.mouseSensitivity;
      this.pitch -= mouseDelta.y * this.config.mouseSensitivity;
    } else {
      // Handle touch look — deltas are raw pixels (zero when no touch input),
      // so sensitivity is applied exactly once, here
      const touchDelta = this.inputManager.getTouchLookDelta();

      if (touchDelta.x === 0 && touchDelta.y === 0) {
        // No input active
        return;
      }
      // Apply touch sensitivity (same as mouse)
      this.yaw -= touchDelta.x * this.config.mouseSensitivity;
      this.pitch -= touchDelta.y * this.config.mouseSensitivity;
    }
    
    // Clamp pitch to prevent flipping (slightly less than 90 degrees)
    const maxPitch = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
  }

  /**
   * Handle scroll wheel speed adjustment
   * Touch devices can set speed multiplier via setSpeedMultiplier()
   */
  private handleSpeedAdjustment(): void {
    const scrollDelta = this.inputManager.getScrollDelta();
    
    if (scrollDelta !== 0) {
      // Scroll up (negative deltaY) increases speed, scroll down decreases
      const scrollFactor = 1.0 - scrollDelta * 0.001;
      this.speedMultiplier *= scrollFactor;
      
      // Clamp to min/max speed range
      const minMultiplier = this.config.minSpeed / this.config.baseSpeed;
      const maxMultiplier = this.config.maxSpeed / this.config.baseSpeed;
      this.speedMultiplier = Math.max(minMultiplier, Math.min(maxMultiplier, this.speedMultiplier));
    }
  }

  /**
   * Set speed multiplier (for touch controls)
   */
  setSpeedMultiplier(multiplier: number): void {
    const minMultiplier = this.config.minSpeed / this.config.baseSpeed;
    const maxMultiplier = this.config.maxSpeed / this.config.baseSpeed;
    this.speedMultiplier = Math.max(minMultiplier, Math.min(maxMultiplier, multiplier));
  }

  /**
   * Handle movement input (keyboard and/or touch)
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

    // Combine keyboard and touch input per direction. Touch inputs are zero
    // when inactive, so keyboard keeps working on touch-capable devices
    // (e.g. touchscreen laptops) and vice versa.
    const touchMove = this.inputManager.getMoveDirection();
    const verticalInput = this.inputManager.getVerticalInput();

    // Forward/backward (W/S or touch joystick Y)
    const forwardAmount = movementAmount(this.inputManager.isKeyPressed('w'), Math.max(touchMove.y, 0));
    if (forwardAmount > 0) {
      this.moveDirection.addScaledVector(this.forward, forwardAmount);
    }
    const backwardAmount = movementAmount(this.inputManager.isKeyPressed('s'), Math.max(-touchMove.y, 0));
    if (backwardAmount > 0) {
      this.moveDirection.addScaledVector(this.forward, -backwardAmount);
    }

    // Strafe left/right (A/D or touch joystick X)
    const leftAmount = movementAmount(this.inputManager.isKeyPressed('a'), Math.max(-touchMove.x, 0));
    if (leftAmount > 0) {
      this.moveDirection.addScaledVector(this.right, -leftAmount);
    }
    const rightAmount = movementAmount(this.inputManager.isKeyPressed('d'), Math.max(touchMove.x, 0));
    if (rightAmount > 0) {
      this.moveDirection.addScaledVector(this.right, rightAmount);
    }

    // Up/down (E for up, Q for down, or touch buttons)
    const upAmount = movementAmount(this.inputManager.isKeyPressed('e'), Math.max(verticalInput, 0));
    if (upAmount > 0) {
      this.moveDirection.addScaledVector(this.up, upAmount);
    }
    const downAmount = movementAmount(this.inputManager.isKeyPressed('q'), Math.max(-verticalInput, 0));
    if (downAmount > 0) {
      this.moveDirection.addScaledVector(this.up, -downAmount);
    }

    // Normalize if moving diagonally
    if (this.moveDirection.lengthSq() > 0) {
      this.moveDirection.normalize();
    }

    // Calculate target velocity with shift speed boost
    const shiftBoost = this.inputManager.isKeyPressed('shift') ? this.shiftSpeedMultiplier : 1.0;
    const baseTargetSpeed = this.config.baseSpeed * this.speedMultiplier * shiftBoost;

    // Apply speed scaling based on Altitude Above Ground Level (AGL)
    // ONLY applied to the vertical (Y) component of movement AND only when moving DOWN
    let ySpeedFactor = 1.0;
    if (this.chunkManager && this.moveDirection.y < 0) {
      const terrainHeight = this.chunkManager.getHeightAt(this.camera.position.x, this.camera.position.z);
      if (terrainHeight !== null) {
        const altitudeAGL = this.camera.position.y - terrainHeight;
        
        // Custom smooth slowdown curve:
        // 50m -> 5m: 100% -> 50%
        // 5m -> 1m: 50% -> 25%
        // 1m -> 0.5m: 25% -> 0%
        if (altitudeAGL <= 0.5) {
          ySpeedFactor = 0.0;
        } else if (altitudeAGL <= 1.0) {
          // 1.0m to 0.5m: maps 25% to 0%
          const t = (altitudeAGL - 0.5) / (1.0 - 0.5);
          ySpeedFactor = THREE.MathUtils.lerp(0.0, 0.25, t);
        } else if (altitudeAGL <= 5.0) {
          // 5.0m to 1.0m: maps 50% to 25%
          const t = (altitudeAGL - 1.0) / (5.0 - 1.0);
          ySpeedFactor = THREE.MathUtils.lerp(0.25, 0.5, t);
        } else if (altitudeAGL <= 50.0) {
          // 50m to 5.0m: maps 100% to 50%
          const t = (altitudeAGL - 5.0) / (50.0 - 5.0);
          ySpeedFactor = THREE.MathUtils.lerp(0.5, 1.0, t);
        }
      }
    }

    // Split movement into horizontal and vertical components to apply scaling separately
    const targetVelocity = new THREE.Vector3();
    
    // Horizontal component (X, Z) - remains at base speed
    targetVelocity.x = this.moveDirection.x * baseTargetSpeed;
    targetVelocity.z = this.moveDirection.z * baseTargetSpeed;
    
    // Vertical component (Y) - scaled by ySpeedFactor
    targetVelocity.y = this.moveDirection.y * baseTargetSpeed * ySpeedFactor;

    // Smooth acceleration/deceleration using exponential decay
    const smoothing = 1.0 - Math.exp(-this.config.acceleration * deltaTime);
    this.velocity.lerp(targetVelocity, smoothing);

    // Predict next position
    this.targetPosition.copy(this.camera.position);
    this.targetPosition.addScaledVector(this.velocity, deltaTime);

    // Prevent collision with terrain
    if (this.chunkManager) {
      // 1. Ensure current altitude is respected (prevents sinking if terrain loads under us)
      const currentTerrainHeight = this.chunkManager.getHeightAt(this.camera.position.x, this.camera.position.z);
      if (currentTerrainHeight !== null) {
        const minHeight = currentTerrainHeight + this.config.minAltitudeAGL;
        if (this.camera.position.y < minHeight) {
          this.camera.position.y = minHeight;
          // Sync targetPosition if we were forced up
          this.targetPosition.y = Math.max(this.targetPosition.y, minHeight);
        }
      }

      // 2. Check target position for future collision
      const targetTerrainHeight = this.chunkManager.getHeightAt(this.targetPosition.x, this.targetPosition.z);
      if (targetTerrainHeight !== null) {
        const minHeight = targetTerrainHeight + this.config.minAltitudeAGL;
        if (this.targetPosition.y < minHeight) {
          this.targetPosition.y = minHeight;
          
          // Zero out downward velocity component if we hit the floor
          if (this.velocity.y < 0) {
            this.velocity.y = 0;
          }
        }
      }
    }

    // Apply position
    this.camera.position.copy(this.targetPosition);
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
