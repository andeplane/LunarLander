/**
 * PhysicsWorld - Wrapper for Rapier physics world
 * 
 * Handles:
 * - Async initialization of Rapier WASM
 * - Physics world creation with lunar gravity
 * - Physics stepping
 * - Coordination between TerrainColliderManager and BallManager
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { TerrainColliderManager } from './TerrainColliderManager';
import type { BallManager } from './BallManager';
import { FixedTimestep } from './FixedTimestep';

/**
 * Lunar gravity: -1.62 m/s² (Moon's surface gravity)
 */
const LUNAR_GRAVITY = -1.62;

export class PhysicsWorld {
  private world: RAPIER.World | null = null;
  private isInitialized: boolean = false;
  private ballManager: BallManager | null = null;
  private timestep = new FixedTimestep();
  private objectsMoving: boolean = false;

  /**
   * Initialize Rapier WASM and create physics world.
   * Must be called before using the physics world.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Initialize Rapier WASM
    await RAPIER.init();

    // Create physics world with lunar gravity
    this.world = new RAPIER.World({
      x: 0,
      y: LUNAR_GRAVITY,
      z: 0,
    });

    this.isInitialized = true;
  }

  /**
   * Get the Rapier world instance.
   * Throws if not initialized.
   */
  getWorld(): RAPIER.World {
    if (!this.world) {
      throw new Error('PhysicsWorld not initialized. Call initialize() first.');
    }
    return this.world;
  }

  /**
   * Check if physics world is initialized.
   */
  isReady(): boolean {
    return this.isInitialized && this.world !== null;
  }

  /**
   * Set the terrain collider manager.
   * Note: This is stored for potential future use, but currently managed by Engine update loop.
   */
  setTerrainColliderManager(_manager: TerrainColliderManager): void {
    // Manager is handled by Engine.update(), not used here
  }

  /**
   * Set the ball manager.
   */
  setBallManager(manager: BallManager): void {
    this.ballManager = manager;
  }

  /**
   * Step the physics simulation forward by deltaTime seconds.
   * Should be called every frame.
   * 
   * @returns true if any physics objects are moving (need rendering), false otherwise
   */
  step(deltaTime: number): boolean {
    if (!this.world || !this.isInitialized) {
      return false;
    }

    // Advance the fixed-timestep accumulator and run the resulting number
    // of physics steps, so simulation speed is independent of frame rate
    const steps = this.timestep.advance(deltaTime);
    for (let i = 0; i < steps; i++) {
      // Capture pre-step transforms so meshes can interpolate between the
      // previous and current physics states on frames between fixed steps
      this.ballManager?.beforePhysicsStep();
      this.world.step();
    }

    // Leftover fraction of a step: how far render time has progressed
    // past the last simulated physics step
    const alpha = this.timestep.getAlpha();

    if (steps > 0) {
      // Update ball meshes to interpolated physics positions
      // Returns true if any balls are moving
      this.objectsMoving = this.ballManager ? this.ballManager.update(alpha) : false;
    } else if (this.objectsMoving && this.ballManager) {
      // No fixed step landed on this frame (display faster than the physics
      // rate), but balls are mid-flight: re-interpolate the meshes with the
      // grown alpha so motion stays smooth instead of stuttering at 60 Hz.
      // The cached objectsMoving flag is kept — movement/despawn state can
      // only change when a physics step actually runs.
      this.ballManager.update(alpha);
    }

    return this.objectsMoving;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.world) {
      // Free the WASM-side memory before clearing the reference
      this.world.free();
      this.world = null;
    }
    this.isInitialized = false;
    this.ballManager = null;
    this.timestep.reset();
    this.objectsMoving = false;
  }
}
