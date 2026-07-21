import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BallManager } from './BallManager';

/**
 * Integration tests using the real Rapier WASM module and a real Three.js
 * scene (no rendering). The physics world uses lunar gravity like production.
 */
describe(BallManager.name, () => {
  let world: RAPIER.World;
  let scene: THREE.Scene;

  beforeAll(async () => {
    await RAPIER.init();
  });

  beforeEach(() => {
    world = new RAPIER.World({ x: 0, y: -1.62, z: 0 });
    scene = new THREE.Scene();
  });

  afterEach(() => {
    world.free();
  });

  function makeCamera(): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
    camera.position.set(0, 50, 0);
    return camera;
  }

  /** The single ball mesh in the scene (throws when absent). */
  function getBallMesh(): THREE.Mesh {
    const mesh = scene.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh);
    if (!mesh) {
      throw new Error('expected a ball mesh in the scene');
    }
    return mesh;
  }

  it('dropBallAt creates a rigid body and a mesh in the scene', () => {
    const manager = new BallManager(world, scene);

    manager.dropBallAt(1, 20, 3);

    expect(manager.getBallCount()).toBe(1);
    expect(world.bodies.len()).toBe(1);
    const mesh = getBallMesh();
    expect(mesh.position.x).toBe(1);
    expect(mesh.position.y).toBe(20);
    expect(mesh.position.z).toBe(3);
    manager.dispose();
  });

  it('shootBall spawns in front of the camera with forward velocity', () => {
    const manager = new BallManager(world, scene, { shootSpeed: 20 });
    const camera = makeCamera(); // default orientation looks down -Z

    manager.shootBall(camera);

    expect(manager.getBallCount()).toBe(1);
    const body = world.bodies.getAll()[0];
    // Spawn offset is 2 m along the look direction
    expect(body.translation().z).toBeCloseTo(camera.position.z - 2, 5);
    expect(body.linvel().z).toBeCloseTo(-20, 5);
    expect(body.linvel().x).toBeCloseTo(0, 5);
    manager.dispose();
  });

  it('shootBall clamps the spawn height above the terrain surface', () => {
    const terrainHeight = 60; // above the camera at y=50
    const manager = new BallManager(
      world,
      scene,
      { ballRadius: 0.3 },
      () => terrainHeight
    );
    const camera = makeCamera();

    manager.shootBall(camera);

    const body = world.bodies.getAll()[0];
    expect(body.translation().y).toBeCloseTo(terrainHeight + 0.3, 5);
    manager.dispose();
  });

  it('evicts the oldest ball when maxBalls is exceeded', () => {
    const manager = new BallManager(world, scene, { maxBalls: 3 });

    manager.dropBallAt(0, 10, 0);
    manager.dropBallAt(1, 10, 0);
    manager.dropBallAt(2, 10, 0);
    manager.dropBallAt(3, 10, 0);

    expect(manager.getBallCount()).toBe(3);
    expect(world.bodies.len()).toBe(3);
    // The oldest ball (x=0) is gone; the newest three remain
    const xs = scene.children
      .filter((c): c is THREE.Mesh => c instanceof THREE.Mesh)
      .map((m) => m.position.x)
      .sort((a, b) => a - b);
    expect(xs).toEqual([1, 2, 3]);
    manager.dispose();
  });

  it('update syncs meshes to falling bodies and reports movement', () => {
    const manager = new BallManager(world, scene);
    manager.dropBallAt(0, 100, 0);

    // Let the ball fall for a while
    manager.beforePhysicsStep(1 / 60);
    for (let i = 0; i < 30; i++) {
      world.step();
    }

    const moving = manager.afterPhysicsSync(1);

    expect(moving).toBe(true);
    const mesh = getBallMesh();
    expect(mesh.position.y).toBeLessThan(100);
    // Mesh matches the physics body at alpha = 1
    const body = world.bodies.getAll()[0];
    expect(mesh.position.y).toBeCloseTo(body.translation().y, 5);
    manager.dispose();
  });

  it('interpolates the mesh between pre- and post-step transforms by alpha', () => {
    const manager = new BallManager(world, scene);
    manager.dropBallAt(0, 100, 0);

    manager.beforePhysicsStep(1 / 60); // prev = spawn transform (y = 100)
    world.step(); // curr = one step of free fall

    const body = world.bodies.getAll()[0];
    const yAfterStep = body.translation().y;
    expect(yAfterStep).toBeLessThan(100);

    const mesh = getBallMesh();

    manager.afterPhysicsSync(0);
    expect(mesh.position.y).toBeCloseTo(100, 5);

    manager.afterPhysicsSync(0.5);
    expect(mesh.position.y).toBeCloseTo((100 + yAfterStep) / 2, 5);

    manager.afterPhysicsSync(1);
    expect(mesh.position.y).toBeCloseTo(yAfterStep, 5);
    manager.dispose();
  });

  it('despawns balls below the kill altitude and requests one final render', () => {
    const manager = new BallManager(world, scene, { killY: -50 });
    manager.dropBallAt(0, -100, 0); // already below the kill altitude

    // Despawn frame: returns true so the removed mesh gets rendered away
    expect(manager.afterPhysicsSync(1)).toBe(true);
    expect(manager.getBallCount()).toBe(0);
    expect(world.bodies.len()).toBe(0);
    expect(scene.children.some((c) => c instanceof THREE.Mesh)).toBe(false);

    // With no balls left, the manager reports idle
    expect(manager.afterPhysicsSync(1)).toBe(false);
    manager.dispose();
  });

  it('a ball resting on a collider comes to rest and reports idle', () => {
    // Static ground plane (cuboid) under the ball
    const groundBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.1, 50), groundBody);

    const manager = new BallManager(world, scene, {
      ballRadius: 0.3,
      restitution: 0,
    });
    manager.dropBallAt(0, 1, 0);

    // Settle: a couple of seconds of fixed steps
    let moving = true;
    for (let i = 0; i < 240; i++) {
      manager.beforePhysicsStep(1 / 60);
      world.step();
      moving = manager.afterPhysicsSync(1);
    }

    expect(moving).toBe(false);
    const body = world.bodies.getAll().find((b) => b.isDynamic());
    if (!body) {
      throw new Error('expected a dynamic ball body');
    }
    // Resting on top of the 0.1-half-height ground: y ~ 0.1 + radius
    expect(body.translation().y).toBeCloseTo(0.4, 1);
    manager.dispose();
  });

  it('removeAllBalls clears bodies, meshes, and count', () => {
    const manager = new BallManager(world, scene);
    manager.dropBallAt(0, 10, 0);
    manager.dropBallAt(1, 10, 0);

    manager.removeAllBalls();

    expect(manager.getBallCount()).toBe(0);
    expect(world.bodies.len()).toBe(0);
    expect(scene.children.some((c) => c instanceof THREE.Mesh)).toBe(false);
    manager.dispose();
  });
});
