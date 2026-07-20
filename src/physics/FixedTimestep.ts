/**
 * FixedTimestep - Fixed-timestep accumulator for physics stepping
 *
 * Decouples physics simulation speed from display refresh rate:
 * frame deltas are accumulated and converted into a whole number of
 * fixed-size physics steps, so the simulation advances at the same
 * rate on 30 Hz, 60 Hz and 120 Hz displays.
 */
export class FixedTimestep {
  private accumulator = 0;

  /**
   * @param stepSize Fixed step size in seconds (default 1/60, matching Rapier's default)
   * @param maxStepsPerFrame Cap on catch-up steps per frame to avoid spiral of death
   */
  constructor(
    readonly stepSize: number = 1 / 60,
    readonly maxStepsPerFrame: number = 5
  ) {
    if (stepSize <= 0) {
      throw new Error(`FixedTimestep: stepSize must be > 0, got ${stepSize}`);
    }
    if (maxStepsPerFrame < 1) {
      throw new Error(`FixedTimestep: maxStepsPerFrame must be >= 1, got ${maxStepsPerFrame}`);
    }
  }

  /**
   * Advance the accumulator by deltaTime seconds.
   *
   * @returns the number of fixed steps to simulate this frame
   */
  advance(deltaTime: number): number {
    if (!Number.isFinite(deltaTime) || deltaTime < 0) {
      return 0;
    }

    this.accumulator += deltaTime;

    // Cap accumulated time so a huge delta (e.g. returning from a
    // backgrounded tab) doesn't trigger an unbounded catch-up burst
    const maxAccumulated = this.stepSize * this.maxStepsPerFrame;
    if (this.accumulator > maxAccumulated) {
      this.accumulator = maxAccumulated;
    }

    const steps = Math.floor(this.accumulator / this.stepSize);
    this.accumulator -= steps * this.stepSize;
    return steps;
  }

  /**
   * Reset the accumulator (e.g. after pausing or disposing).
   */
  reset(): void {
    this.accumulator = 0;
  }
}
