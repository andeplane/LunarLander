import type { InputManager } from '../core/InputManager';

/**
 * A top-level experience the app can be in (Menu, Explore, Lander).
 * Exactly one mode is active at all times (ADR-0001).
 */
export interface GameMode {
  /** Install controllers, UI, and entities for this mode. */
  enter(): void;
  /** Tear down mode-specific entities/UI and release input. */
  exit(): void;
  /** Per-frame logic; called by the Engine in the pre-physics slot. */
  update(deltaTime: number): void;
}

/**
 * Owns the active GameMode and performs transitions.
 *
 * Transition order: old.exit() → full input reset → new.enter().
 * The input reset covers held keys AND touch axes, so hiding a touch UI
 * mid-gesture can never leave a stuck joystick value in the new mode.
 */
export class ModeManager {
  private activeMode: GameMode | null = null;
  private paused: boolean = false;
  private inputManager: InputManager;
  private onModeChange: ((mode: GameMode) => void) | null;

  constructor(inputManager: InputManager, onModeChange?: (mode: GameMode) => void) {
    this.inputManager = inputManager;
    this.onModeChange = onModeChange ?? null;
  }

  /**
   * Switch to a new mode. No-op if it is already active.
   */
  switchTo(mode: GameMode): void {
    if (mode === this.activeMode) {
      return;
    }
    if (this.activeMode) {
      this.activeMode.exit();
    }
    this.inputManager.resetAll();
    this.paused = false;
    this.activeMode = mode;
    mode.enter();
    if (this.onModeChange) {
      this.onModeChange(mode);
    }
  }

  /**
   * Per-frame update of the active mode. Skipped while paused
   * (the Engine also skips physics stepping while paused).
   */
  update(deltaTime: number): void {
    if (!this.paused && this.activeMode) {
      this.activeMode.update(deltaTime);
    }
  }

  getActiveMode(): GameMode | null {
    return this.activeMode;
  }

  /**
   * Pause/resume the active mode. While paused the Engine freezes physics
   * and mode updates; rendering continues so pause overlays draw.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }
}
