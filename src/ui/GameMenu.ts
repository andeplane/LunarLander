import type { PlayerSettings, ShadowQuality } from '../core/PlayerSettings';
import './GameMenu.css';

interface MenuActions {
  canPause(): boolean;
  setPaused(paused: boolean): void;
  resume(): void;
  mainMenu(): void;
  shadowQuality(quality: ShadowQuality): void;
  isMuted(): boolean;
  mute(muted: boolean): void;
}

const tabs = ['General', 'Video', 'Audio'] as const;
type Tab = (typeof tabs)[number];

export class GameMenu {
  private readonly dialog = document.createElement('dialog');
  private page: 'pause' | 'settings' = 'pause';
  private fromGame = false;

  constructor(
    private readonly settings: PlayerSettings,
    private readonly actions: MenuActions
  ) {
    this.dialog.className = 'game-dialog';
    this.dialog.setAttribute('aria-labelledby', 'game-dialog-title');
    document.body.append(this.dialog);
    // Keep game shortcuts and orbit gestures out of controls inside the dialog.
    for (const type of ['keydown', 'keyup', 'wheel', 'pointerdown', 'pointermove']) {
      this.dialog.addEventListener(type, (event) => event.stopPropagation());
    }
    this.dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      this.back();
    });
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape' || (!this.dialog.open && !actions.canPause())) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat) return;
        if (this.dialog.open) this.back();
        else this.pause();
      },
      true
    );
  }

  private control<T extends HTMLElement>(selector: string): T {
    const element = this.dialog.querySelector<T>(selector);
    if (!element) throw new Error(`Missing menu control ${selector}`);
    return element;
  }

  pause(): void {
    if (this.dialog.open || !this.actions.canPause()) return;
    this.fromGame = true;
    this.actions.setPaused(true);
    if (document.pointerLockElement) document.exitPointerLock();
    this.showPause();
  }

  private showPause(): void {
    this.page = 'pause';
    this.dialog.innerHTML = `<h2 id="game-dialog-title">Paused</h2>
      <div class="pause-actions">
        <button class="primary" type="button">Continue</button>
        <button type="button">Settings</button>
        <button type="button">Main menu</button>
      </div>`;
    const [resume, settings, menu] = this.dialog.querySelectorAll('button');
    resume.onclick = () => this.back();
    settings.onclick = () => this.showSettings();
    menu.onclick = () => {
      this.dialog.close();
      this.actions.mainMenu();
      this.actions.setPaused(false);
      this.fromGame = false;
    };
    if (!this.dialog.open) this.dialog.showModal();
    resume.focus();
  }

  showSettings(): void {
    this.page = 'settings';
    this.dialog.innerHTML = `<h2 id="game-dialog-title">Settings</h2>
      <div class="settings-tabs" role="tablist" aria-label="Settings categories"></div>
      <div id="settings-panel" role="tabpanel"></div>
      <button type="button" class="settings-back">Back</button>`;
    const list = this.control('[role=tablist]');
    for (const name of tabs) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = `settings-tab-${name}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'settings-panel');
      tab.textContent = name;
      tab.onclick = () => this.selectTab(name);
      tab.onkeydown = (event) => {
        const index = tabs.indexOf(name);
        const next = { ArrowLeft: (index + 2) % 3, ArrowRight: (index + 1) % 3, Home: 0, End: 2 }[
          event.key
        ];
        if (next === undefined) return;
        event.preventDefault();
        this.selectTab(tabs[next]);
      };
      list.append(tab);
    }
    this.control<HTMLButtonElement>('.settings-back').onclick = () => this.back();
    if (!this.dialog.open) this.dialog.showModal();
    this.selectTab('General');
  }

  private selectTab(name: Tab): void {
    const panel = this.control('#settings-panel');
    panel.setAttribute('aria-labelledby', `settings-tab-${name}`);
    for (const tab of this.dialog.querySelectorAll<HTMLButtonElement>('[role=tab]')) {
      const selected = tab.textContent === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected) tab.focus();
    }
    if (name === 'Video') {
      panel.innerHTML = `<label class="setting-row"><span>Rover shadow quality</span>
        <select aria-describedby="setting-detail"><option value="performance">Performance</option>
        <option value="balanced">Balanced</option><option value="high">High</option></select></label>
        <p id="setting-detail">Higher quality gives cockpit and ground shadows finer edges.</p>`;
      const select = this.control<HTMLSelectElement>('select');
      select.value = this.settings.shadowQuality;
      select.onchange = () => {
        this.settings.shadowQuality = select.value as ShadowQuality;
        this.actions.shadowQuality(this.settings.shadowQuality);
        this.settings.save();
      };
      return;
    }
    const general = name === 'General';
    panel.innerHTML = `<label class="setting-row"><span>${general ? 'Cockpit mouse look' : 'Mute sound'}</span>
      <input type="checkbox" aria-describedby="setting-detail"></label>
      <p id="setting-detail">${general ? 'Move the mouse to look around from the rover seat.' : 'Applies to lander engines, thrusters and impacts.'}</p>`;
    const input = this.control<HTMLInputElement>('input');
    input.checked = general ? this.settings.cockpitLook : this.actions.isMuted();
    input.onchange = () => {
      if (general) {
        this.settings.cockpitLook = input.checked;
        this.settings.save();
      } else {
        this.actions.mute(input.checked);
      }
    };
  }

  private back(): void {
    if (this.page === 'settings' && this.fromGame) {
      this.showPause();
      this.dialog.querySelectorAll('button')[1].focus();
      return;
    }
    this.dialog.close();
    if (this.fromGame) {
      this.fromGame = false;
      this.actions.setPaused(false);
      this.actions.resume();
    }
  }
}
