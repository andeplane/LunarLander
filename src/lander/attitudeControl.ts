/**
 * Drone-style "angle mode" attitude controller (ADR-0002 §1).
 *
 * The player commands a target tilt (pitch/roll relative to local vertical,
 * clamped) and a yaw rate. A critically-damped PD loop computes the angular
 * acceleration needed to track the target attitude; releasing input
 * auto-levels the craft. Yaw is fully decoupled from pitch/roll.
 *
 * Pure math — no Rapier types. The caller converts the returned world-frame
 * angular acceleration into a torque impulse via the body's inertia.
 */
import { Euler, Quaternion, Vector3 } from 'three';
import { LANDER_CONFIG } from './config';

export interface AttitudeCommand {
  /** Roll input -1..1 (positive = tilt right) */
  tiltX: number;
  /** Pitch input -1..1 (positive = tilt forward) */
  tiltY: number;
  /** Yaw rate input -1..1 (positive = turn left / CCW seen from above) */
  yaw: number;
}

export interface AttitudeResponse {
  /** Desired world-frame angular acceleration (rad/s²) */
  angularAcceleration: Vector3;
  /** The (slew-limited) target attitude being tracked */
  targetQuaternion: Quaternion;
}

/** Clamp helper */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Move `current` toward `target` by at most `maxDelta` (rate limiting). */
export function moveToward(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

export class AttitudeController {
  /** Commanded (slew-limited) tilt angles, radians */
  private commandedPitch = 0;
  private commandedRoll = 0;
  /** Integrated yaw heading, radians */
  private yawHeading = 0;

  // Reusable objects (no per-step allocation)
  private readonly targetQuat = new Quaternion();
  private readonly targetEuler = new Euler(0, 0, 0, 'YXZ');
  private readonly errorQuat = new Quaternion();
  private readonly invCurrent = new Quaternion();
  private readonly errorAxis = new Vector3();
  private readonly response: AttitudeResponse = {
    angularAcceleration: new Vector3(),
    targetQuaternion: this.targetQuat,
  };

  /**
   * Reset controller state (mission start). Seeds the yaw heading and
   * zeroes commanded tilt.
   */
  reset(yawHeading: number): void {
    this.yawHeading = yawHeading;
    this.commandedPitch = 0;
    this.commandedRoll = 0;
  }

  getYawHeading(): number {
    return this.yawHeading;
  }

  /**
   * Advance one fixed step.
   *
   * @param dt fixed step size (s)
   * @param cmd player input
   * @param currentQuaternion body orientation (world)
   * @param angularVelocity body angular velocity (world, rad/s)
   * @returns desired world-frame angular acceleration + target attitude.
   *          The returned objects are reused across calls — consume, don't
   *          store.
   */
  update(
    dt: number,
    cmd: AttitudeCommand,
    currentQuaternion: Quaternion,
    angularVelocity: Vector3
  ): AttitudeResponse {
    const cfg = LANDER_CONFIG;

    // 1. Integrate yaw heading from the rate command (decoupled, rate-limited)
    this.yawHeading += clamp(cmd.yaw, -1, 1) * cfg.yawRate * dt;

    // 2. Slew commanded tilt toward the input target (clamped to max tilt).
    //    Zero input → target zero → auto-level, via the same path.
    const targetPitch = clamp(cmd.tiltY, -1, 1) * cfg.maxTiltRad;
    const targetRoll = clamp(cmd.tiltX, -1, 1) * cfg.maxTiltRad;
    const maxDelta = cfg.tiltSlewRate * dt;
    this.commandedPitch = moveToward(this.commandedPitch, targetPitch, maxDelta);
    this.commandedRoll = moveToward(this.commandedRoll, targetRoll, maxDelta);

    // 3. Build the target attitude: yaw around world up, then pitch, then
    //    roll (YXZ, same convention as the rest of the codebase).
    //    Positive tiltY = tilt forward = nose down = negative X rotation in
    //    three.js (forward is -Z); positive tiltX = tilt right = negative Z.
    this.targetEuler.set(-this.commandedPitch, this.yawHeading, -this.commandedRoll);
    this.targetQuat.setFromEuler(this.targetEuler);

    // 4. Attitude error as a world-frame rotation vector (axis × angle):
    //    q_err = q_target · q_current⁻¹  (rotation that takes current → target)
    this.invCurrent.copy(currentQuaternion).invert();
    this.errorQuat.copy(this.targetQuat).multiply(this.invCurrent);
    // Shortest path: a quaternion and its negation are the same rotation
    if (this.errorQuat.w < 0) {
      this.errorQuat.set(-this.errorQuat.x, -this.errorQuat.y, -this.errorQuat.z, -this.errorQuat.w);
    }
    // Convert to rotation vector. For angle θ around axis n:
    // q = (n sin(θ/2), cos(θ/2)) → e = n·θ
    const sinHalf = Math.sqrt(
      this.errorQuat.x * this.errorQuat.x +
      this.errorQuat.y * this.errorQuat.y +
      this.errorQuat.z * this.errorQuat.z
    );
    if (sinHalf > 1e-8) {
      const angle = 2 * Math.atan2(sinHalf, this.errorQuat.w);
      this.errorAxis
        .set(this.errorQuat.x, this.errorQuat.y, this.errorQuat.z)
        .multiplyScalar(angle / sinHalf);
    } else {
      this.errorAxis.set(0, 0, 0);
    }

    // 5. Critically-damped PD law: α = ω_n²·e − 2ζω_n·ω
    const wn = cfg.attitudeOmega;
    const zeta = cfg.attitudeZeta;
    this.response.angularAcceleration
      .copy(this.errorAxis)
      .multiplyScalar(wn * wn)
      .addScaledVector(angularVelocity, -2 * zeta * wn);

    return this.response;
  }
}
