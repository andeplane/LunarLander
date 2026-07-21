import { LANDER_CONFIG } from './config';
import type { DebriefData, LandingGrade } from './types';
import './LanderScreens.css';

/**
 * Briefing / pause / debrief overlays for the Lander mode (ADR-0004 §2/§3).
 * All three screens are mutually exclusive; showX() hides the others.
 * Keyboard shortcuts (Enter to launch, R / Enter on the debrief) are only
 * listened for while a screen is visible.
 */
export interface LanderScreenCallbacks {
  onLaunch(): void; // briefing → flying
  onResume(): void;
  onRestart(): void;
  onBackToMenu(): void; // pause
  onRetry(): void;
  onNextMission(): void;
  onDebriefMenu(): void; // debrief
}

type ScreenName = 'briefing' | 'pause' | 'debrief';

const GRADE_LABEL: Record<LandingGrade, string> = {
  perfect: 'PERFECT LANDING!',
  good: 'GOOD LANDING',
  hard: 'HARD LANDING',
  crash: 'CRASHED',
};

const KEYBOARD_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['W / S', 'Tilt forward / back'],
  ['A / D', 'Tilt left / right'],
  ['Q / E', 'Yaw'],
  ['↑ / ↓', 'Throttle'],
  ['Space', 'Full thrust'],
  ['X', 'Cut throttle'],
  ['H', 'Hover-hold assist'],
  ['C', 'Cycle camera'],
];

const TOUCH_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['Right stick', 'Tilt — release to auto-level'],
  ['Left slider', 'Throttle (sticky lever)'],
  ['⟲ ⟳', 'Yaw'],
  ['HOLD', 'Hover-hold assist'],
];

function div(className: string, parent: HTMLElement, text = ''): HTMLDivElement {
  const e = document.createElement('div');
  e.className = className;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function span(className: string, parent: HTMLElement, text = ''): HTMLSpanElement {
  const e = document.createElement('span');
  e.className = className;
  if (text) e.textContent = text;
  parent.appendChild(e);
  return e;
}

function button(
  className: string,
  parent: HTMLElement,
  label: string,
  onClick: () => void
): HTMLButtonElement {
  const e = document.createElement('button');
  e.className = className;
  e.type = 'button';
  e.textContent = label;
  e.addEventListener('click', onClick);
  parent.appendChild(e);
  return e;
}

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

function formatMultiplier(m: number): string {
  return Number.isInteger(m) ? String(m) : m.toFixed(1);
}

function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

export class LanderScreens {
  private readonly callbacks: LanderScreenCallbacks;
  private readonly root: HTMLDivElement;
  private readonly briefingScreen: HTMLDivElement;
  private readonly pauseScreen: HTMLDivElement;
  private readonly debriefScreen: HTMLDivElement;

  private readonly briefingTitle: HTMLElement;
  private readonly statFuel: HTMLElement;
  private readonly statDistance: HTMLElement;
  private readonly statMultiplier: HTMLElement;
  private readonly launchButton: HTMLButtonElement;
  private readonly debriefContent: HTMLDivElement;
  private retryButton!: HTMLButtonElement;
  private nextButton!: HTMLButtonElement;

  private active: ScreenName | null = null;
  private terrainReady = false;
  private readonly keyHandler = (e: KeyboardEvent): void => this.handleKey(e);

  constructor(callbacks: LanderScreenCallbacks) {
    this.callbacks = callbacks;
    this.root = document.createElement('div');
    this.root.className = 'lander-screens';

    // --- Briefing ---
    this.briefingScreen = div('lander-screen screen-briefing hidden', this.root);
    const briefingPanel = div('screen-panel', this.briefingScreen);
    div('screen-kicker', briefingPanel, 'Lunar descent');
    this.briefingTitle = div('screen-title', briefingPanel, 'MISSION 1');
    div(
      'screen-objective',
      briefingPanel,
      'Land on the marked pad — or find your own site.'
    );
    const stats = div('briefing-stats', briefingPanel);
    this.statFuel = this.buildStat(stats, 'Fuel');
    this.statDistance = this.buildStat(stats, 'Pad distance');
    this.statMultiplier = this.buildStat(stats, 'Multiplier');
    const controls = div('briefing-controls', briefingPanel);
    const grid = div('controls-grid', controls);
    for (const [key, action] of isTouchDevice() ? TOUCH_CONTROLS : KEYBOARD_CONTROLS) {
      span('key', grid, key);
      span('action', grid, action);
    }
    this.launchButton = button('screen-button primary launch-button', briefingPanel, 'LAUNCH', () => {
      if (this.terrainReady) this.callbacks.onLaunch();
    });
    div('screen-hint', briefingPanel, 'Enter to launch');

    // --- Pause ---
    this.pauseScreen = div('lander-screen screen-pause hidden', this.root);
    const pausePanel = div('screen-panel', this.pauseScreen);
    div('screen-title', pausePanel, 'PAUSED');
    const pauseButtons = div('screen-buttons', pausePanel);
    button('screen-button primary', pauseButtons, 'Resume', () => this.callbacks.onResume());
    button('screen-button', pauseButtons, 'Restart Mission', () => this.callbacks.onRestart());
    button('screen-button', pauseButtons, 'Back to Menu', () => this.callbacks.onBackToMenu());
    div('screen-hint', pausePanel, 'Esc to resume');

    // --- Debrief ---
    this.debriefScreen = div('lander-screen screen-debrief hidden', this.root);
    const debriefPanel = div('screen-panel debrief-panel', this.debriefScreen);
    this.debriefContent = div('debrief-content', debriefPanel);
    const debriefButtons = div('screen-buttons debrief-buttons', debriefPanel);
    this.retryButton = button('screen-button', debriefButtons, 'Retry', () =>
      this.callbacks.onRetry()
    );
    span('button-key', this.retryButton, 'R');
    this.nextButton = button('screen-button primary', debriefButtons, 'Next Mission', () =>
      this.callbacks.onNextMission()
    );
    span('button-key', this.nextButton, 'Enter');
    button('screen-button', debriefButtons, 'Menu', () => this.callbacks.onDebriefMenu());

    document.body.appendChild(this.root);
  }

  showBriefing(
    missionIndex: number,
    opts: { preparingTerrain: boolean; fuelKg: number; padDistanceM: number; padMultiplier: number }
  ): void {
    this.briefingTitle.textContent = `MISSION ${missionIndex + 1}`;
    this.statFuel.textContent = `${Math.round(opts.fuelKg)} kg`;
    this.statDistance.textContent = formatDistance(opts.padDistanceM);
    this.statMultiplier.textContent = `×${formatMultiplier(opts.padMultiplier)}`;
    this.setLaunchReady(!opts.preparingTerrain);
    this.setActive('briefing');
  }

  updateBriefing(opts: { preparingTerrain: boolean }): void {
    this.setLaunchReady(!opts.preparingTerrain);
  }

  showPause(): void {
    this.setActive('pause');
  }

  showDebrief(data: DebriefData): void {
    this.populateDebrief(data);
    // After a crash the natural action is Retry; after a landing, advance
    const crashed = data.score.grade === 'crash';
    this.retryButton.classList.toggle('primary', crashed);
    this.nextButton.classList.toggle('primary', !crashed);
    this.setActive('debrief');
  }

  hideAll(): void {
    this.setActive(null);
  }

  dispose(): void {
    this.hideAll();
    this.root.remove();
  }

  // --- Internals ---

  private buildStat(parent: HTMLElement, label: string): HTMLElement {
    const cell = div('stat-cell', parent);
    const value = div('stat-value', cell, '—');
    div('stat-label', cell, label);
    return value;
  }

  private setLaunchReady(ready: boolean): void {
    this.terrainReady = ready;
    this.launchButton.disabled = !ready;
    this.launchButton.textContent = ready ? 'LAUNCH' : 'Preparing terrain…';
  }

  private setActive(name: ScreenName | null): void {
    this.active = name;
    this.briefingScreen.classList.toggle('hidden', name !== 'briefing');
    this.pauseScreen.classList.toggle('hidden', name !== 'pause');
    this.debriefScreen.classList.toggle('hidden', name !== 'debrief');
    if (name !== null) {
      // Adding the same listener reference twice is a no-op
      document.addEventListener('keydown', this.keyHandler);
    } else {
      document.removeEventListener('keydown', this.keyHandler);
    }
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.active === 'briefing') {
      if (e.key === 'Enter' && this.terrainReady) {
        e.preventDefault();
        this.callbacks.onLaunch();
      }
    } else if (this.active === 'debrief') {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.callbacks.onNextMission();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        this.callbacks.onRetry();
      }
    }
    // Pause: Esc is owned by LanderMode's input handling; hint only.
  }

  private populateDebrief(data: DebriefData): void {
    const { score, stats } = data;
    const c = this.debriefContent;
    c.textContent = ''; // rebuild (infrequent — once per landing)

    div(`debrief-grade grade-${score.grade}`, c, GRADE_LABEL[score.grade]);
    const starsRow = div('debrief-stars', c);
    span('stars-filled', starsRow, '★'.repeat(score.stars));
    span('stars-empty', starsRow, '★'.repeat(3 - score.stars));
    if (data.isNewBest) {
      div('new-best-badge', c, 'NEW BEST');
    }

    // Per-factor table
    const table = document.createElement('table');
    table.className = 'debrief-table';
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    c.appendChild(table);
    const row = (factor: string, value: string, points: string, pointsClass = ''): void => {
      const tr = document.createElement('tr');
      const tdFactor = document.createElement('td');
      tdFactor.className = 'td-factor';
      tdFactor.textContent = factor;
      const tdValue = document.createElement('td');
      tdValue.className = 'td-value';
      tdValue.textContent = value;
      const tdPoints = document.createElement('td');
      tdPoints.className = pointsClass ? `td-points ${pointsClass}` : 'td-points';
      tdPoints.textContent = points;
      tr.append(tdFactor, tdValue, tdPoints);
      tbody.appendChild(tr);
    };

    const limits = LANDER_CONFIG.touchdown;
    const check = (ok: boolean): readonly [string, string] =>
      ok ? ['✓', 'ok'] : ['✗', 'bad'];
    row('Touchdown', score.grade, `+${score.touchdownPoints}`);
    row('Vertical speed', `${stats.maxVerticalSpeed.toFixed(1)} m/s`, `+${Math.round(score.softness)}`);
    const [driftMark, driftCls] = check(stats.maxDriftSpeed <= limits.goodDrift);
    row('Drift', `${stats.maxDriftSpeed.toFixed(1)} m/s`, driftMark, driftCls);
    const [tiltMark, tiltCls] = check(stats.maxTiltDeg <= limits.goodTiltDeg);
    row('Tilt', `${stats.maxTiltDeg.toFixed(0)}°`, tiltMark, tiltCls);
    if (stats.onPad) {
      row('Precision', `${stats.distanceToPadCenter.toFixed(1)} m from center`, `+${Math.round(score.precision)}`);
    } else {
      row('Site quality', `${Math.round(stats.siteQuality * 100)}%`, `+${Math.round(score.precision)}`);
    }
    row('Fuel remaining', `${Math.round(stats.fuelFraction * 100)}%`, `+${Math.round(score.fuelBonus)}`);

    // Multipliers + total
    const totals = div('debrief-totals', c);
    const totalRow = (label: string, value: string, extraClass = ''): void => {
      const r = div(extraClass ? `debrief-total-row ${extraClass}` : 'debrief-total-row', totals);
      span('total-label', r, label);
      span('total-value', r, value);
    };
    totalRow('Base score', String(Math.round(score.base)));
    if (score.padMultiplier !== 1) {
      totalRow('Pad multiplier', `×${formatMultiplier(score.padMultiplier)}`);
    }
    if (score.assistMultiplier !== 1) {
      totalRow('Hover-hold assist', `×${formatMultiplier(score.assistMultiplier)}`);
    }
    if (score.instrumentsBonus > 0) {
      totalRow('Instruments only', `+${score.instrumentsBonus}`);
    }
    totalRow('TOTAL', String(score.total), 'debrief-total');

    // Best-score comparison
    const best = div('debrief-best', c);
    if (data.bestScore === null) {
      best.textContent = 'First landing on this mission';
    } else {
      const bestStars = data.bestStars ? ` ${'★'.repeat(data.bestStars)}` : '';
      best.textContent = `Best: ${data.bestScore}${bestStars}`;
    }
  }
}
