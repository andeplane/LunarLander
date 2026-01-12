/**
 * Input manager responsible for:
 * - Keyboard input handling
 * - Mouse input handling
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

  constructor() {
    this.setupEventListeners();
  }

  /**
   * Set up keyboard and mouse event listeners
   */
  private setupEventListeners(): void {
    window.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      // Track just-pressed keys (not already held)
      if (!this.keys.has(key)) {
        this.keysJustPressed.add(key);
      }
      this.keys.add(key);
    });

    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });

    document.addEventListener('mousemove', (e) => {
      if (this.isPointerLocked) {
        this.mouseDelta.x += e.movementX;
        this.mouseDelta.y += e.movementY;
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.isPointerLocked = document.pointerLockElement !== null;
    });

    // Scroll wheel for speed adjustment
    window.addEventListener('wheel', (e) => {
      this.scrollDelta += e.deltaY;
    });
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
   * Request pointer lock
   */
  requestPointerLock(): void {
    document.body.requestPointerLock();
  }

  /**
   * Cleanup event listeners
   */
  dispose(): void {
    // Event listeners will be cleaned up automatically
  }
}
