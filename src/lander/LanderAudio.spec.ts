import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanderAudio, type AudioContextLike } from './LanderAudio';

/** Records AudioParam automation so tests can read the last scheduled target. */
class FakeParam {
  value = 0;
  targets: number[] = [];
  setTargetAtTime = vi.fn((v: number) => {
    this.targets.push(v);
    return this;
  });
  setValueAtTime = vi.fn((v: number) => {
    this.targets.push(v);
    return this;
  });
  exponentialRampToValueAtTime = vi.fn(() => this);
  cancelScheduledValues = vi.fn(() => this);
  last(): number {
    return this.targets[this.targets.length - 1];
  }
}

class FakeNode {
  connected: FakeNode[] = [];
  connect = vi.fn((n: FakeNode) => {
    this.connected.push(n);
    return n;
  });
  start = vi.fn();
  stop = vi.fn();
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam();
  Q = new FakeParam();
}
class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}
class FakeSource extends FakeNode {
  buffer: unknown = null;
  loop = false;
}

class FakeContext {
  currentTime = 0;
  sampleRate = 8000;
  state: AudioContextState = 'suspended';
  destination = new FakeNode();
  gains: FakeGain[] = [];
  oscillators: FakeOsc[] = [];
  sources: FakeSource[] = [];
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createGain = vi.fn(() => {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  });
  createBiquadFilter = vi.fn(() => new FakeFilter());
  compressor = new FakeCompressor();
  createDynamicsCompressor = vi.fn(() => this.compressor);
  createOscillator = vi.fn(() => {
    const o = new FakeOsc();
    this.oscillators.push(o);
    return o;
  });
  createBufferSource = vi.fn(() => {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  });
  createBuffer = vi.fn((_ch: number, length: number) => ({
    getChannelData: () => new Float32Array(length),
  }));
}

function make(): { audio: LanderAudio; ctx: FakeContext } {
  const ctx = new FakeContext();
  const audio = new LanderAudio(() => ctx as unknown as AudioContextLike);
  return { audio, ctx };
}

/** Graph order: master, engine, rumble, rcs (see buildGraph). */
const MASTER = 0;
const ENGINE = 1;
const RUMBLE = 2;
const RCS = 3;

describe('LanderAudio', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    });
  });

  it('is inert until unlocked', () => {
    const { audio, ctx } = make();
    audio.update(1, 1);
    audio.touchdown(2);
    audio.crash();
    expect(audio.isReady()).toBe(false);
    expect(ctx.createGain).not.toHaveBeenCalled();
  });

  it('unlock builds the graph and resumes the context', () => {
    const { audio, ctx } = make();
    audio.unlock();
    expect(audio.isReady()).toBe(true);
    expect(ctx.resume).toHaveBeenCalled();
    // Engine + RCS loops are running; rumble oscillator started
    expect(ctx.sources.filter((s) => s.loop).length).toBe(2);
    expect(ctx.oscillators[0].start).toHaveBeenCalled();
    expect(ctx.gains[MASTER].connected[0]).toBe(ctx.compressor);
    expect(ctx.compressor.connected[0]).toBe(ctx.destination);
  });

  it('more throttle → louder and brighter engine', () => {
    const { audio, ctx } = make();
    audio.unlock();
    audio.update(0.2, 0);
    const lowGain = ctx.gains[ENGINE].gain.last();
    const lowRumble = ctx.gains[RUMBLE].gain.last();
    const lowCutoff = (ctx.sources[0].connected[0] as FakeFilter).frequency.last();
    audio.update(1, 0);
    expect(ctx.gains[ENGINE].gain.last()).toBeGreaterThan(lowGain);
    expect(ctx.gains[RUMBLE].gain.last()).toBeGreaterThan(lowRumble);
    expect((ctx.sources[0].connected[0] as FakeFilter).frequency.last()).toBeGreaterThan(lowCutoff);
    audio.update(0, 0);
    expect(ctx.gains[ENGINE].gain.last()).toBe(0);
  });

  it('RCS hiss follows the attitude command', () => {
    const { audio, ctx } = make();
    audio.unlock();
    audio.update(0, 0);
    expect(ctx.gains[RCS].gain.last()).toBe(0);
    audio.update(0, 1);
    expect(ctx.gains[RCS].gain.last()).toBeGreaterThan(0);
  });

  it('touchdown scales with impact speed; crash fires a one-shot', () => {
    const { audio, ctx } = make();
    audio.unlock();
    const before = ctx.gains.length;
    audio.touchdown(0.5);
    const soft = ctx.gains[before].gain.last();
    audio.touchdown(5);
    const hard = ctx.gains[ctx.gains.length - 2].gain.last();
    expect(hard).toBeGreaterThan(soft);

    const oscBefore = ctx.oscillators.length;
    const srcBefore = ctx.sources.length;
    audio.crash();
    // thump + 3 ring partials; crack, bang, body + debris rattles
    expect(ctx.oscillators.length).toBe(oscBefore + 4);
    expect(ctx.sources.length).toBeGreaterThanOrEqual(srcBefore + 3 + 7);
    // crash is far louder than the hardest touchdown
    const crashPeak = Math.max(...ctx.gains.slice(-11).map((g) => g.gain.targets[0] ?? 0));
    expect(crashPeak).toBeGreaterThan(hard * 2);
    // crash silences the continuous engine first
    expect(ctx.gains[ENGINE].gain.last()).toBe(0);
  });

  it('mute drives the master gain to 0 and persists', () => {
    const { audio, ctx } = make();
    audio.unlock();
    expect(ctx.gains[MASTER].gain.last()).toBeGreaterThan(0);
    expect(audio.toggleMuted()).toBe(true);
    expect(ctx.gains[MASTER].gain.last()).toBe(0);
    expect(localStorage.getItem('lander.audio.muted')).toBe('1');

    const again = make();
    expect(again.audio.isMuted()).toBe(true);
  });

  it('pause suspends, resume resumes, dispose closes', () => {
    const { audio, ctx } = make();
    audio.unlock();
    audio.setPaused(true);
    expect(ctx.suspend).toHaveBeenCalled();
    audio.setPaused(false);
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    audio.dispose();
    expect(ctx.close).toHaveBeenCalled();
    expect(audio.isReady()).toBe(false);
  });
});
