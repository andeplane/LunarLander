import './RoverHUD.css';

export class RoverHUD {
  readonly root = document.createElement('section');
  private readonly pointers = new Map<number, string>();
  private readonly speed: HTMLElement;
  private readonly distance: HTMLElement;
  private readonly heading: HTMLElement;
  readonly status: HTMLElement;
  private readonly lookHint: HTMLElement;
  private readonly camera: HTMLButtonElement;
  private readonly clear = () => this.pointers.clear();

  constructor(onCamera: () => void, onRecover: () => void, onExit: () => void, touch: boolean) {
    this.root.className = 'rover-hud';
    this.root.setAttribute('aria-label', 'Lunar roving vehicle');
    this.root.innerHTML = `<div class="rover-actions">
      <button type="button" data-action="menu">Menu</button>
      <button type="button" data-action="camera">Driver view</button>
      <button type="button" data-action="recover">Recover</button>
    </div>
    <div class="rover-status" role="status"></div>
    <div class="rover-instruments">
      <div class="rover-speed"><strong>0.0</strong> km/h</div>
      <div class="rover-readings"><span>Trip <b>0 m</b></span><span>Heading <b>000°</b></span></div>
    </div>
    <div class="rover-keys"><kbd>W</kbd><kbd>S</kbd> Drive <kbd>A</kbd><kbd>D</kbd> Steer <kbd>Space</kbd> Brake <span>Drag to orbit</span></div>`;
    const q = <T extends HTMLElement>(selector: string) => {
      const el = this.root.querySelector<T>(selector);
      if (!el) throw new Error(`Missing rover control ${selector}`);
      return el;
    };
    this.lookHint = q('.rover-keys span');
    this.speed = q('.rover-speed strong');
    [this.distance, this.heading] = this.root.querySelectorAll<HTMLElement>('.rover-readings b');
    this.status = q('.rover-status');
    this.camera = q('[data-action=camera]');
    this.camera.onclick = onCamera;
    q('[data-action=recover]').onclick = onRecover;
    q('[data-action=menu]').onclick = onExit;
    if (touch) {
      this.root.classList.add('has-touch');
      const pad = document.createElement('div');
      pad.className = 'rover-pedals';
      for (const [action, label] of [
        ['left', 'Left'],
        ['right', 'Right'],
        ['reverse', 'Reverse'],
        ['brake', 'Brake'],
        ['drive', 'Drive'],
      ]) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.onpointerdown = (e) => {
          e.preventDefault();
          btn.setPointerCapture(e.pointerId);
          this.pointers.set(e.pointerId, action);
        };
        btn.onlostpointercapture = (e) => this.pointers.delete(e.pointerId);
        pad.append(btn);
      }
      this.root.append(pad);
    }
    window.addEventListener('blur', this.clear);
    document.addEventListener('visibilitychange', this.clear);
    document.body.append(this.root);
  }

  held(action: string) {
    for (const value of this.pointers.values()) if (value === action) return true;
    return false;
  }
  setCamera(cab: boolean, mouseLook: boolean) {
    this.root.classList.toggle('driver-view', cab);
    this.lookHint.hidden = cab && !mouseLook;
    this.lookHint.textContent = cab ? 'Move mouse to look' : 'Drag to orbit';
    this.camera.textContent = cab ? 'Chase view' : 'Driver view';
  }
  update(speed: number, distance: number, bearing: number) {
    this.speed.textContent = (Math.abs(speed) * 3.6).toFixed(1);
    this.distance.textContent =
      distance < 1000 ? `${Math.round(distance)} m` : `${(distance / 1000).toFixed(2)} km`;
    this.heading.textContent = `${String((Math.round(bearing) + 360) % 360).padStart(3, '0')}°`;
  }
  dispose() {
    window.removeEventListener('blur', this.clear);
    document.removeEventListener('visibilitychange', this.clear);
    this.root.remove();
  }
}
