import { LANDER_CONFIG } from './config';
import type { LanderHudData } from './types';
import './LanderHUD.css';

/**
 * Cockpit instruments HUD (ADR-0003 §4). Pure DOM/CSS overlay — never
 * intercepts input. update() is called every frame and is allocation-light:
 * every readout quantizes its value to display precision first and only
 * touches the DOM (textContent / style / className) when the quantized
 * value actually changed (same idea as Engine.updateStatsDisplay).
 */

/** Full-scale drift on the scope face (m/s); safe ring sits at goodDrift. */
const DRIFT_FULL_SCALE = 3.0;
/** Max dot travel from scope center (px) — matches .hud-drift-scope CSS. */
const DRIFT_TRAVEL_PX = 36;
/** Horizon shift at the pitch clamp (px) — matches .hud-attitude-ball CSS. */
const HORIZON_MAX_SHIFT_PX = 30;
/** Artificial-horizon pitch/roll display clamp (degrees). */
const ATTITUDE_CLAMP_DEG = 30;
/** Pad edge-arrow distance from screen center, in viewport % units. */
const ARROW_EDGE_PCT = 42;

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

function formatDistance(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export class LanderHUD {
  private readonly root: HTMLDivElement;

  // Element refs (cached once at build time)
  private readonly vspeedValue: HTMLElement;
  private readonly altitudeValue: HTMLElement;
  private readonly driftDot: HTMLElement;
  private readonly driftValue: HTMLElement;
  private readonly horizon: HTMLElement;
  private readonly pitchValue: HTMLElement;
  private readonly rollValue: HTMLElement;
  private readonly throttleFill: HTMLElement;
  private readonly hoverTick: HTMLElement;
  private readonly throttleValue: HTMLElement;
  private readonly holdBadge: HTMLElement;
  private readonly fuelFill: HTMLElement;
  private readonly fuelValue: HTMLElement;
  private readonly padMarker: HTMLElement;
  private readonly padMarkerDistance: HTMLElement;
  private readonly padArrow: HTMLElement;
  private readonly padArrowGlyph: HTMLElement;
  private readonly padArrowDistance: HTMLElement;
  private readonly readinessStrip: HTMLElement;
  private readonly pipVspeed: HTMLElement;
  private readonly pipDrift: HTMLElement;
  private readonly pipTilt: HTMLElement;
  private readonly slopeWarning: HTMLElement;

  // Last-rendered quantized values — DOM is only written when these change
  private lastVspeedKey = NaN;
  private lastVspeedBand: string | null = null;
  private lastAltKey = NaN;
  private lastDriftDotKey = NaN;
  private lastDriftValKey = NaN;
  private lastDriftOver: boolean | null = null;
  private lastPitchTenths = NaN;
  private lastRollTenths = NaN;
  private lastPitchDegKey = NaN;
  private lastRollDegKey = NaN;
  private lastThrottlePct = -1;
  private lastHoverPct = -1;
  private lastHold: boolean | null = null;
  private lastFuelPct = -1;
  private lastFuelBand: string | null = null;
  private lastBurnKey = NaN;
  private padMode: 'marker' | 'arrow' | null = null;
  private lastPadXKey = NaN;
  private lastPadYKey = NaN;
  private lastMarkerDistKey = NaN;
  private lastArrowDeg = NaN;
  private lastArrowDistKey = NaN;
  private lastReadinessVisible: boolean | null = null;
  private lastPipMask = -1;
  private lastSlope: boolean | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'lander-hud hidden';

    // --- Center-right primary cluster: vertical speed + altitude ---
    const primary = div('hud-cluster hud-primary', this.root);
    const vs = div('hud-instrument hud-vspeed', primary);
    div('hud-label', vs, 'Vertical speed');
    const vsRow = div('hud-value-row', vs);
    this.vspeedValue = div('hud-vspeed-value', vsRow, '▼ 0.0');
    div('hud-unit', vsRow, 'm/s');
    const alt = div('hud-instrument hud-altitude', primary);
    div('hud-label', alt, 'Altitude');
    const altRow = div('hud-value-row', alt);
    this.altitudeValue = div('hud-altitude-value', altRow, '---');
    div('hud-unit', altRow, 'm');

    // --- Left cluster: drift scope ---
    const drift = div('hud-cluster hud-drift', this.root);
    div('hud-label', drift, 'Drift');
    const scope = div('hud-drift-scope', drift);
    div('hud-drift-ring', scope);
    this.driftDot = div('hud-drift-dot', scope);
    this.driftValue = div('hud-drift-value', drift, '0.0 m/s');

    // --- Bottom center: attitude ball ---
    const attitude = div('hud-cluster hud-attitude', this.root);
    const ball = div('hud-attitude-ball', attitude);
    this.horizon = div('hud-horizon', ball);
    div('hud-attitude-ref', ball);
    const nums = div('hud-attitude-nums', attitude);
    span('hud-att-tag', nums, 'P ');
    this.pitchValue = span('hud-att-num', nums, '+0°');
    span('hud-att-tag', nums, '  R ');
    this.rollValue = span('hud-att-num', nums, '+0°');
    div('hud-label', attitude, 'Attitude');

    // --- Right edge: throttle tape + fuel bar ---
    const right = div('hud-cluster hud-right', this.root);
    const throttle = div('hud-tape hud-throttle', right);
    this.holdBadge = div('hud-hold-badge', throttle, 'HOLD');
    const throttleTrack = div('hud-tape-track', throttle);
    this.throttleFill = div('hud-tape-fill hud-throttle-fill', throttleTrack);
    this.hoverTick = div('hud-hover-tick', throttleTrack);
    this.throttleValue = div('hud-tape-value', throttle, '0%');
    div('hud-tape-label', throttle, 'Thr');
    const fuel = div('hud-tape hud-fuel', right);
    const fuelTrack = div('hud-tape-track', fuel);
    this.fuelFill = div('hud-tape-fill hud-fuel-fill', fuelTrack);
    this.fuelValue = div('hud-tape-value', fuel, '--');
    div('hud-tape-label', fuel, 'Fuel');

    // --- Pad designator: on-screen diamond / off-screen edge arrow ---
    this.padMarker = div('hud-pad-marker hidden', this.root);
    div('hud-pad-diamond', this.padMarker, '◇');
    this.padMarkerDistance = div('hud-pad-distance', this.padMarker);
    this.padArrow = div('hud-pad-arrow hidden', this.root);
    this.padArrowGlyph = div('hud-pad-arrow-glyph', this.padArrow, '▲');
    this.padArrowDistance = div('hud-pad-distance', this.padArrow);

    // --- Readiness strip ---
    this.readinessStrip = div('hud-readiness hidden', this.root);
    this.pipVspeed = this.buildPip('VSPD');
    this.pipDrift = this.buildPip('DRIFT');
    this.pipTilt = this.buildPip('TILT');

    // --- Slope warning ---
    this.slopeWarning = div('hud-slope-warning hidden', this.root, 'SLOPE');

    document.body.appendChild(this.root);
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  /** Render one frame of instrument data. Writes DOM only on value change. */
  update(data: LanderHudData): void {
    this.updateVerticalSpeed(data.verticalSpeed);
    this.updateAltitude(data.altitudeAGL);
    this.updateDrift(data.driftSpeed, data.driftDirection);
    this.updateAttitude(data.pitchDeg, data.rollDeg);
    this.updateThrottle(data.throttle, data.hoverThrottle, data.hoverHold);
    this.updateFuel(data.fuelFraction, data.fuelBurnTimeS);
    this.updatePadDesignator(data);
    this.updateReadiness(data.readiness);
    this.updateSlopeWarning(data.slopeWarning);
  }

  dispose(): void {
    this.root.remove();
  }

  // --- Builders ---

  private buildPip(label: string): HTMLElement {
    const pip = div('hud-pip', this.readinessStrip);
    const dot = div('hud-pip-dot', pip);
    div('hud-pip-label', pip, label);
    return dot;
  }

  // --- Per-instrument updates ---

  private updateVerticalSpeed(v: number): void {
    const up = v >= 0.05;
    const tenths = Math.round(Math.abs(v) * 10);
    const key = up ? tenths + 100000 : tenths;
    if (key !== this.lastVspeedKey) {
      this.lastVspeedKey = key;
      this.vspeedValue.textContent = `${up ? '▲' : '▼'} ${(tenths / 10).toFixed(1)}`;
    }
    // Color-coded against touchdown limits while descending; climbing is neutral
    let band = '';
    if (v < 0) {
      const speed = -v;
      band =
        speed <= LANDER_CONFIG.hud.vspeedGreen
          ? 'band-green'
          : speed <= LANDER_CONFIG.hud.vspeedAmber
            ? 'band-amber'
            : 'band-red';
    }
    if (band !== this.lastVspeedBand) {
      this.lastVspeedBand = band;
      this.vspeedValue.className = band ? `hud-vspeed-value ${band}` : 'hud-vspeed-value';
    }
  }

  private updateAltitude(altitudeAGL: number | null): void {
    // Key encodes null (-1), tenths below 20 m, whole meters (offset) above
    const key =
      altitudeAGL === null
        ? -1
        : altitudeAGL < 20
          ? Math.round(Math.max(0, altitudeAGL) * 10)
          : 1_000_000 + Math.round(altitudeAGL);
    if (key === this.lastAltKey) return;
    this.lastAltKey = key;
    this.altitudeValue.textContent =
      key < 0 ? '---' : key >= 1_000_000 ? String(key - 1_000_000) : (key / 10).toFixed(1);
  }

  private updateDrift(speed: number, direction: number): void {
    // Dot offset: direction is relative to heading, 0 = up on the instrument
    const r = (Math.min(speed, DRIFT_FULL_SCALE) / DRIFT_FULL_SCALE) * DRIFT_TRAVEL_PX;
    const kx = Math.round(Math.sin(direction) * r * 2);
    const ky = Math.round(-Math.cos(direction) * r * 2);
    const dotKey = kx * 1000 + ky;
    if (dotKey !== this.lastDriftDotKey) {
      this.lastDriftDotKey = dotKey;
      this.driftDot.style.transform = `translate(${kx / 2}px, ${ky / 2}px)`;
    }
    const valKey = Math.round(speed * 10);
    if (valKey !== this.lastDriftValKey) {
      this.lastDriftValKey = valKey;
      this.driftValue.textContent = `${(valKey / 10).toFixed(1)} m/s`;
    }
    const over = speed > LANDER_CONFIG.touchdown.goodDrift;
    if (over !== this.lastDriftOver) {
      this.lastDriftOver = over;
      this.driftDot.classList.toggle('over', over);
      this.driftValue.classList.toggle('over', over);
    }
  }

  private updateAttitude(pitchDeg: number, rollDeg: number): void {
    const pitch = Math.max(-ATTITUDE_CLAMP_DEG, Math.min(ATTITUDE_CLAMP_DEG, pitchDeg));
    const roll = Math.max(-ATTITUDE_CLAMP_DEG, Math.min(ATTITUDE_CLAMP_DEG, rollDeg));
    const kp = Math.round(pitch * 10);
    const kr = Math.round(roll * 10);
    if (kp !== this.lastPitchTenths || kr !== this.lastRollTenths) {
      this.lastPitchTenths = kp;
      this.lastRollTenths = kr;
      // Counter-rotate by roll, then shift along the (rotated) vertical by
      // pitch: nose up → horizon slides down, like a real ADI.
      const shift = ((kp / 10) / ATTITUDE_CLAMP_DEG) * HORIZON_MAX_SHIFT_PX;
      this.horizon.style.transform =
        `translate(-50%, -50%) rotate(${-kr / 10}deg) translateY(${shift.toFixed(1)}px)`;
    }
    const pd = Math.round(pitchDeg);
    if (pd !== this.lastPitchDegKey) {
      this.lastPitchDegKey = pd;
      this.pitchValue.textContent = `${pd >= 0 ? '+' : ''}${pd}°`;
    }
    const rd = Math.round(rollDeg);
    if (rd !== this.lastRollDegKey) {
      this.lastRollDegKey = rd;
      this.rollValue.textContent = `${rd >= 0 ? '+' : ''}${rd}°`;
    }
  }

  private updateThrottle(throttle: number, hoverThrottle: number, hoverHold: boolean): void {
    const pct = Math.round(throttle * 100);
    if (pct !== this.lastThrottlePct) {
      this.lastThrottlePct = pct;
      this.throttleFill.style.height = `${pct}%`;
      this.throttleValue.textContent = `${pct}%`;
    }
    const hoverPct = Math.round(Math.max(0, Math.min(1, hoverThrottle)) * 100);
    if (hoverPct !== this.lastHoverPct) {
      this.lastHoverPct = hoverPct;
      this.hoverTick.style.bottom = `${hoverPct}%`;
    }
    if (hoverHold !== this.lastHold) {
      this.lastHold = hoverHold;
      this.holdBadge.classList.toggle('active', hoverHold);
    }
  }

  private updateFuel(fuelFraction: number, burnTimeS: number | null): void {
    const pct = Math.round(Math.max(0, Math.min(1, fuelFraction)) * 100);
    if (pct !== this.lastFuelPct) {
      this.lastFuelPct = pct;
      this.fuelFill.style.height = `${pct}%`;
    }
    const band = pct <= 10 ? 'band-red' : pct <= 25 ? 'band-amber' : '';
    if (band !== this.lastFuelBand) {
      this.lastFuelBand = band;
      this.fuelFill.className = band
        ? `hud-tape-fill hud-fuel-fill ${band}`
        : 'hud-tape-fill hud-fuel-fill';
    }
    const burnKey = burnTimeS === null ? -1 : Math.min(999, Math.round(burnTimeS));
    if (burnKey !== this.lastBurnKey) {
      this.lastBurnKey = burnKey;
      this.fuelValue.textContent = burnKey < 0 ? '--' : `${burnKey}s`;
    }
  }

  private updatePadDesignator(data: LanderHudData): void {
    const ps = data.padScreen;
    if (ps?.onScreen) {
      if (this.padMode !== 'marker') {
        this.padMode = 'marker';
        this.padMarker.classList.remove('hidden');
        this.padArrow.classList.add('hidden');
      }
      // NDC [-1,1] → viewport %, quantized to 0.1%
      const xKey = Math.round((ps.x + 1) * 500);
      const yKey = Math.round((1 - ps.y) * 500);
      if (xKey !== this.lastPadXKey) {
        this.lastPadXKey = xKey;
        this.padMarker.style.left = `${xKey / 10}%`;
      }
      if (yKey !== this.lastPadYKey) {
        this.lastPadYKey = yKey;
        this.padMarker.style.top = `${yKey / 10}%`;
      }
      const distKey = Math.round(data.padDistance);
      if (distKey !== this.lastMarkerDistKey) {
        this.lastMarkerDistKey = distKey;
        this.padMarkerDistance.textContent = formatDistance(data.padDistance);
      }
    } else {
      if (this.padMode !== 'arrow') {
        this.padMode = 'arrow';
        this.padArrow.classList.remove('hidden');
        this.padMarker.classList.add('hidden');
      }
      const deg = Math.round((data.padBearing * 180) / Math.PI);
      if (deg !== this.lastArrowDeg) {
        this.lastArrowDeg = deg;
        // Bearing 0 = ahead = screen-up; place on the edge box, point outward
        const rad = (deg * Math.PI) / 180;
        const dx = Math.sin(rad);
        const dy = -Math.cos(rad);
        const t = ARROW_EDGE_PCT / Math.max(Math.abs(dx), Math.abs(dy), 1e-6);
        this.padArrow.style.left = `${(50 + dx * t).toFixed(1)}%`;
        this.padArrow.style.top = `${(50 + dy * t).toFixed(1)}%`;
        this.padArrowGlyph.style.transform = `rotate(${deg}deg)`;
      }
      const distKey = Math.round(data.padDistance);
      if (distKey !== this.lastArrowDistKey) {
        this.lastArrowDistKey = distKey;
        this.padArrowDistance.textContent = formatDistance(data.padDistance);
      }
    }
  }

  private updateReadiness(readiness: LanderHudData['readiness']): void {
    const visible = readiness !== null;
    if (visible !== this.lastReadinessVisible) {
      this.lastReadinessVisible = visible;
      this.readinessStrip.classList.toggle('hidden', !visible);
    }
    if (readiness === null) return;
    const mask =
      (readiness.vspeed ? 1 : 0) | (readiness.drift ? 2 : 0) | (readiness.tilt ? 4 : 0);
    if (mask === this.lastPipMask) return;
    this.lastPipMask = mask;
    this.pipVspeed.classList.toggle('ok', readiness.vspeed);
    this.pipDrift.classList.toggle('ok', readiness.drift);
    this.pipTilt.classList.toggle('ok', readiness.tilt);
  }

  private updateSlopeWarning(slopeWarning: boolean): void {
    if (slopeWarning === this.lastSlope) return;
    this.lastSlope = slopeWarning;
    this.slopeWarning.classList.toggle('hidden', !slopeWarning);
  }
}
