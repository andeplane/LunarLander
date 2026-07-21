import { describe, it, expect } from 'vitest';
import { EngineModel, hoverThrottle, hoverHoldThrottle, type EngineInput } from './engineModel';
import { LANDER_CONFIG } from './config';

const DT = 1 / 60;

const NEUTRAL: EngineInput = {
  throttleHeld: 0,
  throttleAbsolute: null,
  fullThrust: false,
  cut: false,
};

function stepMany(engine: EngineModel, input: Partial<EngineInput>, steps: number, mass = 6000) {
  let last = engine.step(DT, { ...NEUTRAL, ...input }, mass, 1, 0);
  for (let i = 1; i < steps; i++) {
    last = engine.step(DT, { ...NEUTRAL, ...input }, mass, 1, 0);
  }
  return last;
}

describe('hoverThrottle', () => {
  it('matches thrust = weight at full mass (≈45% for TWR 2.2)', () => {
    const fullMass = LANDER_CONFIG.dryMass + LANDER_CONFIG.fuelMass;
    const t = hoverThrottle(fullMass, 1);
    expect(t).toBeCloseTo(1 / 2.2, 3);
  });

  it('rises with tilt (thrust vector tips away from vertical)', () => {
    const t0 = hoverThrottle(6000, 1);
    const t25 = hoverThrottle(6000, Math.cos((25 * Math.PI) / 180));
    expect(t25).toBeGreaterThan(t0);
  });

  it('drops as fuel burns (lighter craft hovers cheaper)', () => {
    expect(hoverThrottle(4000, 1)).toBeLessThan(hoverThrottle(6000, 1));
  });

  it('saturates at 1 when hover is unreachable', () => {
    expect(hoverThrottle(1e9, 1)).toBe(1);
  });
});

describe('hoverHoldThrottle', () => {
  it('adds throttle while descending, removes while climbing', () => {
    const base = hoverThrottle(6000, 1);
    expect(hoverHoldThrottle(6000, 1, -3)).toBeGreaterThan(base);
    expect(hoverHoldThrottle(6000, 1, 3)).toBeLessThan(base);
  });

  it('clamps to [0, 1]', () => {
    expect(hoverHoldThrottle(6000, 1, -100)).toBe(1);
    expect(hoverHoldThrottle(6000, 1, 100)).toBe(0);
  });
});

describe(EngineModel.name, () => {
  it('lever slews up while held and stays where released (persistent)', () => {
    const engine = new EngineModel(1000);
    stepMany(engine, { throttleHeld: 1 }, 60); // 1 s
    expect(engine.getLever()).toBeCloseTo(LANDER_CONFIG.throttleSlewRate, 2);
    const lever = engine.getLever();
    stepMany(engine, {}, 120);
    expect(engine.getLever()).toBe(lever); // no spring-back
  });

  it('lever clamps to [0, 1]', () => {
    const engine = new EngineModel(1000);
    stepMany(engine, { throttleHeld: 1 }, 600);
    expect(engine.getLever()).toBe(1);
    stepMany(engine, { throttleHeld: -1 }, 600);
    expect(engine.getLever()).toBe(0);
  });

  it('touch slider sets the lever absolutely', () => {
    const engine = new EngineModel(1000);
    stepMany(engine, { throttleAbsolute: 0.64 }, 1);
    expect(engine.getLever()).toBeCloseTo(0.64, 10);
  });

  it('cut zeroes the lever instantly', () => {
    const engine = new EngineModel(1000);
    stepMany(engine, { throttleAbsolute: 0.8 }, 1);
    stepMany(engine, { cut: true }, 1);
    expect(engine.getLever()).toBe(0);
  });

  it('full thrust overrides the lever while held, without moving it', () => {
    const engine = new EngineModel(1000);
    stepMany(engine, { throttleAbsolute: 0.3 }, 1);
    const res = stepMany(engine, { fullThrust: true }, 1);
    expect(res.thrustN).toBeCloseTo(LANDER_CONFIG.maxThrust, 6);
    expect(engine.getLever()).toBeCloseTo(0.3, 10);
    const after = stepMany(engine, {}, 1);
    expect(after.thrustN).toBeCloseTo(0.3 * LANDER_CONFIG.maxThrust, 6);
  });

  it('burns fuel linearly with throttle and cuts out when empty', () => {
    const capacity = 10;
    const engine = new EngineModel(capacity);
    // Full throttle: capacity / maxBurnRate seconds of burn
    const burnSeconds = capacity / LANDER_CONFIG.maxBurnRate;
    const steps = Math.ceil(burnSeconds / DT) + 5;
    stepMany(engine, { throttleAbsolute: 1 }, steps);
    expect(engine.getFuelKg()).toBe(0);
    const res = stepMany(engine, { throttleAbsolute: 1 }, 1);
    expect(res.thrustN).toBe(0); // engine out
  });

  it('zero throttle burns nothing', () => {
    const engine = new EngineModel(100);
    stepMany(engine, {}, 300);
    expect(engine.getFuelKg()).toBe(100);
  });

  it('hover-hold tracks toward zero vertical speed and records usage', () => {
    const engine = new EngineModel(1000);
    expect(engine.wasHoverHoldUsed()).toBe(false);
    engine.toggleHoverHold();
    expect(engine.isHoverHold()).toBe(true);
    expect(engine.wasHoverHoldUsed()).toBe(true);

    // Descending: hover-hold commands more than hover throttle
    const res = engine.step(DT, NEUTRAL, 6000, 1, -3);
    expect(res.effectiveThrottle).toBeGreaterThan(hoverThrottle(6000, 1));

    // Manual throttle input disengages the hold, but usage flag persists
    engine.step(DT, { ...NEUTRAL, throttleHeld: 1 }, 6000, 1, 0);
    expect(engine.isHoverHold()).toBe(false);
    expect(engine.wasHoverHoldUsed()).toBe(true);
  });

  it('fuel fraction reflects remaining fuel', () => {
    const engine = new EngineModel(200);
    expect(engine.getFuelFraction()).toBe(1);
    stepMany(engine, { throttleAbsolute: 1 }, 60);
    expect(engine.getFuelFraction()).toBeLessThan(1);
    expect(engine.getFuelFraction()).toBeGreaterThan(0);
  });
});
