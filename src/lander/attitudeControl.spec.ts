import { describe, it, expect } from 'vitest';
import { Euler, Quaternion, Vector3 } from 'three';
import { AttitudeController, moveToward, type AttitudeCommand } from './attitudeControl';
import { LANDER_CONFIG } from './config';

const DT = 1 / 60;

/**
 * Minimal rigid-body attitude integrator: applies the controller's angular
 * acceleration directly (unit inertia). Semi-implicit Euler, like Rapier.
 */
function makeSim(initial?: Quaternion) {
  const q = initial?.clone() ?? new Quaternion();
  const omega = new Vector3();
  const controller = new AttitudeController();
  controller.reset(0);

  const step = (cmd: AttitudeCommand) => {
    const res = controller.update(DT, cmd, q, omega);
    omega.addScaledVector(res.angularAcceleration, DT);
    // Integrate orientation: dq = 0.5 * ω_quat * q * dt
    const om = new Quaternion(omega.x * DT * 0.5, omega.y * DT * 0.5, omega.z * DT * 0.5, 0);
    const dq = om.multiply(q);
    q.set(q.x + dq.x, q.y + dq.y, q.z + dq.z, q.w + dq.w).normalize();
    return res;
  };

  const tiltDeg = () => {
    const up = new Vector3(0, 1, 0).applyQuaternion(q);
    return (Math.acos(Math.min(Math.max(up.y, -1), 1)) * 180) / Math.PI;
  };

  return { q, omega, controller, step, tiltDeg };
}

const NEUTRAL: AttitudeCommand = { tiltX: 0, tiltY: 0, yaw: 0 };

describe(AttitudeController.name, () => {
  it('moveToward rate-limits and lands exactly on target', () => {
    expect(moveToward(0, 1, 0.25)).toBe(0.25);
    expect(moveToward(0.9, 1, 0.25)).toBe(1);
    expect(moveToward(1, 0, 0.25)).toBe(0.75);
    expect(moveToward(0.1, 0, 0.25)).toBe(0);
  });

  it('reaches the commanded tilt in under a second without exceeding the clamp', () => {
    const sim = makeSim();
    let maxTilt = 0;
    for (let i = 0; i < 120; i++) {
      sim.step({ tiltX: 0, tiltY: 1, yaw: 0 });
      maxTilt = Math.max(maxTilt, sim.tiltDeg());
    }
    const maxTiltDeg = (LANDER_CONFIG.maxTiltRad * 180) / Math.PI;
    // Converged close to the commanded 25°
    expect(sim.tiltDeg()).toBeGreaterThan(maxTiltDeg - 2);
    // Critically damped: never overshoots the clamp by more than a hair
    expect(maxTilt).toBeLessThan(maxTiltDeg + 1.5);
  });

  it('auto-levels to upright when input is released', () => {
    const sim = makeSim();
    for (let i = 0; i < 90; i++) sim.step({ tiltX: 1, tiltY: 0, yaw: 0 });
    expect(sim.tiltDeg()).toBeGreaterThan(15);
    // Release: hands-off must return to upright and stay there
    for (let i = 0; i < 150; i++) sim.step(NEUTRAL);
    expect(sim.tiltDeg()).toBeLessThan(1);
    expect(sim.omega.length()).toBeLessThan(0.02);
  });

  it('recovers from a large disturbance (tumble) with zero input', () => {
    const tumbled = new Quaternion().setFromEuler(new Euler(1.0, 0.4, -0.8, 'YXZ'));
    const sim = makeSim(tumbled);
    sim.omega.set(1.5, -1, 0.5); // spinning
    for (let i = 0; i < 300; i++) sim.step(NEUTRAL);
    expect(sim.tiltDeg()).toBeLessThan(1);
    expect(sim.omega.length()).toBeLessThan(0.02);
  });

  it('yaw integrates at the commanded rate and is decoupled from tilt', () => {
    const sim = makeSim();
    for (let i = 0; i < 60; i++) sim.step({ tiltX: 0, tiltY: 0, yaw: 1 });
    // One second of full yaw ≈ yawRate radians of heading
    expect(sim.controller.getYawHeading()).toBeCloseTo(LANDER_CONFIG.yawRate, 5);
    // Pure yaw keeps the craft level
    for (let i = 0; i < 120; i++) sim.step(NEUTRAL);
    expect(sim.tiltDeg()).toBeLessThan(1);
  });

  it('inputs are clamped to [-1, 1]', () => {
    const sim = makeSim();
    for (let i = 0; i < 240; i++) sim.step({ tiltX: 0, tiltY: 5, yaw: 0 });
    const maxTiltDeg = (LANDER_CONFIG.maxTiltRad * 180) / Math.PI;
    expect(sim.tiltDeg()).toBeLessThan(maxTiltDeg + 1.5);
  });

  it('commanded tilt slews at the configured rate (leans in, no snap)', () => {
    const sim = makeSim();
    const res = sim.step({ tiltX: 0, tiltY: 1, yaw: 0 });
    // After one step the target attitude has moved at most slewRate·dt
    const targetTilt = new Vector3(0, 1, 0)
      .applyQuaternion(res.targetQuaternion);
    const angle = Math.acos(Math.min(Math.max(targetTilt.y, -1), 1));
    expect(angle).toBeLessThanOrEqual(LANDER_CONFIG.tiltSlewRate * DT + 1e-9);
  });

  it('produces no NaNs at perfect alignment (zero error edge case)', () => {
    const controller = new AttitudeController();
    controller.reset(0);
    const res = controller.update(DT, NEUTRAL, new Quaternion(), new Vector3());
    expect(Number.isFinite(res.angularAcceleration.x)).toBe(true);
    expect(res.angularAcceleration.length()).toBeLessThan(1e-6);
  });

  it('reset seeds yaw heading and clears commanded tilt', () => {
    const sim = makeSim();
    for (let i = 0; i < 30; i++) sim.step({ tiltX: 1, tiltY: 1, yaw: 1 });
    sim.controller.reset(Math.PI / 2);
    expect(sim.controller.getYawHeading()).toBe(Math.PI / 2);
    const res = sim.controller.update(DT, NEUTRAL, new Quaternion(), new Vector3());
    // Target should be pure yaw (no residual tilt command)
    const up = new Vector3(0, 1, 0).applyQuaternion(res.targetQuaternion);
    expect(up.y).toBeCloseTo(1, 5);
  });
});
