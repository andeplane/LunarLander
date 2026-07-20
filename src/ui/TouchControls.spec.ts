import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TouchControls } from './TouchControls';
import type { InputManager } from '../core/InputManager';
import type { FlightController } from '../camera/FlightController';

/** Joystick event data shape used by the nipplejs 'move' callback. */
interface JoystickData {
  vector: { x: number; y: number };
}

const nipplejsMocks = vi.hoisted(() => {
  const handlers = new Map<string, (evt: unknown, data: JoystickData) => void>();
  const manager = {
    on: vi.fn((event: string, cb: (evt: unknown, data: JoystickData) => void) => {
      handlers.set(event, cb);
    }),
    destroy: vi.fn(),
  };
  const create = vi.fn(() => manager);
  return { handlers, manager, create };
});

vi.mock('nipplejs', () => ({ default: { create: nipplejsMocks.create } }));

/**
 * Minimal DOM element stand-in: records children, class names, and event
 * listeners so synthetic touch events can be dispatched without a browser.
 */
class FakeElement {
  className = '';
  textContent = '';
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private listeners = new Map<string, Array<(e: unknown) => void>>();

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index !== -1) {
      this.children.splice(index, 1);
      child.parentNode = null;
    }
    return child;
  }

  addEventListener(type: string, listener: (e: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (existing) {
      existing.push(listener);
    } else {
      this.listeners.set(type, [listener]);
    }
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const fullEvent = { preventDefault: vi.fn(), ...event };
    for (const listener of this.listeners.get(type) ?? []) {
      listener(fullEvent);
    }
  }

  /** Depth-first search for a descendant by class name. */
  find(className: string): FakeElement | null {
    for (const child of this.children) {
      if (child.className.includes(className)) return child;
      const nested = child.find(className);
      if (nested) return nested;
    }
    return null;
  }
}

function makeTouch(identifier: number, clientX: number, clientY: number) {
  return { identifier, clientX, clientY };
}

/** Find a descendant by class name, throwing when absent. */
function mustFind(root: FakeElement, className: string): FakeElement {
  const element = root.find(className);
  if (!element) {
    throw new Error(`expected element with class: ${className}`);
  }
  return element;
}

/** The registered nipplejs handler for an event, throwing when absent. */
function joystickHandler(event: string): (evt: unknown, data: JoystickData) => void {
  const handler = nipplejsMocks.handlers.get(event);
  if (!handler) {
    throw new Error(`expected joystick handler for: ${event}`);
  }
  return handler;
}

describe(TouchControls.name, () => {
  let body: FakeElement;
  let inputManager: {
    setMoveDirection: ReturnType<typeof vi.fn>;
    addTouchLookDelta: ReturnType<typeof vi.fn>;
    setVerticalInput: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    nipplejsMocks.handlers.clear();
    nipplejsMocks.create.mockClear();
    nipplejsMocks.manager.destroy.mockClear();

    body = new FakeElement();
    vi.stubGlobal('document', {
      createElement: () => new FakeElement(),
      body,
    });

    inputManager = {
      setMoveDirection: vi.fn(),
      addTouchLookDelta: vi.fn(),
      setVerticalInput: vi.fn(),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeControls(): { controls: TouchControls; container: FakeElement } {
    const controls = new TouchControls(inputManager as unknown as InputManager);
    const container = body.children[0];
    return { controls, container };
  }

  describe('joystick', () => {
    it('creates a nipplejs joystick in the joystick zone', () => {
      const { container } = makeControls();
      expect(nipplejsMocks.create).toHaveBeenCalledTimes(1);
      expect(container.find('joystick-zone')).not.toBeNull();
    });

    it('forwards joystick moves with inverted Y so forward is positive', () => {
      makeControls();

      joystickHandler('move')(null, { vector: { x: 0.5, y: 0.8 } });

      expect(inputManager.setMoveDirection).toHaveBeenCalledWith(0.5, -0.8);
    });

    it('zeroes the move direction when the joystick is released', () => {
      makeControls();

      joystickHandler('end')(null, { vector: { x: 0, y: 0 } });

      expect(inputManager.setMoveDirection).toHaveBeenCalledWith(0, 0);
    });
  });

  describe('touch look', () => {
    it('sends raw pixel deltas for the tracked touch (sensitivity applied downstream)', () => {
      const { container } = makeControls();
      const zone = mustFind(container, 'touch-look-zone');

      zone.dispatch('touchstart', { changedTouches: [makeTouch(7, 100, 100)] });
      expect(inputManager.addTouchLookDelta).not.toHaveBeenCalled();

      zone.dispatch('touchmove', { changedTouches: [makeTouch(7, 110, 95)] });
      expect(inputManager.addTouchLookDelta).toHaveBeenCalledWith(10, -5);

      // Deltas are relative to the previous move, not the start point
      zone.dispatch('touchmove', { changedTouches: [makeTouch(7, 112, 95)] });
      expect(inputManager.addTouchLookDelta).toHaveBeenLastCalledWith(2, 0);
    });

    it('ignores moves from other simultaneous touches', () => {
      const { container } = makeControls();
      const zone = mustFind(container, 'touch-look-zone');

      zone.dispatch('touchstart', { changedTouches: [makeTouch(7, 100, 100)] });
      // A second finger lands in the zone: must not steal look tracking
      zone.dispatch('touchstart', { changedTouches: [makeTouch(9, 0, 0)] });
      zone.dispatch('touchmove', { changedTouches: [makeTouch(9, 50, 50)] });

      expect(inputManager.addTouchLookDelta).not.toHaveBeenCalled();

      // The original finger still drives the look
      zone.dispatch('touchmove', { changedTouches: [makeTouch(7, 105, 100)] });
      expect(inputManager.addTouchLookDelta).toHaveBeenCalledWith(5, 0);
    });

    it('releases tracking on touchend so a new touch can take over', () => {
      const { container } = makeControls();
      const zone = mustFind(container, 'touch-look-zone');

      zone.dispatch('touchstart', { changedTouches: [makeTouch(7, 100, 100)] });
      zone.dispatch('touchend', { changedTouches: [makeTouch(7, 100, 100)] });

      zone.dispatch('touchstart', { changedTouches: [makeTouch(11, 200, 200)] });
      zone.dispatch('touchmove', { changedTouches: [makeTouch(11, 203, 204)] });

      expect(inputManager.addTouchLookDelta).toHaveBeenCalledWith(3, 4);
    });

    it('releases tracking on touchcancel', () => {
      const { container } = makeControls();
      const zone = mustFind(container, 'touch-look-zone');

      zone.dispatch('touchstart', { changedTouches: [makeTouch(7, 100, 100)] });
      zone.dispatch('touchcancel', { changedTouches: [makeTouch(7, 100, 100)] });
      zone.dispatch('touchmove', { changedTouches: [makeTouch(7, 150, 150)] });

      expect(inputManager.addTouchLookDelta).not.toHaveBeenCalled();
    });
  });

  describe('vertical buttons', () => {
    it('up button sets vertical input to 1 while held, 0 on release', () => {
      const { container } = makeControls();
      const up = mustFind(container, 'up-button');

      up.dispatch('touchstart');
      expect(inputManager.setVerticalInput).toHaveBeenLastCalledWith(1);

      up.dispatch('touchend');
      expect(inputManager.setVerticalInput).toHaveBeenLastCalledWith(0);
    });

    it('down button sets vertical input to -1 while held, 0 on cancel', () => {
      const { container } = makeControls();
      const down = mustFind(container, 'down-button');

      down.dispatch('touchstart');
      expect(inputManager.setVerticalInput).toHaveBeenLastCalledWith(-1);

      down.dispatch('touchcancel');
      expect(inputManager.setVerticalInput).toHaveBeenLastCalledWith(0);
    });
  });

  describe('speed control', () => {
    it('cycles presets 1x -> 2x -> 5x -> 10x -> 1x and updates the label', () => {
      const { controls, container } = makeControls();
      const button = mustFind(container, 'speed-button');
      expect(button.textContent).toBe('1x');
      expect(controls.getSpeedMultiplier()).toBe(1);

      const expected: Array<[string, number]> = [
        ['2x', 2],
        ['5x', 5],
        ['10x', 10],
        ['1x', 1],
      ];
      for (const [label, multiplier] of expected) {
        button.dispatch('touchstart');
        expect(button.textContent).toBe(label);
        expect(controls.getSpeedMultiplier()).toBe(multiplier);
      }
    });

    it('applies the preset to the flight controller when cycling', () => {
      const { controls, container } = makeControls();
      const flightController = { setSpeedMultiplier: vi.fn() };
      controls.setFlightController(flightController as unknown as FlightController);
      // Attaching syncs the controller with the current preset
      expect(flightController.setSpeedMultiplier).toHaveBeenCalledWith(1);

      mustFind(container, 'speed-button').dispatch('touchstart');

      expect(flightController.setSpeedMultiplier).toHaveBeenLastCalledWith(2);
    });
  });

  describe('dispose', () => {
    it('destroys the joystick and removes the container from the DOM', () => {
      const { controls } = makeControls();
      expect(body.children).toHaveLength(1);

      controls.dispose();

      expect(nipplejsMocks.manager.destroy).toHaveBeenCalledTimes(1);
      expect(body.children).toHaveLength(0);
    });
  });
});
