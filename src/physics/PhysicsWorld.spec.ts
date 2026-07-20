import { describe, it, expect, vi } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { PhysicsWorld } from './PhysicsWorld';
import type { BallManager } from './BallManager';

/**
 * Integration tests against the real Rapier WASM module, which initializes
 * fine under node (rapier3d-compat embeds the WASM binary).
 */
describe(PhysicsWorld.name, () => {
  const STEP = 1 / 60;

  function makeBallManagerStub(updateReturns: boolean | boolean[] = false) {
    const returns = Array.isArray(updateReturns) ? [...updateReturns] : null;
    const update = vi.fn((_alpha?: number) => {
      if (returns) {
        return returns.length > 1 ? (returns.shift() ?? false) : returns[0];
      }
      return updateReturns as boolean;
    });
    const beforePhysicsStep = vi.fn();
    return {
      stub: { update, beforePhysicsStep } as unknown as BallManager,
      update,
      beforePhysicsStep,
    };
  }

  it('throws when getWorld is called before initialization', () => {
    const physics = new PhysicsWorld();
    expect(physics.isReady()).toBe(false);
    expect(() => physics.getWorld()).toThrow(/not initialized/i);
  });

  it('initializes with lunar gravity and becomes ready', async () => {
    const physics = new PhysicsWorld();
    await physics.initialize();

    expect(physics.isReady()).toBe(true);
    expect(physics.getWorld().gravity.y).toBeCloseTo(-1.62, 10);
    expect(physics.getWorld().gravity.x).toBe(0);
    expect(physics.getWorld().gravity.z).toBe(0);

    physics.dispose();
  });

  it('is safe to initialize twice (keeps the same world)', async () => {
    const physics = new PhysicsWorld();
    await physics.initialize();
    const world = physics.getWorld();

    await physics.initialize();
    expect(physics.getWorld()).toBe(world);

    physics.dispose();
  });

  it('step is a no-op before initialization', () => {
    const physics = new PhysicsWorld();
    expect(physics.step(STEP)).toBe(false);
  });

  it('a free-falling body accelerates at lunar gravity through step()', async () => {
    const physics = new PhysicsWorld();
    await physics.initialize();
    const world = physics.getWorld();

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 100, 0)
    );
    world.createCollider(RAPIER.ColliderDesc.ball(0.3), body);

    // Simulate one second of frame-rate-driven stepping
    for (let i = 0; i < 60; i++) {
      physics.step(STEP);
    }

    // v = g * t = -1.62 m/s after 1 s
    expect(body.linvel().y).toBeCloseTo(-1.62, 2);
    expect(body.translation().y).toBeLessThan(100);

    physics.dispose();
  });

  it('runs fixed steps from accumulated frame time and notifies the ball manager before each', async () => {
    const physics = new PhysicsWorld();
    await physics.initialize();
    const { stub, update, beforePhysicsStep } = makeBallManagerStub(false);
    physics.setBallManager(stub);

    // Half a fixed step: no physics step yet
    physics.step(STEP / 2);
    expect(beforePhysicsStep).not.toHaveBeenCalled();

    // Second half completes the accumulator: exactly one step
    physics.step(STEP / 2);
    expect(beforePhysicsStep).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);

    // A large frame delta is capped at maxStepsPerFrame (5) catch-up steps
    beforePhysicsStep.mockClear();
    physics.step(10);
    expect(beforePhysicsStep).toHaveBeenCalledTimes(5);

    physics.dispose();
  });

  it('returns the ball manager movement flag and caches it across zero-step frames', async () => {
    const physics = new PhysicsWorld();
    await physics.initialize();
    const { stub, update } = makeBallManagerStub(true);
    physics.setBallManager(stub);

    // Full step: balls report moving
    expect(physics.step(STEP)).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);

    // Sub-step frame (display faster than physics rate): no fixed step runs,
    // but the cached moving flag is returned and meshes are re-interpolated
    expect(physics.step(STEP / 4)).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    // The re-interpolation call uses the grown alpha, not a full step
    const alpha = update.mock.calls[1][0] as number;
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);

    physics.dispose();
  });

  it('reports not moving once the ball manager goes idle after a step', async () => {
    const physics = new PhysicsWorld();
    await physics.initialize();
    const { stub } = makeBallManagerStub([true, false]);
    physics.setBallManager(stub);

    expect(physics.step(STEP)).toBe(true);
    expect(physics.step(STEP)).toBe(false);
    // Idle state also caches across zero-step frames
    expect(physics.step(STEP / 4)).toBe(false);

    physics.dispose();
  });

  it('dispose frees the world and resets state', async () => {
    const physics = new PhysicsWorld();
    await physics.initialize();

    physics.dispose();

    expect(physics.isReady()).toBe(false);
    expect(() => physics.getWorld()).toThrow();
    expect(physics.step(STEP)).toBe(false);
  });
});
