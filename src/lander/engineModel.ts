/**
 * Main-engine throttle, fuel, and hover-hold model (ADR-0002 §2/§3).
 * Pure math — stepped on the fixed physics timestep by LanderBody.
 */
import { LANDER_CONFIG } from './config';

export interface EngineInput {
  /** Held throttle keys: +1 up, -1 down, 0 none */
  throttleHeld: number;
  /** Absolute lever position from the touch slider, or null if untouched */
  throttleAbsolute: number | null;
  /** Space held: full thrust while held (lever unchanged underneath) */
  fullThrust: boolean;
  /** One-shot: cut lever to zero this step */
  cut: boolean;
}

export interface EngineStepResult {
  /** Thrust force along the lander's local up axis (N) */
  thrustN: number;
  /** Fuel consumed this step (kg) */
  burnedKg: number;
  /** Effective throttle in use (lever, or 1 during full-thrust) */
  effectiveThrottle: number;
}

/**
 * Throttle needed to hover at the given mass and tilt (cosTilt = cos of the
 * angle between local up and world up). Displayed as the HUD tick mark and
 * used by hover-hold. Clamped to [0, 1]; unreachable hover (extreme tilt or
 * mass) saturates at 1.
 */
export function hoverThrottle(massKg: number, cosTilt: number): number {
  const cfg = LANDER_CONFIG;
  const needed = (massKg * cfg.gravity) / (cfg.maxThrust * Math.max(cosTilt, 0.2));
  return Math.min(Math.max(needed, 0), 1);
}

/**
 * Hover-hold auto-throttle (ADR-0002 §2): drives vertical speed to zero.
 * A proportional term over the hover baseline; gain in (m/s)⁻¹.
 */
export function hoverHoldThrottle(
  massKg: number,
  cosTilt: number,
  verticalSpeed: number
): number {
  const HOVER_HOLD_GAIN = 0.25;
  const base = hoverThrottle(massKg, cosTilt);
  const correction = -verticalSpeed * HOVER_HOLD_GAIN; // descending → more throttle
  return Math.min(Math.max(base + correction, 0), 1);
}

export class EngineModel {
  /** Persistent throttle lever 0..1 */
  private lever = 0;
  /** Fuel remaining (kg) */
  private fuelKg: number;
  private readonly capacityKg: number;
  /** Hover-hold assist engaged */
  private hoverHold = false;
  /** Whether hover-hold has ever been engaged this mission (scoring flag) */
  private hoverHoldUsed = false;

  constructor(fuelCapacityKg: number) {
    this.capacityKg = fuelCapacityKg;
    this.fuelKg = fuelCapacityKg;
  }

  getLever(): number {
    return this.lever;
  }

  getFuelKg(): number {
    return this.fuelKg;
  }

  getFuelFraction(): number {
    return this.capacityKg > 0 ? this.fuelKg / this.capacityKg : 0;
  }

  isHoverHold(): boolean {
    return this.hoverHold;
  }

  wasHoverHoldUsed(): boolean {
    return this.hoverHoldUsed;
  }

  toggleHoverHold(): void {
    this.hoverHold = !this.hoverHold;
    if (this.hoverHold) {
      this.hoverHoldUsed = true;
    }
  }

  /**
   * Advance one fixed step.
   *
   * @param dt step size (s)
   * @param input player throttle inputs
   * @param massKg current total mass (for hover-hold)
   * @param cosTilt cos of tilt from vertical (for hover-hold)
   * @param verticalSpeed current vertical speed (m/s, negative down)
   */
  step(
    dt: number,
    input: EngineInput,
    massKg: number,
    cosTilt: number,
    verticalSpeed: number
  ): EngineStepResult {
    const cfg = LANDER_CONFIG;

    // Lever handling: cut > absolute (touch) > held keys (slew)
    if (input.cut) {
      this.lever = 0;
      this.hoverHold = false;
    } else if (input.throttleAbsolute !== null) {
      this.lever = Math.min(Math.max(input.throttleAbsolute, 0), 1);
      if (this.hoverHold) this.hoverHold = false; // manual override disengages
    } else if (input.throttleHeld !== 0) {
      this.lever = Math.min(
        Math.max(this.lever + input.throttleHeld * cfg.throttleSlewRate * dt, 0),
        1
      );
      if (this.hoverHold) this.hoverHold = false; // manual override disengages
    }

    // Effective throttle: full-thrust punch > hover-hold > lever
    let effective: number;
    if (input.fullThrust) {
      effective = 1;
    } else if (this.hoverHold) {
      effective = hoverHoldThrottle(massKg, cosTilt, verticalSpeed);
    } else {
      effective = this.lever;
    }

    // Fuel: linear burn with throttle; empty tank = engine out
    if (this.fuelKg <= 0) {
      return { thrustN: 0, burnedKg: 0, effectiveThrottle: effective };
    }
    const burn = Math.min(effective * cfg.maxBurnRate * dt, this.fuelKg);
    this.fuelKg -= burn;

    return {
      thrustN: effective * cfg.maxThrust,
      burnedKg: burn,
      effectiveThrottle: effective,
    };
  }
}
