import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoadingManager } from './LoadingManager';

/**
 * Tests run in a node environment (no DOM), so the LoadingManager
 * exercises its DOM-free code paths. Fake timers control the watchdog.
 */
describe('LoadingManager', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  it('completes when all registered textures load and chunk is ready', () => {
    const manager = new LoadingManager();
    manager.registerTextures(6);

    for (let i = 0; i < 6; i++) {
      manager.onTextureLoaded();
    }
    expect(manager.isLoadingComplete()).toBe(false);

    manager.onChunkReady();
    expect(manager.isLoadingComplete()).toBe(true);
  });

  it('does not complete before all textures are loaded', () => {
    const manager = new LoadingManager();
    manager.registerTextures(6);

    manager.onChunkReady();
    for (let i = 0; i < 5; i++) {
      manager.onTextureLoaded();
    }
    expect(manager.isLoadingComplete()).toBe(false);

    manager.onTextureLoaded();
    expect(manager.isLoadingComplete()).toBe(true);
  });

  it('still completes when some textures fail to load', () => {
    const manager = new LoadingManager();
    manager.registerTextures(6);
    manager.onChunkReady();

    for (let i = 0; i < 4; i++) {
      manager.onTextureLoaded();
    }
    manager.onTextureError('skybox');
    expect(manager.isLoadingComplete()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith('Failed to load texture: skybox');

    manager.onTextureError();
    expect(warnSpy).toHaveBeenCalledWith('Failed to load texture');
    expect(manager.isLoadingComplete()).toBe(true);
  });

  it('completes even if all textures fail', () => {
    const manager = new LoadingManager();
    manager.registerTextures(6);
    manager.onChunkReady();

    for (let i = 0; i < 6; i++) {
      manager.onTextureError(`texture-${i}`);
    }
    expect(manager.isLoadingComplete()).toBe(true);
  });

  it('watchdog force-completes stalled loading at exactly 20000ms', () => {
    const manager = new LoadingManager();
    manager.registerTextures(6);
    manager.onTextureLoaded(); // Only 1 of 6 — loading stalls

    vi.advanceTimersByTime(19999);
    expect(manager.isLoadingComplete()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(manager.isLoadingComplete()).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      'Loading stalled (1/6 textures, chunk ready: false) — force-completing'
    );
  });

  it('watchdog does not fire after normal completion', () => {
    const manager = new LoadingManager();
    manager.registerTextures(2);
    manager.onTextureLoaded();
    manager.onTextureLoaded();
    manager.onChunkReady();
    expect(manager.isLoadingComplete()).toBe(true);

    vi.advanceTimersByTime(60000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('watchdog can be disabled with watchdogMs = 0', () => {
    const manager = new LoadingManager(0);
    manager.registerTextures(6);

    vi.advanceTimersByTime(1000000);
    expect(manager.isLoadingComplete()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('supports a custom watchdog timeout', () => {
    const manager = new LoadingManager(5000);
    manager.registerTextures(6);

    vi.advanceTimersByTime(4999);
    expect(manager.isLoadingComplete()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(manager.isLoadingComplete()).toBe(true);
  });

  it('completes with zero registered textures once chunk is ready', () => {
    const manager = new LoadingManager();

    expect(manager.isLoadingComplete()).toBe(false);
    manager.onChunkReady();
    expect(manager.isLoadingComplete()).toBe(true);
  });

  it('accumulates counts across multiple registerTextures calls', () => {
    const manager = new LoadingManager();
    manager.registerTextures(2);
    manager.registerTextures(4);
    manager.onChunkReady();

    for (let i = 0; i < 5; i++) {
      manager.onTextureLoaded();
    }
    expect(manager.isLoadingComplete()).toBe(false);

    manager.onTextureLoaded();
    expect(manager.isLoadingComplete()).toBe(true);
  });

  it('ignores texture events after completion', () => {
    const manager = new LoadingManager();
    manager.registerTextures(1);
    manager.onTextureLoaded();
    manager.onChunkReady();
    expect(manager.isLoadingComplete()).toBe(true);

    // Extra events should be no-ops
    manager.onTextureLoaded();
    manager.onTextureError('late');
    expect(warnSpy).not.toHaveBeenCalledWith('Failed to load texture: late');
    expect(manager.isLoadingComplete()).toBe(true);
  });
});
