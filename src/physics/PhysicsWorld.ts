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

/**
 * Lunar gravity: -1.62 m/s² (Moon's surface gravity)
 */
const LUNAR_GRAVITY = -1.62;

export class PhysicsWorld {
  private world: RAPIER.World | null = null;
  private isInitialized: boolean = false;
  private ballManager: BallManager | null = null;

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
   */
  step(_deltaTime: number): void {
    if (!this.world || !this.isInitialized) {
      return;
    }

    // Step physics simulation
    this.world.step();

    // Update ball meshes to match physics positions
    if (this.ballManager) {
      this.ballManager.update();
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    if (this.world) {
      // Rapier doesn't have explicit dispose, but we can clear references
      this.world = null;
    }
    this.isInitialized = false;
    this.ballManager = null;
  }
}
