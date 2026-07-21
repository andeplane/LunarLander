import { Euler, Vector3, type PerspectiveCamera } from 'three';
import type { GameMode } from './ModeManager';
import type { FlightController } from '../camera/FlightController';
import type { InputManager } from '../core/InputManager';
import type { TouchControls } from '../ui/TouchControls';
import type { BallManager } from '../physics/BallManager';
import { isTouchDevice } from '../utils/mobile';
import '../lander/LanderScreens.css'; // shared screen-panel styles
import './ExploreMode.css';

/**
 * The original free-flight experience, wrapped as a GameMode (ADR-0001).
 *
 * Owns everything Explore-specific that used to live in main.ts / Engine:
 * - an onboarding panel (controls) shown on entry; its START button doubles
 *   as the pointer-lock-acquiring click
 * - pointer-lock acquisition on canvas click + the "press ESC" hint
 * - a corner Menu button back to the main menu (hidden while pointer-locked)
 * - the Explore touch controls overlay visibility
 * - Space-to-shoot balls (an advertised Explore feature, not a debug key)
 * - saving/restoring the camera pose across mode switches
 */

const DESKTOP_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['Click', 'Enable mouse look'],
  ['Mouse', 'Look around'],
  ['W / S', 'Fly forward / back'],
  ['A / D', 'Strafe left / right'],
  ['E / Q', 'Up / down'],
  ['Shift', 'Speed boost'],
  ['Scroll', 'Adjust speed'],
  ['Space', 'Shoot ball'],
  ['Esc', 'Release mouse'],
];

const TOUCH_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['Left stick', 'Move'],
  ['Right drag', 'Look around'],
  ['↑ / ↓', 'Up / down'],
  ['Speed', 'Tap to cycle flight speed'],
];

export class ExploreMode implements GameMode {
  private camera: PerspectiveCamera;
  private flightController: FlightController;
  private inputManager: InputManager;
  private touchControls: TouchControls | null;
  private canvas: HTMLCanvasElement;
  private ballManager: BallManager | null = null;
  private requestRender: () => void;
  private onExitToMenu: () => void;

  /** Saved pose so returning from another mode restores the view exactly. */
  private savedPosition: Vector3 | null = null;
  private savedRotation: Euler | null = null;

  private pointerLockHint: HTMLDivElement;
  private onboarding: HTMLDivElement;
  private menuButton: HTMLButtonElement;
  private hintTimeout: ReturnType<typeof setTimeout> | null = null;
  private active: boolean = false;
  private onboardingVisible: boolean = false;

  constructor(args: {
    camera: PerspectiveCamera;
    flightController: FlightController;
    inputManager: InputManager;
    touchControls: TouchControls | null;
    canvas: HTMLCanvasElement;
    requestRender: () => void;
    onExitToMenu: () => void;
  }) {
    this.camera = args.camera;
    this.flightController = args.flightController;
    this.inputManager = args.inputManager;
    this.touchControls = args.touchControls;
    this.canvas = args.canvas;
    this.requestRender = args.requestRender;
    this.onExitToMenu = args.onExitToMenu;
    this.pointerLockHint = this.buildPointerLockHint();
    this.onboarding = this.buildOnboarding();
    this.menuButton = this.buildMenuButton();
  }

  /**
   * Late injection: the ball manager exists only after async Rapier init.
   */
  setBallManager(ballManager: BallManager): void {
    this.ballManager = ballManager;
  }

  enter(): void {
    this.active = true;

    // Restore the pose Explore last had (menu drift / lander flights moved
    // the camera since), then re-seed the flight controller's cached angles
    if (this.savedPosition && this.savedRotation) {
      this.camera.position.copy(this.savedPosition);
      this.camera.quaternion.setFromEuler(this.savedRotation);
    }
    this.flightController.syncFromCamera();

    this.canvas.addEventListener('click', this.onCanvasClick);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    window.addEventListener('keydown', this.onOnboardingKeydown);
    document.body.appendChild(this.pointerLockHint);
    document.body.appendChild(this.onboarding);
    document.body.appendChild(this.menuButton);
    this.setOnboardingVisible(true);

    if (this.touchControls) {
      this.touchControls.setVisible(true);
    }
    this.requestRender();
  }

  exit(): void {
    this.active = false;

    // Save pose (position + full orientation as YXZ euler; Explore has no roll)
    this.savedPosition = (this.savedPosition ?? new Vector3()).copy(this.camera.position);
    this.savedRotation = (this.savedRotation ?? new Euler(0, 0, 0, 'YXZ')).setFromQuaternion(
      this.camera.quaternion,
      'YXZ'
    );

    this.canvas.removeEventListener('click', this.onCanvasClick);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    window.removeEventListener('keydown', this.onOnboardingKeydown);
    this.hideHint();
    this.pointerLockHint.remove();
    this.onboarding.remove();
    this.menuButton.remove();
    if (document.pointerLockElement) {
      document.exitPointerLock();
    }
    if (this.touchControls) {
      this.touchControls.setVisible(false);
    }
  }

  update(deltaTime: number): void {
    // Input is inert until the onboarding panel is dismissed
    if (this.onboardingVisible) {
      return;
    }
    // Space shoots a ball (advertised Explore feature)
    if (this.ballManager && this.inputManager.isKeyJustPressed(' ')) {
      this.ballManager.shootBall(this.camera);
      this.requestRender();
    }
    this.flightController.update(deltaTime);
  }

  // ---- Onboarding panel ----

  private setOnboardingVisible(visible: boolean): void {
    this.onboardingVisible = visible;
    this.onboarding.classList.toggle('hidden', !visible);
    // The corner Menu button appears once flying (and hides under pointer lock)
    this.menuButton.classList.toggle('hidden', visible || document.pointerLockElement !== null);
  }

  private startFlying(): void {
    this.setOnboardingVisible(false);
    // The dismissing click/keypress is a user gesture — acquire mouse look
    // immediately (no-op on coarse-pointer devices)
    this.inputManager.requestPointerLock();
  }

  private readonly onOnboardingKeydown = (e: KeyboardEvent): void => {
    if (this.active && this.onboardingVisible && e.key === 'Enter') {
      this.startFlying();
    }
  };

  private buildOnboarding(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.className = 'lander-screen screen-explore hidden';

    const panel = document.createElement('div');
    panel.className = 'screen-panel';

    const kicker = document.createElement('div');
    kicker.className = 'screen-kicker';
    kicker.textContent = 'Free flight';
    const title = document.createElement('div');
    title.className = 'screen-title';
    title.textContent = 'EXPLORE';
    const objective = document.createElement('div');
    objective.className = 'screen-objective';
    objective.textContent = 'Fly anywhere — the Moon goes on forever.';

    const controls = document.createElement('div');
    controls.className = 'briefing-controls';
    const grid = document.createElement('div');
    grid.className = 'controls-grid';
    for (const [key, action] of isTouchDevice() ? TOUCH_CONTROLS : DESKTOP_CONTROLS) {
      const k = document.createElement('span');
      k.className = 'key';
      k.textContent = key;
      const a = document.createElement('span');
      a.className = 'action';
      a.textContent = action;
      grid.appendChild(k);
      grid.appendChild(a);
    }
    controls.appendChild(grid);

    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'screen-button primary launch-button';
    start.textContent = 'START FLYING';
    start.addEventListener('click', () => this.startFlying());

    const hint = document.createElement('div');
    hint.className = 'screen-hint';
    hint.textContent = isTouchDevice() ? 'Tap to start' : 'Enter to start';

    panel.appendChild(kicker);
    panel.appendChild(title);
    panel.appendChild(objective);
    panel.appendChild(controls);
    panel.appendChild(start);
    panel.appendChild(hint);
    overlay.appendChild(panel);
    return overlay;
  }

  private buildMenuButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'explore-menu-button hidden';
    button.textContent = '☰ Menu';
    button.addEventListener('click', () => this.onExitToMenu());
    return button;
  }

  // ---- Pointer lock ----

  private readonly onCanvasClick = (): void => {
    if (!this.onboardingVisible) {
      this.inputManager.requestPointerLock();
    }
  };

  private readonly onPointerLockChange = (): void => {
    if (!this.active) return;
    const locked = document.pointerLockElement !== null;
    // The Menu button is unreachable (and distracting) while the cursor is
    // captured; it reappears when Esc releases the pointer
    this.menuButton.classList.toggle('hidden', locked || this.onboardingVisible);
    if (locked) {
      // Pointer just locked — show hint briefly
      if (this.hintTimeout) clearTimeout(this.hintTimeout);
      this.pointerLockHint.style.opacity = '1';
      this.hintTimeout = setTimeout(() => {
        this.pointerLockHint.style.opacity = '0';
      }, 2500);
    } else {
      this.hideHint();
    }
  };

  private hideHint(): void {
    if (this.hintTimeout) {
      clearTimeout(this.hintTimeout);
      this.hintTimeout = null;
    }
    this.pointerLockHint.style.opacity = '0';
  }

  private buildPointerLockHint(): HTMLDivElement {
    const hint = document.createElement('div');
    hint.textContent = '🖱️ Press ESC to release mouse';
    Object.assign(hint.style, {
      position: 'fixed',
      top: '20px',
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(0, 0, 0, 0.65)',
      color: '#fff',
      padding: '8px 18px',
      borderRadius: '8px',
      fontSize: '14px',
      fontFamily: 'system-ui, sans-serif',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.3s ease',
      zIndex: '9999',
    });
    return hint;
  }
}
