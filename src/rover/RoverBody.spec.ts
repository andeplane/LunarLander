import RAPIER from '@dimforge/rapier3d-compat';
import { Vector3 } from 'three';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { castEnvironmentRay, REST_LENGTH, RoverBody } from './RoverBody';

describe('Apollo rover dynamics', () => {
  let world: RAPIER.World;
  let rover: RoverBody;
  beforeAll(async () => {
    await RAPIER.init();
  });
  beforeEach(() => {
    world = new RAPIER.World({ x: 0, y: -1.62, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.cuboid(100, 0.2, 100).setTranslation(0, -0.2, 0));
    rover = new RoverBody(world, new Vector3(0, 0.71, 0));
  });
  afterEach(() => {
    rover.dispose();
    world.free();
  });
  function advance(seconds: number) {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      rover.beforePhysicsStep(1 / 60);
      world.step();
      rover.afterPhysicsSync(1);
    }
  }
  it('rests on four compressed springs, accelerates forwards, brakes and reverses', () => {
    advance(3);
    expect(rover.grounded).toBe(4);
    expect(rover.lengths[0]).toBeLessThan(REST_LENGTH);
    rover.throttle = 1;
    advance(12);
    expect(rover.position.z).toBeLessThan(-14);
    expect(rover.speed).toBeGreaterThan(3);
    expect(rover.speed).toBeLessThan(4.1);
    expect(rover.spins[0]).toBeLessThan(0);
    rover.throttle = 0;
    rover.brake = true;
    advance(5);
    expect(Math.abs(rover.speed)).toBeLessThan(0.08);
    rover.brake = false;
    rover.throttle = -1;
    advance(5);
    expect(rover.speed).toBeLessThan(-1);
  });
  it('turns left with opposite rear steering and articulates over a step', () => {
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.23, 0.065, 0.55).setTranslation(-0.915, 0.065, -1.15)
    );
    advance(3);
    expect(Math.abs(rover.lengths[0] - rover.lengths[1])).toBeGreaterThan(0.025);
    rover.throttle = 1;
    rover.steer = 1;
    advance(4);
    expect(rover.angles[0] * rover.angles[2]).toBeLessThan(0);
    expect(rover.position.x).toBeLessThan(-0.2);
  });
  it('lets the chase camera see through the cargo rack to the first obstacle behind it', () => {
    advance(2);
    const origin = rover.position.clone();
    origin.y += 0.46;
    const ray = new RAPIER.Ray(origin, { x: 0, y: 0, z: 1 });
    const rock = world.createCollider(
      RAPIER.ColliderDesc.ball(0.5).setTranslation(origin.x, origin.y, origin.z + 4)
    );
    world.updateSceneQueries();
    const hit = castEnvironmentRay(world, ray, 8, rover);
    expect(hit?.collider.handle).toBe(rock.handle);
    expect(hit?.toi).toBeCloseTo(3.5);
  });

  it('falls at lunar gravity without gaining traction in flight', () => {
    rover.reset(new Vector3(0, 10, 0));
    rover.throttle = 1;
    rover.steer = 1;
    advance(1);
    expect(rover.grounded).toBe(0);
    expect(rover.chassis.linvel().y).toBeCloseTo(-1.62, 2);
    expect(rover.position.z).toBeCloseTo(0, 4);
    expect(rover.rotation.w).toBeCloseTo(1, 4);
  });
});
