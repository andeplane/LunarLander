import { describe, it, expect, vi } from 'vitest';
import { ModeManager, type GameMode } from './ModeManager';
import type { InputManager } from '../core/InputManager';

function makeMode() {
  const enter = vi.fn<() => void>();
  const exit = vi.fn<() => void>();
  const update = vi.fn<(dt: number) => void>();
  const mode: GameMode = { enter, exit, update };
  return Object.assign(mode, { enter, exit, update });
}

function makeInputStub() {
  const resetAll = vi.fn();
  return { stub: { resetAll } as unknown as InputManager, resetAll };
}

describe(ModeManager.name, () => {
  it('enters the first mode without exiting anything', () => {
    const { stub } = makeInputStub();
    const manager = new ModeManager(stub);
    const mode = makeMode();

    manager.switchTo(mode);

    expect(mode.enter).toHaveBeenCalledTimes(1);
    expect(mode.exit).not.toHaveBeenCalled();
    expect(manager.getActiveMode()).toBe(mode);
  });

  it('runs exit → input reset → enter, in that order, on transitions', () => {
    const { stub, resetAll } = makeInputStub();
    const manager = new ModeManager(stub);
    const order: string[] = [];
    const a = makeMode();
    const b = makeMode();
    a.exit.mockImplementation(() => order.push('a.exit'));
    resetAll.mockImplementation(() => order.push('resetAll'));
    b.enter.mockImplementation(() => order.push('b.enter'));

    manager.switchTo(a);
    order.length = 0; // ignore initial entry
    manager.switchTo(b);

    expect(order).toEqual(['a.exit', 'resetAll', 'b.enter']);
  });

  it('ignores switching to the already-active mode', () => {
    const { stub } = makeInputStub();
    const manager = new ModeManager(stub);
    const mode = makeMode();

    manager.switchTo(mode);
    manager.switchTo(mode);

    expect(mode.enter).toHaveBeenCalledTimes(1);
    expect(mode.exit).not.toHaveBeenCalled();
  });

  it('notifies the mode-change callback after entering', () => {
    const { stub } = makeInputStub();
    const onChange = vi.fn();
    const manager = new ModeManager(stub, onChange);
    const mode = makeMode();

    manager.switchTo(mode);

    expect(onChange).toHaveBeenCalledWith(mode);
  });

  it('updates the active mode with deltaTime, but not while paused', () => {
    const { stub } = makeInputStub();
    const manager = new ModeManager(stub);
    const mode = makeMode();
    manager.switchTo(mode);

    manager.update(0.016);
    expect(mode.update).toHaveBeenCalledWith(0.016);

    manager.setPaused(true);
    manager.update(0.016);
    expect(mode.update).toHaveBeenCalledTimes(1);

    manager.setPaused(false);
    manager.update(0.032);
    expect(mode.update).toHaveBeenCalledTimes(2);
  });

  it('clears pause state when switching modes', () => {
    const { stub } = makeInputStub();
    const manager = new ModeManager(stub);
    const a = makeMode();
    const b = makeMode();

    manager.switchTo(a);
    manager.setPaused(true);
    manager.switchTo(b);

    expect(manager.isPaused()).toBe(false);
    manager.update(0.016);
    expect(b.update).toHaveBeenCalled();
  });

  it('update is a no-op before any mode is active', () => {
    const { stub } = makeInputStub();
    const manager = new ModeManager(stub);
    expect(() => manager.update(0.016)).not.toThrow();
  });
});
