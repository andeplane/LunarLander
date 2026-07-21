import nipplejs from 'nipplejs';
import type { LanderInputSink } from './types';
import './LanderTouchControls.css';

/**
 * Touch controls for the Lander mode (ADR-0002 §4).
 *
 * - Right side: nipplejs joystick commanding the tilt target ("angle mode",
 *   release → auto-level in the flight model).
 * - Left side: custom sticky vertical throttle slider (persistent lever —
 *   deliberately NOT a nipplejs stick, which springs back on release), with
 *   a hover tick mark, fill level and % readout.
 * - Yaw paddles (⟲ ⟳) above the throttle, large hover-hold toggle above the
 *   joystick, camera / restart buttons in the top corners, and an X cut
 *   button next to the throttle.
 *
 * Separate from the Explore `TouchControls` on purpose — that component is
 * hardwired to Explore semantics (look zone, speed presets) and is never
 * reused here. Hidden by default; call `setVisible(true)` to show.
 */
export class LanderTouchControls {
  private sink: LanderInputSink;
  private container: HTMLDivElement;
  private joystickManager: nipplejs.JoystickManager | null = null;

  // Throttle slider state — tracked by touch identifier so the joystick,
  // yaw paddles and throttle can all be used simultaneously.
  private throttleTouchId: number | null = null;
  private throttleValue = 0;
  private throttleTrack!: HTMLDivElement;
  private throttleFill!: HTMLDivElement;
  private throttleTick!: HTMLDivElement;
  private throttleLabel!: HTMLDivElement;

  private hoverHoldButton!: HTMLButtonElement;

  constructor(sink: LanderInputSink) {
    this.sink = sink;
    this.container = this.createContainer();
    this.setupTiltJoystick();
    this.setupLeftCluster();
    this.setupHoverHoldButton();
    this.setupCornerButtons();
    this.renderThrottle();
    // Hidden by default; LanderMode shows it on entry.
    this.container.style.display = 'none';
  }

  /**
   * Full-screen overlay. pointer-events stay disabled on the container
   * itself — only the individual controls accept touches, so the terrain
   * view underneath remains interactive/visible.
   */
  private createContainer(): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'lander-touch-controls';
    document.body.appendChild(container);
    return container;
  }

  /**
   * Right stick: tilt target, angle mode. Stick x → right roll positive,
   * stick up → forward pitch positive (tilt forward/away). Release → (0,0);
   * the flight model auto-levels.
   */
  private setupTiltJoystick(): void {
    const zone = document.createElement('div');
    zone.className = 'lander-joystick-zone';
    this.container.appendChild(zone);

    this.joystickManager = nipplejs.create({
      zone,
      mode: 'static',
      position: { right: '18%', bottom: '30%' },
      color: 'rgba(140, 190, 255, 0.6)',
      size: 130,
    });

    this.joystickManager.on('move', (_, data) => {
      // nipplejs vector: x right-positive, y up-positive — both already
      // match the sink convention (x = right roll, y = forward pitch).
      this.sink.setTiltInput(data.vector.x, data.vector.y);
    });

    this.joystickManager.on('end', () => {
      this.sink.setTiltInput(0, 0);
    });
  }

  /**
   * Left cluster: yaw paddles on top, then the sticky throttle slider with
   * the X cut button beside it. The left thumb owns all three; leaving the
   * throttle to yaw is fine because the lever is sticky.
   */
  private setupLeftCluster(): void {
    const cluster = document.createElement('div');
    cluster.className = 'lander-left-cluster';
    this.container.appendChild(cluster);

    cluster.appendChild(this.createYawPaddles());

    const row = document.createElement('div');
    row.className = 'lander-throttle-row';
    row.appendChild(this.createThrottleSlider());
    row.appendChild(this.createCutButton());
    cluster.appendChild(row);
  }

  /** Yaw paddles: press-and-hold. ⟲ = turn left/CCW = +1 per the sink docs. */
  private createYawPaddles(): HTMLDivElement {
    const paddles = document.createElement('div');
    paddles.className = 'lander-yaw-paddles';
    paddles.appendChild(this.createHoldButton('lander-yaw-button', '⟲', (active) => {
      this.sink.setYawInput(active ? 1 : 0);
    }));
    paddles.appendChild(this.createHoldButton('lander-yaw-button', '⟳', (active) => {
      this.sink.setYawInput(active ? -1 : 0);
    }));
    return paddles;
  }

  /**
   * Sticky vertical throttle: dragging sets the absolute lever position
   * (0 bottom → 1 top) and it stays where released. A single touch is
   * tracked by identifier (same pattern as the Explore look zone) so other
   * simultaneous touches never disturb it.
   */
  private createThrottleSlider(): HTMLDivElement {
    const throttle = document.createElement('div');
    throttle.className = 'lander-throttle';

    this.throttleLabel = document.createElement('div');
    this.throttleLabel.className = 'lander-throttle-label';
    throttle.appendChild(this.throttleLabel);

    this.throttleTrack = document.createElement('div');
    this.throttleTrack.className = 'lander-throttle-track';
    throttle.appendChild(this.throttleTrack);

    this.throttleFill = document.createElement('div');
    this.throttleFill.className = 'lander-throttle-fill';
    this.throttleTrack.appendChild(this.throttleFill);

    this.throttleTick = document.createElement('div');
    this.throttleTick.className = 'lander-throttle-tick';
    this.throttleTrack.appendChild(this.throttleTick);

    throttle.addEventListener('touchstart', (e) => {
      if (this.throttleTouchId === null && e.changedTouches.length > 0) {
        const touch = e.changedTouches[0];
        this.throttleTouchId = touch.identifier;
        this.setThrottleFromClientY(touch.clientY);
      }
      e.preventDefault();
    });

    throttle.addEventListener('touchmove', (e) => {
      const touch = this.findTouch(e.changedTouches, this.throttleTouchId);
      if (touch) {
        this.setThrottleFromClientY(touch.clientY);
      }
      e.preventDefault();
    });

    const release = (e: TouchEvent) => {
      if (this.findTouch(e.changedTouches, this.throttleTouchId)) {
        // Sticky: the lever stays where it was released.
        this.throttleTouchId = null;
      }
      e.preventDefault();
    };
    throttle.addEventListener('touchend', release);
    throttle.addEventListener('touchcancel', release);

    return throttle;
  }

  /** X cut button near the throttle: one-shot cut to zero. */
  private createCutButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'lander-cut-button';
    button.textContent = '✕';
    button.setAttribute('aria-label', 'Cut throttle');
    button.addEventListener('touchstart', (e) => {
      this.sink.cutThrottle();
      // Keep the local lever visual in sync with the model.
      this.throttleValue = 0;
      this.renderThrottle();
      e.preventDefault();
    });
    button.addEventListener('touchend', (e) => e.preventDefault());
    return button;
  }

  /** Large thumb-reachable hover-hold toggle above the joystick. */
  private setupHoverHoldButton(): void {
    this.hoverHoldButton = document.createElement('button');
    this.hoverHoldButton.className = 'lander-hover-button';
    this.hoverHoldButton.textContent = 'HOVER HOLD';
    this.hoverHoldButton.addEventListener('touchstart', (e) => {
      this.sink.toggleHoverHold();
      e.preventDefault();
    });
    this.hoverHoldButton.addEventListener('touchend', (e) => e.preventDefault());
    this.container.appendChild(this.hoverHoldButton);
  }

  /** Small top-corner buttons: restart (top-left) and camera cycle (top-right). */
  private setupCornerButtons(): void {
    const restart = document.createElement('button');
    restart.className = 'lander-corner-button lander-restart-button';
    restart.textContent = '↺';
    restart.setAttribute('aria-label', 'Restart mission');
    restart.addEventListener('touchstart', (e) => {
      this.sink.restart();
      e.preventDefault();
    });
    restart.addEventListener('touchend', (e) => e.preventDefault());
    this.container.appendChild(restart);

    const camera = document.createElement('button');
    camera.className = 'lander-corner-button lander-camera-button';
    camera.textContent = '📷';
    camera.setAttribute('aria-label', 'Cycle camera');
    camera.addEventListener('touchstart', (e) => {
      this.sink.cycleCamera();
      e.preventDefault();
    });
    camera.addEventListener('touchend', (e) => e.preventDefault());
    this.container.appendChild(camera);
  }

  /** Momentary press-and-hold button: active on touchstart, off on end/cancel. */
  private createHoldButton(
    className: string,
    label: string,
    onActive: (active: boolean) => void
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = className;
    button.textContent = label;
    button.addEventListener('touchstart', (e) => {
      onActive(true);
      e.preventDefault();
    });
    button.addEventListener('touchend', (e) => {
      onActive(false);
      e.preventDefault();
    });
    button.addEventListener('touchcancel', () => {
      onActive(false);
    });
    return button;
  }

  /** Map a clientY onto the track (bottom = 0, top = 1) and feed the sink. */
  private setThrottleFromClientY(clientY: number): void {
    const rect = this.throttleTrack.getBoundingClientRect();
    if (rect.height <= 0) return;
    const v = 1 - (clientY - rect.top) / rect.height;
    this.throttleValue = Math.min(1, Math.max(0, v));
    // Called continuously while dragging — absolute lever position.
    this.sink.setThrottleLever(this.throttleValue);
    this.renderThrottle();
  }

  private renderThrottle(): void {
    this.throttleFill.style.height = `${this.throttleValue * 100}%`;
    this.throttleLabel.textContent = `${Math.round(this.throttleValue * 100)}%`;
  }

  private findTouch(touches: TouchList, id: number | null): Touch | null {
    if (id === null) return null;
    for (let i = 0; i < touches.length; i++) {
      if (touches[i].identifier === id) return touches[i];
    }
    return null;
  }

  /**
   * Show/hide the overlay. Hiding mid-touch releases everything the touch
   * layer holds (tilt, yaw, tracked throttle touch) so no input sticks
   * across a mode/phase switch; the throttle lever itself stays put — it is
   * a persistent setting, not a held input.
   */
  setVisible(visible: boolean): void {
    this.container.style.display = visible ? '' : 'none';
    if (!visible) {
      this.sink.setTiltInput(0, 0);
      this.sink.setYawInput(0);
      this.throttleTouchId = null;
    }
  }

  /** Position of the hover tick mark on the throttle track (0..1). */
  setHoverThrottle(v: number): void {
    const clamped = Math.min(1, Math.max(0, v));
    this.throttleTick.style.bottom = `${clamped * 100}%`;
  }

  /** Reflect hover-hold assist state on the toggle button. */
  setHoverHoldActive(active: boolean): void {
    this.hoverHoldButton.classList.toggle('active', active);
  }

  dispose(): void {
    if (this.joystickManager) {
      this.joystickManager.destroy();
      this.joystickManager = null;
    }
    if (this.container.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }
  }
}
