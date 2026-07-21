import { hasCoarsePrimaryPointer, isTouchDevice } from '../utils/mobile';

/**
 * Input manager responsible for:
 * - Keyboard input handling
 * - Mouse input handling
 * - Touch input handling (mobile)
 * - Pointer lock management
 * - Input state tracking
 * - Scroll wheel for speed adjustment
 */
export class InputManager {
  private keys: Set<string> = new Set();
  private keysJustPressed: Set<string> = new Set();
  private mouseDelta: { x: number; y: number } = { x: 0, y: 0 };
  private scrollDelta: number = 0;
  private isPointerLocked: boolean = false;
  
  // Touch input state
  private touchMoveDirection: { x: number; y: number } = { x: 0, y: 0 };
  private touchLookDelta: { x: number; y: number } = { x: 0, y: 0 };
  private verticalInput: number = 0; // -1 for down, 1 for up, 0 for none
  private isTouchDevice: boolean = false;

  constructor() {
    this.isTouchDevice = isTouchDevice();
    this.setupEventListeners();
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const key = e.key.toLowerCase();
    // Track just-pressed keys (not already held)
    if (!this.keys.has(key)) {
      this.keysJustPressed.add(key);
    }
    this.keys.add(key);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (this.isPointerLocked) {
      this.mouseDelta.x += e.movementX;
      this.mouseDelta.y += e.movementY;
    }
  };

  private readonly onPointerLockChange = (): void => {
    this.isPointerLocked = document.pointerLockElement !== null;
    // Drop any held keys/deltas when the pointer unlocks (e.g. Esc to use the GUI),
    // otherwise keys held at unlock time would stick
    if (!this.isPointerLocked) {
      this.clearTransientState();
    }
  };

  // Scroll wheel for speed adjustment — only while pointer-locked,
  // so scrolling over the GUI doesn't change flight speed
  private readonly onWheel = (e: WheelEvent): void => {
    if (this.isPointerLocked) {
      this.scrollDelta += e.deltaY;
    }
  };

  private readonly onBlur = (): void => {
    this.clearTransientState();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.clearTransientState();
    }
  };

  /**
   * Set up keyboard and mouse event listeners
   */
  private setupEventListeners(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('wheel', this.onWheel);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  /**
   * Clear transient input state (held keys, accumulated deltas).
   * Called on blur / tab hide / pointer-lock loss so keys never stick
   * when keyup events are missed.
   */
  private clearTransientState(): void {
    this.keys.clear();
    this.keysJustPressed.clear();
    this.mouseDelta = { x: 0, y: 0 };
    this.scrollDelta = 0;
  }

  /**
   * Reset ALL input state, including touch axes (which clearTransientState
   * deliberately leaves alone — touch axes are level-based, not event-deltas).
   * Called on mode switches so a hidden joystick can't leave inputs stuck.
   */
  resetAll(): void {
    this.clearTransientState();
    this.touchMoveDirection = { x: 0, y: 0 };
    this.touchLookDelta = { x: 0, y: 0 };
    this.verticalInput = 0;
  }

  /**
   * Check if a key is currently pressed
   */
  isKeyPressed(key: string): boolean {
    return this.keys.has(key.toLowerCase());
  }

  /**
   * Check if a key was just pressed this frame
   * Call update() at the end of each frame to clear just-pressed state
   */
  isKeyJustPressed(key: string): boolean {
    return this.keysJustPressed.has(key.toLowerCase());
  }

  /**
   * Update input state (call at end of frame to clear just-pressed keys)
   */
  update(): void {
    this.keysJustPressed.clear();
    // Clear touch look delta after it's been read
    this.touchLookDelta = { x: 0, y: 0 };
  }

  /**
   * Get mouse delta movement (since last call)
   */
  getMouseDelta(): { x: number; y: number } {
    const delta = { ...this.mouseDelta };
    this.mouseDelta = { x: 0, y: 0 };
    return delta;
  }

  /**
   * Get scroll wheel delta (since last call)
   * Positive = scroll down, Negative = scroll up
   */
  getScrollDelta(): number {
    const delta = this.scrollDelta;
    this.scrollDelta = 0;
    return delta;
  }

  /**
   * Check if pointer is locked
   */
  isPointerLockActive(): boolean {
    return this.isPointerLocked;
  }

  /**
   * Request pointer lock.
   * Skipped only when the primary pointer is coarse (phones/tablets) —
   * touch capability alone must not disable mouse look, so hybrid devices
   * (touchscreen laptops) still get pointer lock.
   */
  requestPointerLock(): void {
    if (hasCoarsePrimaryPointer()) {
      return;
    }
    // Can throw or reject: browsers refuse lock during the ~1s cooldown
    // after Esc, without user activation, or in headless/sandboxed
    // contexts. Losing mouse look for one click is fine; crashing isn't.
    try {
      const result = document.body.requestPointerLock() as unknown;
      if (result instanceof Promise) {
        result.catch(() => {});
      }
    } catch {
      // ignore — the next click retries
    }
  }

  /**
   * Set touch-based movement direction (from joystick)
   * x: -1 to 1 (left to right)
   * y: -1 to 1 (backward to forward)
   */
  setMoveDirection(x: number, y: number): void {
    this.touchMoveDirection.x = x;
    this.touchMoveDirection.y = y;
  }

  /**
   * Get touch movement direction
   */
  getMoveDirection(): { x: number; y: number } {
    return { ...this.touchMoveDirection };
  }

  /**
   * Set vertical input (up/down)
   * value: -1 for down, 1 for up, 0 for none
   */
  setVerticalInput(value: number): void {
    this.verticalInput = Math.max(-1, Math.min(1, value));
  }

  /**
   * Get vertical input
   */
  getVerticalInput(): number {
    return this.verticalInput;
  }

  /**
   * Add touch look delta (from right-side drag)
   */
  addTouchLookDelta(x: number, y: number): void {
    this.touchLookDelta.x += x;
    this.touchLookDelta.y += y;
  }

  /**
   * Get touch look delta (since last call)
   */
  getTouchLookDelta(): { x: number; y: number } {
    return { ...this.touchLookDelta };
  }

  /**
   * Check if this is a touch device
   */
  getIsTouchDevice(): boolean {
    return this.isTouchDevice;
  }

  /**
   * Cleanup event listeners
   */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.clearTransientState();
    this.touchMoveDirection = { x: 0, y: 0 };
    this.touchLookDelta = { x: 0, y: 0 };
    this.verticalInput = 0;
  }
}
