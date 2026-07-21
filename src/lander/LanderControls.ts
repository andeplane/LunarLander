/**
 * Aggregates keyboard (InputManager) and touch (LanderTouchControls, via
 * the LanderInputSink interface) into per-physics-step control inputs
 * (ADR-0002 §4).
 *
 * One-shot inputs (cut, hover toggle, camera, restart) are latched as
 * pending flags and consumed exactly once — several fixed physics steps can
 * run per render frame, and e.g. a hover toggle must not apply twice.
 */
import type { InputManager } from '../core/InputManager';
import type { LanderInputSink } from './types';
import type { AttitudeCommand } from './attitudeControl';
import type { EngineInput } from './engineModel';

export class LanderControls implements LanderInputSink {
  private inputManager: InputManager;

  // Touch-side level inputs (zero when touch idle, so keyboard composes)
  private touchTiltX = 0;
  private touchTiltY = 0;
  private touchYaw = 0;
  private touchFullThrust = false;
  /** Absolute lever position from the touch slider; consumed when applied */
  private pendingThrottleAbsolute: number | null = null;

  // Latched one-shots
  private pendingCut = false;
  private pendingHoverToggle = false;
  private pendingCameraCycle = false;
  private pendingRestart = false;

  constructor(inputManager: InputManager) {
    this.inputManager = inputManager;
  }

  // ---- LanderInputSink (touch UI) ----

  setTiltInput(x: number, y: number): void {
    this.touchTiltX = x;
    this.touchTiltY = y;
  }

  setYawInput(v: number): void {
    this.touchYaw = v;
  }

  setThrottleLever(v: number): void {
    this.pendingThrottleAbsolute = Math.min(Math.max(v, 0), 1);
  }

  setFullThrust(active: boolean): void {
    this.touchFullThrust = active;
  }

  cutThrottle(): void {
    this.pendingCut = true;
  }

  toggleHoverHold(): void {
    this.pendingHoverToggle = true;
  }

  cycleCamera(): void {
    this.pendingCameraCycle = true;
  }

  restart(): void {
    this.pendingRestart = true;
  }

  // ---- Frame-level capture (called once per frame by LanderMode) ----

  /**
   * Latch keyboard one-shots. Must be called once per render frame, before
   * physics steps run (just-pressed state is valid for the whole frame).
   */
  captureFrameInput(): void {
    const input = this.inputManager;
    if (input.isKeyJustPressed('x')) this.pendingCut = true;
    if (input.isKeyJustPressed('h')) this.pendingHoverToggle = true;
    if (input.isKeyJustPressed('c')) this.pendingCameraCycle = true;
    if (input.isKeyJustPressed('r')) this.pendingRestart = true;
  }

  // ---- Per-step consumption (called from beforePhysicsStep) ----

  /**
   * Current attitude command (level inputs; safe to read every step).
   * Keyboard and touch compose additively and clamp in the controller.
   */
  getAttitudeCommand(): AttitudeCommand {
    const input = this.inputManager;
    let tiltY = this.touchTiltY;
    if (input.isKeyPressed('w')) tiltY += 1;
    if (input.isKeyPressed('s')) tiltY -= 1;
    let tiltX = this.touchTiltX;
    if (input.isKeyPressed('d')) tiltX += 1;
    if (input.isKeyPressed('a')) tiltX -= 1;
    let yaw = this.touchYaw;
    if (input.isKeyPressed('q') || input.isKeyPressed('arrowleft')) yaw += 1;
    if (input.isKeyPressed('e') || input.isKeyPressed('arrowright')) yaw -= 1;
    return { tiltX, tiltY, yaw };
  }

  /**
   * Engine input for one physics step. One-shots (cut) and the absolute
   * touch lever are consumed here — exactly once.
   */
  consumeEngineInput(): EngineInput {
    const input = this.inputManager;
    let throttleHeld = 0;
    if (input.isKeyPressed('arrowup')) throttleHeld += 1;
    if (input.isKeyPressed('arrowdown')) throttleHeld -= 1;

    const result: EngineInput = {
      throttleHeld,
      throttleAbsolute: this.pendingThrottleAbsolute,
      fullThrust: this.touchFullThrust || input.isKeyPressed(' '),
      cut: this.pendingCut,
    };
    this.pendingThrottleAbsolute = null;
    this.pendingCut = false;
    return result;
  }

  /** Consume the pending hover-hold toggle (once per step at most). */
  consumeHoverToggle(): boolean {
    const pending = this.pendingHoverToggle;
    this.pendingHoverToggle = false;
    return pending;
  }

  // ---- Frame-level consumption (LanderMode.update) ----

  consumeCameraCycle(): boolean {
    const pending = this.pendingCameraCycle;
    this.pendingCameraCycle = false;
    return pending;
  }

  consumeRestart(): boolean {
    const pending = this.pendingRestart;
    this.pendingRestart = false;
    return pending;
  }

  /** Drop all latched/level state (mission restart, mode exit). */
  reset(): void {
    this.touchTiltX = 0;
    this.touchTiltY = 0;
    this.touchYaw = 0;
    this.touchFullThrust = false;
    this.pendingThrottleAbsolute = null;
    this.pendingCut = false;
    this.pendingHoverToggle = false;
    this.pendingCameraCycle = false;
    this.pendingRestart = false;
  }
}
