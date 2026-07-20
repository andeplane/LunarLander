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
  private touchLookActive: boolean = false;
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
      if (e.touches.length === 1) {
        this.touchLookActive = true;
        const touch = e.touches[0];
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        e.preventDefault();
      }
    });

    touchLookZone.addEventListener('touchmove', (e) => {
      if (this.touchLookActive && e.touches.length === 1) {
        const touch = e.touches[0];
        const deltaX = touch.clientX - this.lastTouchX;
        const deltaY = touch.clientY - this.lastTouchY;
        
        // Apply sensitivity (similar to mouse sensitivity)
        const sensitivity = 0.002;
        this.inputManager.addTouchLookDelta(deltaX * sensitivity, deltaY * sensitivity);
        
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        e.preventDefault();
      }
    });

    touchLookZone.addEventListener('touchend', (e) => {
      this.touchLookActive = false;
      e.preventDefault();
    });

    touchLookZone.addEventListener('touchcancel', () => {
      this.touchLookActive = false;
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
   * Set flight controller reference (for speed control)
   */
  setFlightController(flightController: FlightController): void {
    this.flightController = flightController;
  }

  /**
   * Get current speed preset multiplier
   */
  getSpeedMultiplier(): number {
    return this.speedPresets[this.currentSpeedPresetIndex];
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
