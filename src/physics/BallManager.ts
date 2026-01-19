/**
 * BallManager - Manages bouncing balls in the physics simulation
 * 
 * Handles:
 * - Shooting balls from camera position
 * - Syncing Three.js meshes with Rapier rigid bodies
 * - Cleaning up old balls when limit is exceeded
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CurvedStandardMaterial } from '../shaders/CurvedStandardMaterial';

interface Ball {
  rigidBody: RAPIER.RigidBody;
  mesh: THREE.Mesh;
}

export interface BallManagerConfig {
  ballRadius?: number;
  shootSpeed?: number;
  maxBalls?: number;
  restitution?: number;
  friction?: number;
  ballColor?: number;
}

const DEFAULT_CONFIG: Required<BallManagerConfig> = {
  ballRadius: 0.3,
  shootSpeed: 20,
  maxBalls: 100,
  restitution: 0.7,
  friction: 0.3,
  ballColor: 0xff4444, // Red
};

export class BallManager {
  private balls: Ball[] = [];
  private world: RAPIER.World;
  private scene: THREE.Scene;
  private material: CurvedStandardMaterial;
  private geometry: THREE.SphereGeometry;
  private config: Required<BallManagerConfig>;
  private physicsWorld: unknown = null; // PhysicsWorld instance for heightfield queries

  constructor(
    world: RAPIER.World,
    scene: THREE.Scene,
    config?: BallManagerConfig
  ) {
    this.world = world;
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Shared geometry for all balls (16 segments for decent sphere)
    this.geometry = new THREE.SphereGeometry(this.config.ballRadius, 16, 16);

    // Shared material with curvature support
    this.material = new CurvedStandardMaterial({
      color: this.config.ballColor,
      roughness: 0.4,
      metalness: 0.6,
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

    // Track the ball
    this.balls.push({ rigidBody, mesh });

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

    // Track the ball
    this.balls.push({ rigidBody, mesh });

    // Remove oldest ball if over limit
    if (this.balls.length > this.config.maxBalls) {
      this.removeBall(0);
    }
  }

  /**
   * Set PhysicsWorld instance for heightfield queries (debugging).
   */
  setPhysicsWorld(pw: unknown): void {
    this.physicsWorld = pw;
  }

  /**
   * Update all ball meshes to match their physics body positions.
   * Should be called after physics step.
   * 
   * @returns true if there are any balls (scene needs re-render)
   */
  update(): boolean {
    if (this.balls.length === 0) return false;
    
    for (const ball of this.balls) {
      // Get position from physics body
      const pos = ball.rigidBody.translation();
      const vel = ball.rigidBody.linvel();
      ball.mesh.position.set(pos.x, pos.y, pos.z);

      // Get rotation from physics body
      const rot = ball.rigidBody.rotation();
      ball.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
      
      // #region agent log
      // Detect when ball is falling through terrain (Y velocity negative, but Y position is below expected terrain)
      if (vel.y < -1 && this.physicsWorld) {
        const hfQuery = this.physicsWorld.queryHeightfieldHeight(pos.x, pos.z);
        if (hfQuery.height !== null) {
          const expectedTerrainY = hfQuery.height;
          const ballBottomY = pos.y - this.config.ballRadius;
          const depthBelowTerrain = expectedTerrainY - ballBottomY;
          
          // Log if ball is significantly below terrain
          if (depthBelowTerrain > 0.5) {
            fetch('http://127.0.0.1:7248/ingest/2514d39a-3d94-4487-980a-5421d6b147c9',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'BallManager.ts:update',message:'BALL BELOW TERRAIN',data:{ballPos:[pos.x.toFixed(2),pos.y.toFixed(2),pos.z.toFixed(2)],velY:vel.y.toFixed(2),expectedTerrainY:expectedTerrainY.toFixed(2),ballBottomY:ballBottomY.toFixed(2),depthBelowTerrain:depthBelowTerrain.toFixed(2),gridKey:hfQuery.gridKey,sampleInfo:hfQuery.sampleInfo},timestamp:Date.now(),sessionId:'debug-session',runId:'below-terrain',hypothesisId:'BELOW'})}).catch(()=>{});
          }
        }
      }
      // #endregion
    }
    
    return true;
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
