// Mute is already persisted by LanderAudio, including changes made with M.
export const roverShadowSizes = { performance: 512, balanced: 1024, high: 2048 } as const;
export type ShadowQuality = keyof typeof roverShadowSizes;
export const DEFAULT_SHADOW_QUALITY: ShadowQuality = 'high';

export class PlayerSettings {
  cockpitLook = true;
  shadowQuality: ShadowQuality = DEFAULT_SHADOW_QUALITY;

  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem('lunar.playerSettings') ?? '{}');
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
