import { describe, it, expect, afterEach, vi } from 'vitest';
import { isTouchDevice, hasCoarsePrimaryPointer } from './mobile';

/**
 * Tests run in a node environment; window/navigator are stubbed per test so
 * the device-detection gates can be exercised for every device class:
 * desktop, phone/tablet, and hybrid (touchscreen laptop).
 */
describe('mobile device detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubEnvironment(options: {
    ontouchstart?: boolean;
    maxTouchPoints?: number;
    coarsePointer?: boolean | 'no-matchMedia';
  }): void {
    const win: Record<string, unknown> = {};
    if (options.ontouchstart) {
      win.ontouchstart = null; // presence is what matters, value is irrelevant
    }
    if (options.coarsePointer !== 'no-matchMedia') {
      win.matchMedia = vi.fn((query: string) => ({
        matches: query === '(pointer: coarse)' && options.coarsePointer === true,
      }));
    }
    vi.stubGlobal('window', win);
    vi.stubGlobal('navigator', { maxTouchPoints: options.maxTouchPoints ?? 0 });
  }

  describe(isTouchDevice.name, () => {
    it('is false on a pure desktop', () => {
      stubEnvironment({});
      expect(isTouchDevice()).toBe(false);
    });

    it('is true when ontouchstart exists', () => {
      stubEnvironment({ ontouchstart: true });
      expect(isTouchDevice()).toBe(true);
    });

    it('is true when navigator reports touch points (hybrid laptop)', () => {
      stubEnvironment({ maxTouchPoints: 5 });
      expect(isTouchDevice()).toBe(true);
    });
  });

  describe(hasCoarsePrimaryPointer.name, () => {
    it('is true on phones/tablets (coarse primary pointer)', () => {
      stubEnvironment({ ontouchstart: true, maxTouchPoints: 5, coarsePointer: true });
      expect(hasCoarsePrimaryPointer()).toBe(true);
    });

    it('is false on touchscreen laptops (fine primary pointer despite touch)', () => {
      stubEnvironment({ ontouchstart: true, maxTouchPoints: 5, coarsePointer: false });
      // The critical hybrid-device distinction: touch-capable but NOT coarse,
      // so pointer lock / mouse look must stay available
      expect(isTouchDevice()).toBe(true);
      expect(hasCoarsePrimaryPointer()).toBe(false);
    });

    it('is false when matchMedia is unavailable', () => {
      stubEnvironment({ coarsePointer: 'no-matchMedia' });
      expect(hasCoarsePrimaryPointer()).toBe(false);
    });
  });
});
