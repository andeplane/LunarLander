import { Vector3, type PerspectiveCamera } from 'three';
import type { GameMode } from './ModeManager';
import './MenuMode.css';

/**
 * The main menu: a DOM overlay over the live world, with a slow camera
 * drift behind it. Owning the drift keeps render-on-demand alive while
 * the menu is up (the camera changes every frame → Engine renders).
 */
export class MenuMode implements GameMode {
  private camera: PerspectiveCamera;
  private overlay: HTMLDivElement | null = null;
  private onSelectExplore: () => void;
  private onSelectLander: () => void;
  private requestRender: () => void;

  /** Yaw drift speed in radians/second (one lazy orbit ≈ 7 minutes). */
  private static readonly DRIFT_RATE = 0.015;

  private static readonly UP = new Vector3(0, 1, 0);

  constructor(
    camera: PerspectiveCamera,
    callbacks: {
      onSelectExplore: () => void;
      onSelectLander: () => void;
      requestRender: () => void;
    }
  ) {
    this.camera = camera;
    this.onSelectExplore = callbacks.onSelectExplore;
    this.onSelectLander = callbacks.onSelectLander;
    this.requestRender = callbacks.requestRender;
  }

  enter(): void {
    this.overlay = this.buildOverlay();
    document.body.appendChild(this.overlay);
  }

  exit(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  update(deltaTime: number): void {
    // Slow yaw drift on the world's up axis; position stays put, so there
    // is no terrain-collision risk regardless of where the camera was left.
    this.camera.rotateOnWorldAxis(MenuMode.UP, MenuMode.DRIFT_RATE * deltaTime);
    // The per-frame rotation is far below Engine.hasCameraChanged()'s
    // quaternion threshold — without an explicit request, renders fire only
    // every ~2 s and the menu background visibly ticks at "1 fps".
    this.requestRender();
  }

  private buildOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.className = 'menu-overlay';

    const title = document.createElement('div');
    title.className = 'menu-title';
    title.textContent = 'LUNAR EXPLORER';

    const subtitle = document.createElement('div');
    subtitle.className = 'menu-subtitle';
    subtitle.textContent = 'A procedural Moon, yours to fly';

    const buttons = document.createElement('div');
    buttons.className = 'menu-buttons';

    const exploreBtn = document.createElement('button');
    exploreBtn.className = 'menu-button';
    exploreBtn.innerHTML = '<span class="menu-button-name">Explore</span><span class="menu-button-desc">Free flight over the lunar surface</span>';
    exploreBtn.addEventListener('click', () => this.onSelectExplore());

    const landerBtn = document.createElement('button');
    landerBtn.className = 'menu-button';
    landerBtn.innerHTML = '<span class="menu-button-name">Fly the Lander</span><span class="menu-button-desc">Land on the Moon — from inside the cockpit</span>';
    landerBtn.addEventListener('click', () => this.onSelectLander());

    buttons.appendChild(exploreBtn);
    buttons.appendChild(landerBtn);
    overlay.appendChild(title);
    overlay.appendChild(subtitle);
    overlay.appendChild(buttons);
    return overlay;
  }
}
