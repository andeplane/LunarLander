import { describe, it, expect } from 'vitest';
import { movementAmount } from './input';

describe('movementAmount', () => {
  it('returns 0 when neither keyboard nor analog input is active', () => {
    expect(movementAmount(false, 0)).toBe(0);
  });

  it('returns full strength for keyboard input even when analog is centered (hybrid devices)', () => {
    // Regression: keyboard was dead on touch-capable laptops because the
    // centered joystick magnitude (0) masked pressed keys.
    expect(movementAmount(true, 0)).toBe(1);
  });

  it('returns the analog magnitude when only analog input is active', () => {
    expect(movementAmount(false, 0.4)).toBe(0.4);
    expect(movementAmount(false, 1)).toBe(1);
  });

  it('returns the stronger input when both are active', () => {
    expect(movementAmount(true, 0.3)).toBe(1);
    expect(movementAmount(true, 1)).toBe(1);
  });

  it('clamps analog magnitude into [0, 1]', () => {
    expect(movementAmount(false, 1.5)).toBe(1);
    expect(movementAmount(false, -0.5)).toBe(0);
  });
});
