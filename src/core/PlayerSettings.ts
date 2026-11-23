// Mute is already persisted by LanderAudio, including changes made with M.
export const roverShadowSizes = { performance: 512, balanced: 1024, high: 2048 } as const;
export type ShadowQuality = keyof typeof roverShadowSizes;
export const DEFAULT_SHADOW_QUALITY: ShadowQuality = 'high';

export const groundTextures = [
  { value: 0, label: 'Low' },
  { value: 1, label: 'Medium' },
  { value: 2, label: 'High' },
] as const;
export const rockBumps = [
  { value: 0, label: 'Off' },
  { value: 0.5, label: 'Subtle' },
  { value: 1, label: 'Natural' },
  { value: 1.5, label: 'Strong' },
] as const;
export const renderScales = [
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1, label: '100%' },
] as const;

export class PlayerSettings {
  cockpitLook = true;
  groundTexture = 2;
  rockBump = 1;
  renderScale = 1;
  shadowQuality: ShadowQuality = DEFAULT_SHADOW_QUALITY;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem('lunar.playerSettings') ?? '{}');
      if (groundTextures.some((option) => option.value === saved?.groundTexture))
        this.groundTexture = saved.groundTexture;
      if (rockBumps.some((option) => option.value === saved?.rockBump))
        this.rockBump = saved.rockBump;
      if (renderScales.some((option) => option.value === saved?.renderScale))
        this.renderScale = saved.renderScale;
      if (typeof saved?.cockpitLook === 'boolean') this.cockpitLook = saved.cockpitLook;
      if (Object.keys(roverShadowSizes).includes(saved?.shadowQuality))
        this.shadowQuality = saved.shadowQuality;
    } catch {
      // Missing or unavailable storage uses the defaults for this session.
    }
  }

  save() {
    try {
      localStorage.setItem('lunar.playerSettings', JSON.stringify(this));
    } catch {
      // Preferences still apply for this session.
    }
  }
}
