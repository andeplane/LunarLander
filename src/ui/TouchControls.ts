import nipplejs from 'nipplejs';
import type { InputManager } from '../core/InputManager';
import type { FlightController } from '../camera/FlightController';
import './TouchControls.css';

/**
 * Touch controls for mobile devices
 * - Left side: Virtual joystick for movement
 * - Right side: Touch drag area for camera look
 * - Up/Down buttons for vertical movement
 * - Speed indicator/control
 */
export class TouchControls {
  private container: HTMLDivElement;
  private joystickManager: nipplejs.JoystickManager | null = null;
  private inputManager: InputManager;
  private flightController: FlightController | null = null;
  private lookTouchId: number | null = null;
  private lastTouchX: number = 0;
  private lastTouchY: number = 0;
  private speedPresets: number[] = [1.0, 2.0, 5.0, 10.0];
  private currentSpeedPresetIndex: number = 0;

  constructor(inputManager: InputManager) {
    this.inputManager = inputManager;
    this.container = this.createContainer();
    this.setupJoystick();
    this.setupTouchLook();
    this.setupVerticalButtons();
    this.setupSpeedControl();
  }

  /**
   * Create the main container for touch controls
   */
  private createContainer(): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'touch-controls';
    document.body.appendChild(container);
    return container;
  }

  /**
   * Setup virtual joystick on the left side
   */
  private setupJoystick(): void {
    const joystickZone = document.createElement('div');
    joystickZone.className = 'joystick-zone';
    this.container.appendChild(joystickZone);

    this.joystickManager = nipplejs.create({
      zone: joystickZone,
      mode: 'static',
      position: { left: '50%', top: '50%' },
      color: 'rgba(255, 255, 255, 0.5)',
      size: 120,
    });

    this.joystickManager.on('move', (_, data) => {
      // data.vector.x is -1 to 1 (left to right)
      // data.vector.y is -1 to 1 (backward to forward)
      // Invert y so forward is positive
      this.inputManager.setMoveDirection(data.vector.x, -data.vector.y);
    });

    this.joystickManager.on('end', () => {
      this.inputManager.setMoveDirection(0, 0);
    });
  }

  /**
   * Setup touch look area on the right side
   */
  private setupTouchLook(): void {
    const touchLookZone = document.createElement('div');
    touchLookZone.className = 'touch-look-zone';
    this.container.appendChild(touchLookZone);

    touchLookZone.addEventListener('touchstart', (e) => {
      // Track a single look touch by its identifier so other simultaneous
      // touches (joystick, buttons) don't disturb look tracking
      if (this.lookTouchId === null && e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        this.lookTouchId = touch.identifier;
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        e.preventDefault();
      }
    });

    touchLookZone.addEventListener('touchmove', (e) => {
      const touch = this.findLookTouch(e.changedTouches);
      if (touch) {
        const deltaX = touch.clientX - this.lastTouchX;
        const deltaY = touch.clientY - this.lastTouchY;

        // Pass raw pixel deltas — look sensitivity is applied once,
        // in FlightController (same path as mouse look)
        this.inputManager.addTouchLookDelta(deltaX, deltaY);

        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        e.preventDefault();
      }
    });

    touchLookZone.addEventListener('touchend', (e) => {
      if (this.findLookTouch(e.changedTouches)) {
        this.lookTouchId = null;
      }
      e.preventDefault();
    });

    touchLookZone.addEventListener('touchcancel', (e) => {
      if (this.findLookTouch(e.changedTouches)) {
        this.lookTouchId = null;
      }
    });
  }

  /**
   * Setup up/down buttons
   */
  private setupVerticalButtons(): void {
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'vertical-buttons';
    
    const upButton = document.createElement('button');
    upButton.className = 'vertical-button up-button';
    upButton.textContent = '↑';
    upButton.addEventListener('touchstart', (e) => {
      this.inputManager.setVerticalInput(1);
      e.preventDefault();
    });
    upButton.addEventListener('touchend', (e) => {
      this.inputManager.setVerticalInput(0);
      e.preventDefault();
    });
    upButton.addEventListener('touchcancel', () => {
      this.inputManager.setVerticalInput(0);
    });

    const downButton = document.createElement('button');
    downButton.className = 'vertical-button down-button';
    downButton.textContent = '↓';
    downButton.addEventListener('touchstart', (e) => {
      this.inputManager.setVerticalInput(-1);
      e.preventDefault();
    });
    downButton.addEventListener('touchend', (e) => {
      this.inputManager.setVerticalInput(0);
      e.preventDefault();
    });
    downButton.addEventListener('touchcancel', () => {
      this.inputManager.setVerticalInput(0);
    });

    buttonContainer.appendChild(upButton);
    buttonContainer.appendChild(downButton);
    this.container.appendChild(buttonContainer);
  }

  /**
   * Setup speed control button
   */
  private setupSpeedControl(): void {
    const speedButton = document.createElement('button');
    speedButton.className = 'speed-button';
    speedButton.textContent = '1x';
    this.updateSpeedButton(speedButton);
    
    speedButton.addEventListener('touchstart', (e) => {
      this.cycleSpeedPreset();
      this.updateSpeedButton(speedButton);
      e.preventDefault();
    });

    this.container.appendChild(speedButton);
  }

  /**
   * Cycle through speed presets
   */
  private cycleSpeedPreset(): void {
    this.currentSpeedPresetIndex = (this.currentSpeedPresetIndex + 1) % this.speedPresets.length;
    if (this.flightController) {
      const multiplier = this.speedPresets[this.currentSpeedPresetIndex];
      this.flightController.setSpeedMultiplier(multiplier);
    }
  }

  /**
   * Update speed button text
   */
  private updateSpeedButton(button: HTMLButtonElement): void {
    const preset = this.speedPresets[this.currentSpeedPresetIndex];
    button.textContent = `${preset}x`;
  }

  /**
   * Find the tracked look touch in a touch list, if present
   */
  private findLookTouch(touches: TouchList): Touch | null {
    if (this.lookTouchId === null) {
      return null;
    }
    for (let i = 0; i < touches.length; i++) {
      if (touches[i].identifier === this.lookTouchId) {
        return touches[i];
      }
    }
    return null;
  }

  /**
   * Set flight controller reference (for speed control)
   * Applies the currently selected speed preset so controller and UI stay in sync
   */
  setFlightController(flightController: FlightController): void {
    this.flightController = flightController;
    flightController.setSpeedMultiplier(this.speedPresets[this.currentSpeedPresetIndex]);
  }

  /**
   * Get current speed preset multiplier
   */
  getSpeedMultiplier(): number {
    return this.speedPresets[this.currentSpeedPresetIndex];
  }

  /**
   * Show or hide the touch controls overlay. The instance (and its nipplejs
   * joystick) stays alive so speed presets survive mode switches.
   * Callers must reset InputManager touch axes when hiding mid-touch.
   */
  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
  }

  /**
   * Dispose of touch controls
   */
  dispose(): void {
    if (this.joystickManager) {
      this.joystickManager.destroy();
    }
    if (this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }
}
