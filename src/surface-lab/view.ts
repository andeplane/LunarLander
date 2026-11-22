export const MIN_DISTANCE = 0.25;
export const MAX_DISTANCE = 16384;
export const MODES = ['game', 'compare', 'candidate'] as const;
export const VARIANTS = ['flight', 'pebbles', 'hybrid', 'procedural'] as const;
export const VARIANT_NAMES = {
  flight: 'Refined',
  pebbles: 'Raised',
  hybrid: 'Hybrid',
  procedural: 'Procedural',
} as const;
export const CHANNELS = ['lit', 'albedo', 'normals'] as const;
export const ANGLES = ['overhead', 'oblique', 'grazing'] as const;
export function viewTilt(angle: (typeof ANGLES)[number]) {
  return ({ overhead: 0, oblique: 52, grazing: 75 }[angle] * Math.PI) / 180;
}
export type LabView = ReturnType<typeof readView>;

function choice<T extends string>(value: string | null, choices: readonly T[], fallback: T): T {
  return choices.find((option) => option === value) ?? fallback;
}

export function readView(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  function number(name: string, fallback: number, min: number, max: number) {
    const raw = params.get(name);
    const value = raw?.trim() ? Number(raw) : NaN;
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }
  const angle = choice(params.get('angle'), ANGLES, 'overhead');
  // Older bookmarks stored the eye's height above the target.
  const legacyHeight = number('h', NaN, MIN_DISTANCE, 4000);
  const distance = number(
    'd',
    Number.isFinite(legacyHeight) ? legacyHeight / Math.cos(viewTilt(angle)) : 32,
    MIN_DISTANCE,
    MAX_DISTANCE
  );
  return {
    mode:
      params.get('view') === 'procedural'
        ? ('candidate' as const)
        : choice(params.get('view'), MODES, 'compare'),
    variant: choice(
      params.get('variant'),
      VARIANTS,
      params.get('view') === 'procedural' ? 'procedural' : 'flight'
    ),
    channel: choice(params.get('channel'), CHANNELS, 'lit'),
    angle,
    distance,
    x: number('x', 19, -1000000, 1000000),
    z: number('z', -37, -1000000, 1000000),
    sun: number('sun', 22, 6, 78),
    relief: number('relief', 1, 0, 2),
  };
}

export function viewHash(view: LabView): string {
  return new URLSearchParams({
    view: view.mode,
    variant: view.variant,
    d: String(view.distance),
    x: String(view.x),
    z: String(view.z),
    sun: String(view.sun),
    angle: view.angle,
    channel: view.channel,
    relief: String(view.relief),
  }).toString();
}

/** A ground distance with a 1, 2 or 5 mantissa, sized for the available pane. */
export function scaleBar(metresPerPixel: number, maxPixels: number) {
  const budget = metresPerPixel * maxPixels;
  const decade = 10 ** Math.floor(Math.log10(budget));
  const mantissa = budget / decade;
  const metres = (mantissa >= 5 ? 5 : mantissa >= 2 ? 2 : 1) * decade;
  return { metres, pixels: metres / metresPerPixel };
}

export function distanceLabel(metres: number): string {
  if (metres >= 1000) return `${Number((metres / 1000).toFixed(2))} km`;
  if (metres < 1) return `${Number((metres * 100).toFixed(1))} cm`;
  return `${Number(metres.toFixed(metres < 10 ? 2 : 1))} m`;
}
