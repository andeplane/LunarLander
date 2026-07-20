import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputManager } from './InputManager';

/**
 * Fake EventTarget capturing listeners so tests can dispatch synthetic
 * events (keydown, blur, pointerlockchange, ...) without a DOM.
 */
class FakeEventTarget {
  private listeners = new Map<string, Set<(e: unknown) => void>>();

  addEventListener(type: string, listener: (e: unknown) => void): void {
    const existing = this.listeners.get(type);
    if (existing) {
      existing.add(listener);
    } else {
      this.listeners.set(type, new Set([listener]));
    }
  }

  removeEventListener(type: string, listener: (e: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

interface FakeDocument extends FakeEventTarget {
  pointerLockElement: unknown;
  hidden: boolean;
  body: { requestPointerLock: ReturnType<typeof vi.fn> };
}

describe(InputManager.name, () => {
  let win: FakeEventTarget & { matchMedia?: (q: string) => { matches: boolean } };
  let doc: FakeDocument;
  let coarsePointer: boolean;

  beforeEach(() => {
    coarsePointer = false;
    win = Object.assign(new FakeEventTarget(), {
      matchMedia: (query: string) => ({
        matches: query === '(pointer: coarse)' && coarsePointer,
      }),
    });
    doc = Object.assign(new FakeEventTarget(), {
      pointerLockElement: null as unknown,
      hidden: false,
      body: { requestPointerLock: vi.fn() },
    });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Lock the pointer and notify the manager (as the browser would). */
  function lockPointer(): void {
    doc.pointerLockElement = {};
    doc.dispatch('pointerlockchange');
  }

  function unlockPointer(): void {
    doc.pointerLockElement = null;
    doc.dispatch('pointerlockchange');
  }

  describe('keyboard state', () => {
    it('tracks pressed and released keys case-insensitively', () => {
      const input = new InputManager();

      win.dispatch('keydown', { key: 'W' });
      expect(input.isKeyPressed('w')).toBe(true);
      expect(input.isKeyPressed('W')).toBe(true);
      expect(input.isKeyPressed('s')).toBe(false);

      win.dispatch('keyup', { key: 'w' });
      expect(input.isKeyPressed('w')).toBe(false);
    });

    it('reports just-pressed only until update() runs, and not for held keys', () => {
      const input = new InputManager();

      win.dispatch('keydown', { key: 'e' });
      expect(input.isKeyJustPressed('e')).toBe(true);

      input.update();
      expect(input.isKeyJustPressed('e')).toBe(false);
      expect(input.isKeyPressed('e')).toBe(true);

      // OS key-repeat fires keydown again while held: must NOT re-trigger
      win.dispatch('keydown', { key: 'e' });
      expect(input.isKeyJustPressed('e')).toBe(false);
    });
  });

  describe('stuck-key prevention (transient state clearing)', () => {
    it('clears held keys and deltas when the window loses focus', () => {
      const input = new InputManager();
      lockPointer();
      win.dispatch('keydown', { key: 'w' });
      doc.dispatch('mousemove', { movementX: 10, movementY: 5 });
      win.dispatch('wheel', { deltaY: 100 });

      win.dispatch('blur');

      expect(input.isKeyPressed('w')).toBe(false);
      expect(input.getMouseDelta()).toEqual({ x: 0, y: 0 });
      expect(input.getScrollDelta()).toBe(0);
    });

    it('clears held keys when the tab is hidden, but not when it becomes visible', () => {
      const input = new InputManager();
      win.dispatch('keydown', { key: 'a' });

      doc.hidden = false;
      doc.dispatch('visibilitychange');
      expect(input.isKeyPressed('a')).toBe(true);

      doc.hidden = true;
      doc.dispatch('visibilitychange');
      expect(input.isKeyPressed('a')).toBe(false);
    });

    it('clears held keys when pointer lock is lost (Esc to use the GUI)', () => {
      const input = new InputManager();
      lockPointer();
      win.dispatch('keydown', { key: 'd' });
      expect(input.isKeyPressed('d')).toBe(true);

      unlockPointer();

      expect(input.isKeyPressed('d')).toBe(false);
      expect(input.isPointerLockActive()).toBe(false);
    });
  });

  describe('mouse look', () => {
    it('accumulates mouse deltas only while pointer-locked', () => {
      const input = new InputManager();

      doc.dispatch('mousemove', { movementX: 10, movementY: 5 });
      expect(input.getMouseDelta()).toEqual({ x: 0, y: 0 });

      lockPointer();
      doc.dispatch('mousemove', { movementX: 10, movementY: 5 });
      doc.dispatch('mousemove', { movementX: 3, movementY: -2 });
      expect(input.getMouseDelta()).toEqual({ x: 13, y: 3 });
    });

    it('resets the mouse delta after each read', () => {
      const input = new InputManager();
      lockPointer();
      doc.dispatch('mousemove', { movementX: 7, movementY: 7 });

      expect(input.getMouseDelta()).toEqual({ x: 7, y: 7 });
      expect(input.getMouseDelta()).toEqual({ x: 0, y: 0 });
    });
  });

  describe('scroll wheel', () => {
    it('accumulates wheel deltas only while pointer-locked (GUI scrolling must not change speed)', () => {
      const input = new InputManager();

      win.dispatch('wheel', { deltaY: 120 });
      expect(input.getScrollDelta()).toBe(0);

      lockPointer();
      win.dispatch('wheel', { deltaY: 120 });
      win.dispatch('wheel', { deltaY: -40 });
      expect(input.getScrollDelta()).toBe(80);
      // Read resets
      expect(input.getScrollDelta()).toBe(0);
    });
  });

  describe('pointer lock request', () => {
    it('requests pointer lock on devices with a fine primary pointer', () => {
      coarsePointer = false;
      const input = new InputManager();
      input.requestPointerLock();
      expect(doc.body.requestPointerLock).toHaveBeenCalledTimes(1);
    });

    it('skips pointer lock on coarse-pointer devices (phones/tablets)', () => {
      coarsePointer = true;
      const input = new InputManager();
      input.requestPointerLock();
      expect(doc.body.requestPointerLock).not.toHaveBeenCalled();
    });
  });

  describe('touch input', () => {
    it('stores the joystick move direction', () => {
      const input = new InputManager();
      input.setMoveDirection(0.5, -0.25);
      expect(input.getMoveDirection()).toEqual({ x: 0.5, y: -0.25 });
    });

    it('clamps vertical input to [-1, 1]', () => {
      const input = new InputManager();
      input.setVerticalInput(5);
      expect(input.getVerticalInput()).toBe(1);
      input.setVerticalInput(-3);
      expect(input.getVerticalInput()).toBe(-1);
      input.setVerticalInput(0.5);
      expect(input.getVerticalInput()).toBe(0.5);
    });

    it('accumulates touch look deltas and clears them on update()', () => {
      const input = new InputManager();
      input.addTouchLookDelta(4, 2);
      input.addTouchLookDelta(1, 1);
      expect(input.getTouchLookDelta()).toEqual({ x: 5, y: 3 });

      // Reads do not consume the delta (update() clears it at end of frame)
      expect(input.getTouchLookDelta()).toEqual({ x: 5, y: 3 });

      input.update();
      expect(input.getTouchLookDelta()).toEqual({ x: 0, y: 0 });
    });

    it('detects touch devices from navigator.maxTouchPoints', () => {
      vi.stubGlobal('navigator', { maxTouchPoints: 5 });
      const input = new InputManager();
      expect(input.getIsTouchDevice()).toBe(true);
    });
  });

  describe('dispose', () => {
    it('removes all listeners and resets state', () => {
      const input = new InputManager();
      win.dispatch('keydown', { key: 'w' });
      input.setMoveDirection(1, 1);
      input.setVerticalInput(1);

      input.dispose();

      expect(win.listenerCount('keydown')).toBe(0);
      expect(win.listenerCount('keyup')).toBe(0);
      expect(win.listenerCount('wheel')).toBe(0);
      expect(win.listenerCount('blur')).toBe(0);
      expect(doc.listenerCount('mousemove')).toBe(0);
      expect(doc.listenerCount('pointerlockchange')).toBe(0);
      expect(doc.listenerCount('visibilitychange')).toBe(0);

      expect(input.isKeyPressed('w')).toBe(false);
      expect(input.getMoveDirection()).toEqual({ x: 0, y: 0 });
      expect(input.getVerticalInput()).toBe(0);
    });
  });
});
