import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { LanderBody, type LanderStepSample } from './LanderBody';
import { LanderControls } from './LanderControls';
import { LANDER_CONFIG } from './config';
import type { InputManager } from '../core/InputManager';

/**
 * Integration tests against real Rapier: the assisted lander must hover,
 * auto-level, land softly on legs, and report honest contact samples.
 */

const DT = 1 / 60;

/** Minimal InputManager stub with directly controllable key state. */
function makeInputStub() {
  const keys = new Set<string>();
  const justPressed = new Set<string>();
  const stub = {
    isKeyPressed: (k: string) => keys.has(k.toLowerCase()),
    isKeyJustPressed: (k: string) => justPressed.has(k.toLowerCase()),
  } as unknown as InputManager;
  return { stub, keys, justPressed };
}

function makeWorld(withGround: boolean, groundY = 0) {
  const world = new RAPIER.World({ x: 0, y: -1.62, z: 0 });
  if (withGround) {
    const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(500, 1, 500).setTranslation(0, groundY - 1, 0),
      groundBody
    );
  }
  return world;
}

function makeLander(world: RAPIER.World, spawnY: number) {
  const { stub, keys } = makeInputStub();
  const controls = new LanderControls(stub);
  const body = new LanderBody(world, controls);
  body.spawn({
    position: new THREE.Vector3(0, spawnY, 0),
    yawHeading: 0,
    velocity: new THREE.Vector3(0, 0, 0),
    fuelCapacityKg: LANDER_CONFIG.fuelMass,
  });
  return { body, controls, keys };
}

function step(world: RAPIER.World, body: LanderBody, steps: number) {
  for (let i = 0; i < steps; i++) {
    body.beforePhysicsStep(DT);
    world.step();
  }
  body.afterPhysicsSync(1);
}

describe(LanderBody.name, () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it('stays frozen (kinematic) until launch', () => {
    const world = makeWorld(false);
    const { body } = makeLander(world, 100);
    step(world, body, 60);
    expect(body.rig.position.y).toBeCloseTo(100, 5);

    body.launch();
    step(world, body, 60);
    expect(body.rig.position.y).toBeLessThan(100); // now falling
    body.dispose();
  });

  it('free-falls at lunar gravity with throttle at zero', () => {
    const world = makeWorld(false);
    const { body } = makeLander(world, 200);
    body.launch();
    step(world, body, 60); // 1 s
    const vel = body.getVelocity(new THREE.Vector3());
    expect(vel.y).toBeCloseTo(-1.62, 1);
    body.dispose();
  });

  it('full throttle overcomes gravity (TWR > 1) and burns fuel', () => {
    const world = makeWorld(false);
    const { body, keys } = makeLander(world, 100);
    body.launch();
    keys.add(' '); // full-thrust punch
    step(world, body, 120); // 2 s
    const vel = body.getVelocity(new THREE.Vector3());
    expect(vel.y).toBeGreaterThan(0); // climbing
    expect(body.getEngine().getFuelFraction()).toBeLessThan(1);
    body.dispose();
  });

  it('auto-levels: spawns stay upright under gravity with no input', () => {
    const world = makeWorld(false);
    const { body } = makeLander(world, 300);
    body.launch();
    step(world, body, 300); // 5 s of falling
    expect(body.getTiltDeg()).toBeLessThan(2);
    body.dispose();
  });

  it('tilts toward the commanded angle while W is held, then re-levels', () => {
    const world = makeWorld(false);
    const { body, keys } = makeLander(world, 500);
    body.launch();
    keys.add('w');
    step(world, body, 120);
    const maxTiltDeg = (LANDER_CONFIG.maxTiltRad * 180) / Math.PI;
    expect(body.getTiltDeg()).toBeGreaterThan(maxTiltDeg - 4);
    expect(body.getTiltDeg()).toBeLessThan(maxTiltDeg + 3);
    keys.delete('w');
    step(world, body, 240);
    expect(body.getTiltDeg()).toBeLessThan(2);
    body.dispose();
  });

  it('lands on its legs on flat ground and reports leg contacts, not body contact', () => {
    const world = makeWorld(true);
    const { body } = makeLander(world, LANDER_CONFIG.gearHeight + 3);
    let sawLegContact = false;
    let sawBodyContact = false;
    body.setOnStep((s: LanderStepSample) => {
      if (s.legContactCount > 0) sawLegContact = true;
      if (s.bodyContact) sawBodyContact = true;
    });
    body.launch();
    step(world, body, 600); // 10 s: drop ~3 m and settle
    expect(sawLegContact).toBe(true);
    expect(sawBodyContact).toBe(false);
    expect(body.getTiltDeg()).toBeLessThan(3);
    // Resting near gear height above the ground plane
    expect(body.rig.position.y).toBeCloseTo(LANDER_CONFIG.gearHeight, 0);
    // At rest → afterPhysicsSync reports not moving
    expect(body.afterPhysicsSync(1)).toBe(false);
    body.dispose();
  });

  it('radar altitude reflects distance to ground minus gear height', () => {
    const world = makeWorld(true);
    const { body } = makeLander(world, 50);
    step(world, body, 1);
    const agl = body.raycastAltitudeAGL();
    expect(agl).not.toBeNull();
    expect(agl as number).toBeCloseTo(50 - LANDER_CONFIG.gearHeight, 0);
    body.dispose();
  });

  it('returns null altitude with no colliders below (spawn-safety gate)', () => {
    const world = makeWorld(false);
    const { body } = makeLander(world, 50);
    step(world, body, 1);
    expect(body.raycastAltitudeAGL()).toBeNull();
    body.dispose();
  });

  it('hover throttle sits near 1/TWR at full mass', () => {
    const world = makeWorld(false);
    const { body } = makeLander(world, 100);
    expect(body.getHoverThrottle()).toBeCloseTo(1 / 2.2, 1);
    body.dispose();
  });
});
