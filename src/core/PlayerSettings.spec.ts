import { afterEach, expect, it, vi } from 'vitest';
import { PlayerSettings } from './PlayerSettings';

afterEach(() => vi.unstubAllGlobals());

it('keeps existing rover preferences when upgrading an older save', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => JSON.stringify({ cockpitLook: false, shadowQuality: 'balanced' }),
  });
  expect(new PlayerSettings()).toMatchObject({
    cockpitLook: false,
    shadowQuality: 'balanced',
    groundTexture: 2,
    rockBump: 1,
    renderScale: 1,
  });
});

it('loads zero-strength presets and ignores unsupported resolutions', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => JSON.stringify({ groundTexture: 0, rockBump: 0, renderScale: -1 }),
  });
  expect(new PlayerSettings()).toMatchObject({ groundTexture: 0, rockBump: 0, renderScale: 1 });
});
