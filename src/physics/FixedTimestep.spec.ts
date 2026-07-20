import { describe, it, expect } from 'vitest';
import { FixedTimestep } from './FixedTimestep';

describe('FixedTimestep', () => {
  it('produces exactly 1 step per frame at 60fps', () => {
    const timestep = new FixedTimestep();
    for (let i = 0; i < 10; i++) {
      expect(timestep.advance(1 / 60)).toBe(1);
    }
  });

  it('produces ~60 steps per second at 120fps (alternating 0 and 1 steps)', () => {
    const timestep = new FixedTimestep();
    let totalSteps = 0;
    for (let i = 0; i < 120; i++) {
      const steps = timestep.advance(1 / 120);
      expect(steps).toBeLessThanOrEqual(1);
      totalSteps += steps;
    }
    // 120 frames of 1/120s = 1 second of real time = ~60 physics steps
    expect(totalSteps).toBeGreaterThanOrEqual(59);
    expect(totalSteps).toBeLessThanOrEqual(60);
  });

  it('produces 2 steps per frame at 30fps', () => {
    const timestep = new FixedTimestep();
    let totalSteps = 0;
    for (let i = 0; i < 30; i++) {
      totalSteps += timestep.advance(1 / 30);
    }
    // 30 frames of 1/30s = 1 second = ~60 physics steps
    expect(totalSteps).toBeGreaterThanOrEqual(59);
    expect(totalSteps).toBeLessThanOrEqual(60);
  });

  it('accumulates fractional remainders across frames', () => {
    const timestep = new FixedTimestep(1 / 60);
    // 0.75 of a step: no step yet
    expect(timestep.advance(0.75 / 60)).toBe(0);
    // another 0.75: accumulator reaches 1.5 steps -> 1 step, 0.5 remains
    expect(timestep.advance(0.75 / 60)).toBe(1);
    // another 0.75: accumulator reaches 1.25 steps -> 1 step
    expect(timestep.advance(0.75 / 60)).toBe(1);
  });

  it('caps catch-up steps after a huge delta', () => {
    const timestep = new FixedTimestep(1 / 60, 5);
    // 10 seconds (e.g. backgrounded tab) would be 600 steps uncapped
    expect(timestep.advance(10)).toBe(5);
    // Excess time is discarded, not carried over
    expect(timestep.advance(0)).toBe(0);
  });

  it('ignores negative, NaN and Infinity deltas', () => {
    const timestep = new FixedTimestep();
    expect(timestep.advance(-1)).toBe(0);
    expect(timestep.advance(Number.NaN)).toBe(0);
    expect(timestep.advance(Number.POSITIVE_INFINITY)).toBe(0);
    // Accumulator is untouched by invalid deltas
    expect(timestep.advance(1 / 60)).toBe(1);
  });

  it('reset() clears the accumulator', () => {
    const timestep = new FixedTimestep();
    timestep.advance(0.9 / 60);
    timestep.reset();
    expect(timestep.advance(0.5 / 60)).toBe(0);
  });

  it('throws on invalid constructor arguments', () => {
    expect(() => new FixedTimestep(0)).toThrow();
    expect(() => new FixedTimestep(-1 / 60)).toThrow();
    expect(() => new FixedTimestep(1 / 60, 0)).toThrow();
  });
});
