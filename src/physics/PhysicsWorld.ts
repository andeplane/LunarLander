/**
 * PhysicsWorld - Wrapper for Rapier physics world
 *
 * Handles:
 * - Async initialization of Rapier WASM
 * - Physics world creation with lunar gravity
 * - Physics stepping
 * - A registry of PhysicsStepListeners (balls, lander, ...) that apply
 *   forces per fixed step and sync meshes with interpolation
 */
import RAPIER from '@dimforge/rapier3d-compat';
import type { TerrainColliderManager } from './TerrainColliderManager';
import { FixedTimestep } from './FixedTimestep';

/**
 * Lunar gravity: -1.62 m/s² (Moon's surface gravity)
 */
const LUNAR_GRAVITY = -1.62;

/**
 * A participant in the fixed-timestep physics loop.
 *
 * Contract (see ADR-0001 §3):
 * - beforePhysicsStep(dtFixed) runs once per fixed step, before world.step().
 *   Apply forces/torques and snapshot pre-step transforms here.
 * - afterPhysicsSync(alpha) syncs render meshes to physics state,
 *   interpolating between pre/post-step transforms by alpha. It runs on
 *   every frame where at least one fixed step landed, and additionally on
 *   zero-step frames while this listener's cached moving flag is set (the
 *   high-refresh-rate re-interpolation path). Returns whether this
 *   listener's objects are still moving (drives render-on-demand).
 */
export interface PhysicsStepListener {
  beforePhysicsStep(dtFixed: number): void;
  afterPhysicsSync(alpha: number): boolean;
}

export class PhysicsWorld {
  private world: RAPIER.World | null = null;
  private isInitialized: boolean = false;
  private timestep = new FixedTimestep();
  private listeners: PhysicsStepListener[] = [];
  /** Per-listener cached "still moving" flags (parallel to listeners). */
  private moving: WeakMap<PhysicsStepListener, boolean> = new WeakMap();

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
   * Register a physics step listener. Idempotent.
   */
  addPhysicsStepListener(listener: PhysicsStepListener): void {
    if (!this.listeners.includes(listener)) {
      this.listeners.push(listener);
      this.moving.set(listener, false);
    }
  }

  /**
   * Remove a physics step listener. Safe to call for unregistered listeners.
   */
  removePhysicsStepListener(listener: PhysicsStepListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
      this.moving.delete(listener);
    }
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
      // Listeners apply forces and capture pre-step transforms so meshes can
      // interpolate between the previous and current physics states
      for (const listener of this.listeners) {
        listener.beforePhysicsStep(this.timestep.stepSize);
      }
      this.world.step();
    }

    // Leftover fraction of a step: how far render time has progressed
    // past the last simulated physics step
    const alpha = this.timestep.getAlpha();

    let anyMoving = false;
    for (const listener of this.listeners) {
      if (steps > 0) {
        // Fixed step(s) landed this frame: sync meshes and refresh the
        // cached moving flag (movement/despawn state can only change when
        // a physics step actually runs)
        this.moving.set(listener, listener.afterPhysicsSync(alpha));
      } else if (this.moving.get(listener)) {
        // No fixed step landed (display faster than the physics rate), but
        // this listener's objects are mid-flight: re-interpolate with the
        // grown alpha so motion stays smooth instead of stuttering at 60 Hz.
        // The cached flag is kept — it can only change on a real step.
        listener.afterPhysicsSync(alpha);
      }
      if (this.moving.get(listener)) {
        anyMoving = true;
      }
    }

    return anyMoving;
  }

  /**
   * Reset the fixed-timestep accumulator (call on unpause so no catch-up
   * burst of physics steps fires for the time spent paused).
   */
  resetTimestep(): void {
    this.timestep.reset();
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
    this.listeners = [];
    this.moving = new WeakMap();
    this.timestep.reset();
  }
}
