/**
 * Procedural lander sound (ADR-0003 §5 follow-up). Everything is synthesised
 * with Web Audio — no sample files — so the bundle stays asset-free:
 *
 * - **Engine**: looped noise through a low-pass filter plus a sub-bass
 *   rumble oscillator. Gain and filter cutoff follow the *effective*
 *   throttle (Space full-thrust / hover-hold included), so more throttle is
 *   both louder and brighter.
 * - **RCS**: band-passed hiss whose level follows the attitude command
 *   magnitude — the thrusters "chatter" while you tilt or yaw.
 * - **Touchdown**: a low thud on first leg contact, scaled by impact speed.
 * - **Crash**: layered crack + long bang + sub thump + metallic ring + debris,
 *   pushed through a compressor on the master so it hits hard, not clipped.
 *
 * Browsers only start an AudioContext after a user gesture, so the context
 * is created lazily by `unlock()` (called from LAUNCH, which is always a
 * click / key press). Every method is safe to call before that — it just
 * does nothing. The context factory is injectable for tests.
 */

const MUTE_STORAGE_KEY = 'lander.audio.muted';

/** Master output level (0..1). */
const MASTER_GAIN = 0.8;
/** Engine noise level at full throttle. */
const ENGINE_NOISE_GAIN = 0.55;
/** Engine sub-bass rumble level at full throttle. */
const ENGINE_RUMBLE_GAIN = 0.35;
/** Low-pass cutoff (Hz) at idle → full throttle. */
const ENGINE_CUTOFF_MIN = 120;
const ENGINE_CUTOFF_MAX = 900;
/** Rumble oscillator frequency (Hz) at idle → full throttle. */
const ENGINE_RUMBLE_HZ_MIN = 38;
const ENGINE_RUMBLE_HZ_MAX = 55;
/** Smoothing time constant (s) for throttle-driven params. */
const ENGINE_SMOOTHING = 0.08;
/** RCS hiss level at full attitude command. */
const RCS_GAIN = 0.18;
const RCS_SMOOTHING = 0.04;
/** Touchdown thud: impact speed (m/s, positive down) that maps to full level. */
const TOUCHDOWN_FULL_SPEED = 3;
const TOUCHDOWN_MIN_GAIN = 0.25;
/** Crash: peak level of the layered bang (>1 — the master compressor tames it). */
const CRASH_GAIN = 3.0;
const CRASH_DURATION = 2.6;
/** Number of debris rattles scattered over the tail of the crash. */
const CRASH_DEBRIS_HITS = 7;

/** Minimal subset of AudioContext that the module uses (mockable). */
export type AudioContextLike = Pick<
  AudioContext,
  | 'currentTime'
  | 'sampleRate'
  | 'state'
  | 'destination'
  | 'createGain'
  | 'createBufferSource'
  | 'createBuffer'
  | 'createBiquadFilter'
  | 'createOscillator'
  | 'createDynamicsCompressor'
  | 'resume'
  | 'suspend'
  | 'close'
>;

export type AudioContextFactory = () => AudioContextLike | null;

function defaultContextFactory(): AudioContextLike | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* private mode / quota — mute state just isn't remembered */
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class LanderAudio {
  private readonly createContext: AudioContextFactory;
  private ctx: AudioContextLike | null = null;

  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private rumbleGain: GainNode | null = null;
  private rumbleOsc: OscillatorNode | null = null;
  private rcsGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private muted: boolean;
  private paused = false;
  private disposed = false;

  constructor(createContext: AudioContextFactory = defaultContextFactory) {
    this.createContext = createContext;
    this.muted = loadMuted();
  }

  /**
   * Create the context and the always-running engine/RCS graph. Must be
   * called from a user gesture the first time; later calls just resume a
   * suspended context.
   */
  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      this.ctx = this.createContext();
      if (!this.ctx) return;
      this.buildGraph(this.ctx);
    }
    if (!this.paused && this.ctx.state !== 'running') {
      void this.ctx.resume().catch(() => {});
    }
  }

  isReady(): boolean {
    return this.ctx !== null;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    saveMuted(muted);
    this.applyMaster();
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /** Suspend everything while the game is paused (and resume after). */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!this.ctx) return;
    if (paused) {
      void this.ctx.suspend().catch(() => {});
    } else {
      void this.ctx.resume().catch(() => {});
    }
  }

  /**
   * Per-frame continuous sources.
   * @param throttle effective main-engine throttle 0..1
   * @param rcs attitude command magnitude 0..1
   */
  update(throttle: number, rcs: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineGain || !this.engineFilter || !this.rumbleGain || !this.rumbleOsc || !this.rcsGain) {
      return;
    }
    const t = clamp01(throttle);
    const now = ctx.currentTime;
    // Perceptual loudness: a gentle curve so 20 % throttle is clearly audible
    const level = Math.pow(t, 0.7);
    this.engineGain.gain.setTargetAtTime(level * ENGINE_NOISE_GAIN, now, ENGINE_SMOOTHING);
    this.engineFilter.frequency.setTargetAtTime(
      ENGINE_CUTOFF_MIN + (ENGINE_CUTOFF_MAX - ENGINE_CUTOFF_MIN) * t,
      now,
      ENGINE_SMOOTHING
    );
    this.rumbleGain.gain.setTargetAtTime(level * ENGINE_RUMBLE_GAIN, now, ENGINE_SMOOTHING);
    this.rumbleOsc.frequency.setTargetAtTime(
      ENGINE_RUMBLE_HZ_MIN + (ENGINE_RUMBLE_HZ_MAX - ENGINE_RUMBLE_HZ_MIN) * t,
      now,
      ENGINE_SMOOTHING
    );
    this.rcsGain.gain.setTargetAtTime(clamp01(rcs) * RCS_GAIN, now, RCS_SMOOTHING);
  }

  /** Cut all continuous sources immediately (mission select, exit). */
  silence(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const g of [this.engineGain, this.rumbleGain, this.rcsGain]) {
      if (!g) continue;
      g.gain.cancelScheduledValues(now);
      g.gain.setValueAtTime(0, now);
    }
  }

  /** Leg contact thud; `impactSpeed` is m/s positive down. */
  touchdown(impactSpeed: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const strength =
      TOUCHDOWN_MIN_GAIN + (1 - TOUCHDOWN_MIN_GAIN) * clamp01(impactSpeed / TOUCHDOWN_FULL_SPEED);
    const now = ctx.currentTime;

    // Low sine sweep 90 → 35 Hz: the structure taking the load
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.25);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.9 * strength, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + 0.5);

    // Short dull click of the pads
    this.noiseBurst(now, 0.12, 0.35 * strength, 400, 'lowpass');
  }

  /**
   * Hull impact / tip-over. Layered so it reads as a real wreck, not a
   * bump: a sharp crack, a long low bang that darkens as it decays, a
   * heavy sub thump, a metallic ring of the structure, and debris
   * rattling down over the tail. Levels sum well above 1 on purpose —
   * the compressor on the master turns that into loudness, not clipping.
   */
  crash(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const now = ctx.currentTime;
    this.silence();

    // Crack: bright, instantaneous
    this.noiseBurst(now, 0.08, CRASH_GAIN, 6000, 'highpass');
    // Bang: full-band noise sweeping dark over the whole crash
    this.noiseBurst(now, CRASH_DURATION, CRASH_GAIN, 4000, 'lowpass', 60);
    // Body: mid-band boom that lingers under the bang
    this.noiseBurst(now + 0.02, 1.2, CRASH_GAIN * 0.7, 250, 'lowpass');

    // Sub thump: 90 → 18 Hz
    const thump = ctx.createOscillator();
    thump.type = 'triangle';
    thump.frequency.setValueAtTime(90, now);
    thump.frequency.exponentialRampToValueAtTime(18, now + 1.4);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(CRASH_GAIN, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
    thump.connect(thumpGain).connect(this.master);
    thump.start(now);
    thump.stop(now + 1.9);

    // Metallic ring: slightly inharmonic partials of the buckling structure
    for (const hz of [180, 470, 1130]) {
      const ring = ctx.createOscillator();
      ring.type = 'square';
      ring.frequency.setValueAtTime(hz * 1.03, now);
      ring.frequency.exponentialRampToValueAtTime(hz, now + 0.6);
      const ringGain = ctx.createGain();
      ringGain.gain.setValueAtTime(0.25 * CRASH_GAIN, now + 0.01);
      ringGain.gain.exponentialRampToValueAtTime(0.001, now + 0.9);
      ring.connect(ringGain).connect(this.master);
      ring.start(now);
      ring.stop(now + 1.0);
    }

    // Debris: short rattles scattered over the tail, decaying in level
    for (let i = 0; i < CRASH_DEBRIS_HITS; i++) {
      const at = now + 0.25 + i * 0.22 + (i % 2) * 0.07;
      const level = CRASH_GAIN * 0.5 * (1 - i / CRASH_DEBRIS_HITS);
      this.noiseBurst(at, 0.09, level, 1500 + (i % 3) * 600, 'bandpass');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.silence();
    try {
      this.rumbleOsc?.stop();
    } catch {
      /* already stopped */
    }
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.rumbleGain = null;
    this.rumbleOsc = null;
    this.rcsGain = null;
    this.noiseBuffer = null;
  }

  // ---- internals ----

  private buildGraph(ctx: AudioContextLike): void {
    // master → compressor → out: the crash stacks several sources above
    // unity gain; the compressor turns that into impact instead of clipping
    this.master = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.25;
    this.master.connect(limiter).connect(ctx.destination);
    this.applyMaster();

    this.noiseBuffer = this.makeNoiseBuffer(ctx);

    // Engine: noise → low-pass → gain → master
    const engineSrc = ctx.createBufferSource();
    engineSrc.buffer = this.noiseBuffer;
    engineSrc.loop = true;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = ENGINE_CUTOFF_MIN;
    this.engineFilter.Q.value = 0.7;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    engineSrc.connect(this.engineFilter).connect(this.engineGain).connect(this.master);
    engineSrc.start();

    // Sub-bass rumble
    this.rumbleOsc = ctx.createOscillator();
    this.rumbleOsc.type = 'sawtooth';
    this.rumbleOsc.frequency.value = ENGINE_RUMBLE_HZ_MIN;
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = 110;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleOsc.connect(rumbleFilter).connect(this.rumbleGain).connect(this.master);
    this.rumbleOsc.start();

    // RCS: noise → band-pass hiss → gain → master
    const rcsSrc = ctx.createBufferSource();
    rcsSrc.buffer = this.noiseBuffer;
    rcsSrc.loop = true;
    const rcsFilter = ctx.createBiquadFilter();
    rcsFilter.type = 'bandpass';
    rcsFilter.frequency.value = 2200;
    rcsFilter.Q.value = 0.9;
    this.rcsGain = ctx.createGain();
    this.rcsGain.gain.value = 0;
    rcsSrc.connect(rcsFilter).connect(this.rcsGain).connect(this.master);
    rcsSrc.start();
  }

  private applyMaster(): void {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_GAIN, this.ctx.currentTime, 0.02);
  }

  /** Two seconds of white noise, looped by the continuous sources. */
  private makeNoiseBuffer(ctx: AudioContextLike): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** One-shot filtered noise with an exponential decay. */
  private noiseBurst(
    at: number,
    duration: number,
    gainLevel: number,
    cutoffHz: number,
    type: BiquadFilterType,
    sweepToHz?: number
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noiseBuffer) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(cutoffHz, at);
    if (sweepToHz !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(sweepToHz, at + duration);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainLevel, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(at);
    src.stop(at + duration + 0.05);
  }
}
