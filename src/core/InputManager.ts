/**
 * Input manager responsible for:
 * - Keyboard input handling
 * - Mouse input handling
 * - Pointer lock management
 * - Input state tracking
 */
export class InputManager {
  private keys: Set<string> = new Set();
  private mouseDelta: { x: number; y: number } = { x: 0, y: 0 };
  private isPointerLocked: boolean = false;

  constructor() {
    this.setupEventListeners();
  }

  /**
   * Set up keyboard and mouse event listeners
   */
  private setupEventListeners(): void {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key.toLowerCase());
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
  }

  /**
   * Check if a key is currently pressed
   */
  isKeyPressed(key: string): boolean {
    return this.keys.has(key.toLowerCase());
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
