/**
 * BallManager - Manages bouncing balls in the physics simulation
 * 
 * Handles:
 * - Shooting balls from camera position
 * - Syncing Three.js meshes with Rapier rigid bodies
 * - Cleaning up old balls when limit is exceeded
 * - Using CurvedStandardMaterial so balls visually match curved terrain
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsStepListener } from './PhysicsWorld';
import { CurvedStandardMaterial } from '../shaders/CurvedStandardMaterial';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';
import {
  clampSpawnY,
  interpolateTransform,
  isBallMoving,
  shouldDespawnBall,
  type TransformSnapshot,
} from './BallUtils';

interface Ball {
  rigidBody: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  /** Physics transform before the most recent fixed step (interpolation start). */
  prevTransform: TransformSnapshot;
  /** Physics transform after the most recent fixed step (interpolation end). */
  currTransform: TransformSnapshot;
}

/** Create a transform snapshot at a position with identity rotation. */
function createSnapshot(x: number, y: number, z: number): TransformSnapshot {
  return {
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
  };
}

/** Copy a rigid body's current physics transform into a snapshot (no allocation). */
function copyBodyTransform(body: RAPIER.RigidBody, out: TransformSnapshot): void {
  const pos = body.translation();
  out.position.x = pos.x;
  out.position.y = pos.y;
  out.position.z = pos.z;
  const rot = body.rotation();
  out.rotation.x = rot.x;
  out.rotation.y = rot.y;
  out.rotation.z = rot.z;
  out.rotation.w = rot.w;
}

/**
 * Samples the terrain height at a world (x, z) position.
 * Returns null when the height is unknown (e.g. chunk not loaded).
 */
export type HeightSampler = (x: number, z: number) => number | null;

export interface BallManagerConfig {
  ballRadius?: number;
  shootSpeed?: number;
  maxBalls?: number;
  restitution?: number;
  friction?: number;
  ballColor?: number;
  /**
   * Balls whose Y position drops below this altitude are despawned.
   * Terrain colliders only exist near the camera, so a ball outside that
   * window falls forever; despawning it lets rendering go idle again.
   */
  killY?: number;
}

const DEFAULT_CONFIG: Required<BallManagerConfig> = {
  ballRadius: 0.3,
  shootSpeed: 20,
  maxBalls: 100,
  restitution: 0.7,
  friction: 0.3,
  ballColor: 0xff4444, // Red
  killY: -50, // Safely below any generated terrain height
};

export class BallManager implements PhysicsStepListener {
  private balls: Ball[] = [];
  private world: RAPIER.World;
  private scene: THREE.Scene;
  private material: CurvedStandardMaterial;
  private geometry: THREE.SphereGeometry;
  private config: Required<BallManagerConfig>;
  private heightSampler: HeightSampler | null;

  constructor(
    world: RAPIER.World,
    scene: THREE.Scene,
    config?: BallManagerConfig,
    heightSampler?: HeightSampler
  ) {
    this.world = world;
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.heightSampler = heightSampler ?? null;

    // Shared geometry for all balls (16 segments for decent sphere)
    this.geometry = new THREE.SphereGeometry(this.config.ballRadius, 16, 16);

    // Shared material with curvature support (matches terrain curvature)
    this.material = new CurvedStandardMaterial({
      color: this.config.ballColor,
      roughness: 0.4,
      metalness: 0.6,
      planetRadius: DEFAULT_PLANET_RADIUS,
      enableCurvature: true,
    });
  }

  /**
   * Shoot a ball from the camera position in the camera's look direction.
   */
  shootBall(camera: THREE.Camera): void {
    // Get camera forward direction
    const forward = new THREE.Vector3(0, 0, -1);
    forward.applyQuaternion(camera.quaternion);

    // Spawn position: slightly in front of camera to avoid spawning inside it
    const spawnOffset = 2.0; // meters
    const spawnPos = camera.position.clone().add(
      forward.clone().multiplyScalar(spawnOffset)
    );

    // Clamp spawn height so the ball never starts beneath the terrain
    // surface (it would fall through the thin heightfield collider)
    const terrainHeight = this.heightSampler
      ? this.heightSampler(spawnPos.x, spawnPos.z)
      : null;
    spawnPos.y = clampSpawnY(spawnPos.y, terrainHeight, this.config.ballRadius);

    // Initial velocity: forward direction * shoot speed
    const velocity = forward.clone().multiplyScalar(this.config.shootSpeed);

    // Create Rapier rigid body
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnPos.x, spawnPos.y, spawnPos.z)
      .setLinvel(velocity.x, velocity.y, velocity.z);

    const rigidBody = this.world.createRigidBody(bodyDesc);

    // Create sphere collider attached to the rigid body
    const colliderDesc = RAPIER.ColliderDesc.ball(this.config.ballRadius)
      .setRestitution(this.config.restitution)
      .setFriction(this.config.friction);

    this.world.createCollider(colliderDesc, rigidBody);

    // Create Three.js mesh
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.position.copy(spawnPos);
    this.scene.add(mesh);

    // Track the ball; both snapshots start at the spawn transform so the
    // first interpolated frame renders the ball exactly where it spawned
    this.balls.push({
      rigidBody,
      mesh,
      prevTransform: createSnapshot(spawnPos.x, spawnPos.y, spawnPos.z),
      currTransform: createSnapshot(spawnPos.x, spawnPos.y, spawnPos.z),
    });

    // Remove oldest ball if we're over the limit
    if (this.balls.length > this.config.maxBalls) {
      this.removeBall(0);
    }
  }

  /**
   * Drop a ball at a specific world position (for testing).
   */
  dropBallAt(x: number, y: number, z: number): void {
    // Create Rapier rigid body at position, no initial velocity
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinvel(0, 0, 0);

    const rigidBody = this.world.createRigidBody(bodyDesc);

    // Create sphere collider
    const colliderDesc = RAPIER.ColliderDesc.ball(this.config.ballRadius)
      .setRestitution(this.config.restitution)
      .setFriction(this.config.friction);

    this.world.createCollider(colliderDesc, rigidBody);

    // Create Three.js mesh
    const mesh = new THREE.Mesh(this.geometry, this.material);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);

    // Track the ball; both snapshots start at the drop transform
    this.balls.push({
      rigidBody,
      mesh,
      prevTransform: createSnapshot(x, y, z),
      currTransform: createSnapshot(x, y, z),
    });

    // Remove oldest ball if over limit
    if (this.balls.length > this.config.maxBalls) {
      this.removeBall(0);
    }
  }

  /**
   * Capture each ball's physics transform as the interpolation start point.
   * Must be called immediately before every fixed physics step, so that
   * prevTransform holds the state before the step and the physics body
   * itself holds the state after it.
   */
  beforePhysicsStep(_dtFixed: number): void {
    for (const ball of this.balls) {
      copyBodyTransform(ball.rigidBody, ball.prevTransform);
    }
  }

  /**
   * Update all ball meshes from their physics bodies, interpolating between
   * the pre-step and post-step transforms by alpha (the fixed-timestep
   * accumulator's leftover fraction in [0, 1)). This keeps ball motion
   * smooth on displays refreshing faster than the physics step rate.
   *
   * Note: Physics positions are in flat world space, but meshes use
   * CurvedStandardMaterial which applies curvature in the vertex shader,
   * so balls will visually match the curved terrain.
   *
   * Balls that fall below the kill altitude (e.g. after leaving the
   * terrain-collider window around the camera) are despawned so they cannot
   * keep the simulation "moving" forever and defeat render-on-demand.
   * Despawning is decided on the true physics position, never the
   * interpolated one.
   *
   * @param alpha Interpolation fraction between the previous and current
   *              physics transforms (defaults to 1 = current transform)
   * @returns true if any balls are moving (or were just despawned and need
   *          one more render to disappear), false otherwise
   */
  afterPhysicsSync(alpha: number = 1): boolean {
    if (this.balls.length === 0) return false;

    let hasMovingBalls = false;
    let despawnedBalls = false;

    // Iterate backwards so despawning (splice) doesn't skip elements
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const ball = this.balls[i];

      // Get position from physics body (flat world space)
      const pos = ball.rigidBody.translation();

      // Despawn balls that fell below the kill altitude (nothing can
      // catch them anymore — they would fall forever)
      if (shouldDespawnBall(pos, this.config.killY)) {
        this.removeBall(i);
        despawnedBalls = true;
        continue;
      }

      // Refresh the interpolation end point from the physics body, then
      // place the mesh between the pre- and post-step transforms
      copyBodyTransform(ball.rigidBody, ball.currTransform);
      const t = interpolateTransform(ball.prevTransform, ball.currTransform, alpha);
      ball.mesh.position.set(t.position.x, t.position.y, t.position.z);
      ball.mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);

      // Check if ball is moving (linear or angular velocity above threshold)
      if (isBallMoving(ball.rigidBody.linvel(), ball.rigidBody.angvel())) {
        hasMovingBalls = true;
      }
    }

    // A despawn needs one more render so the removed mesh disappears
    return hasMovingBalls || despawnedBalls;
  }

  /**
   * Remove a ball at the specified index.
   */
  private removeBall(index: number): void {
    const ball = this.balls[index];
    if (!ball) return;

    // Remove from physics world
    this.world.removeRigidBody(ball.rigidBody);

    // Remove from scene
    this.scene.remove(ball.mesh);

    // Remove from tracking array
    this.balls.splice(index, 1);
  }

  /**
   * Remove all balls.
   */
  removeAllBalls(): void {
    while (this.balls.length > 0) {
      this.removeBall(this.balls.length - 1);
    }
  }

  /**
   * Get the current number of balls.
   */
  getBallCount(): number {
    return this.balls.length;
  }

  /**
   * Set the ball color (affects future balls only due to material sharing).
   */
  setBallColor(color: number): void {
    this.material.color.setHex(color);
  }

  /**
   * Enable or disable curvature on ball material.
   */
  setEnableCurvature(enable: boolean): void {
    this.material.enableCurvature = enable;
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.removeAllBalls();
    this.geometry.dispose();
    this.material.dispose();
  }
}
