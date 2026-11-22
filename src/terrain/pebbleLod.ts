import type { PerspectiveCamera } from 'three';

// Below this diameter the matching, mipmapped mark in the soil carries the stone.
export const PEBBLE_TEXTURE_PX = 1.25;
export const PEBBLE_FULL_PX = 3;
export const PEBBLE_ARRIVAL_SECONDS = 0.3;
export const PEBBLE_TILE_SIZE = 4;
const DIAGONAL = Math.SQRT1_2;
// Support planes of the viewing pyramid projected onto the ground.
const AXES = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [DIAGONAL, DIAGONAL],
  [-DIAGONAL, DIAGONAL],
  [-DIAGONAL, -DIAGONAL],
  [DIAGONAL, -DIAGONAL],
] as const;

export interface PebbleView {
  x: number;
  z: number;
  // Maximum straight-line distance to a stone per metre of outline radius.
  range: number;
  // Metres of horizontal coverage per metre of stone radius.
  support: number[];
  // Range of heights in the viewing pyramid, in the same units.
  down: number;
  up: number;
  // Heights of the displayed terrain relative to the eye.
  floor: number;
  ceiling: number;
}

export function pebbleView(
  x: number,
  z: number,
  projection: number,
  view: PerspectiveCamera | undefined,
  floor: number,
  ceiling: number
): PebbleView {
  const scale = projection / PEBBLE_TEXTURE_PX;
  const m = view?.matrixWorld.elements;
  const tanY = view ? 1 / view.projectionMatrix.elements[5] : 1;
  const tanX = view ? 1 / view.projectionMatrix.elements[0] : 1;
  const support = AXES.map(([nx, nz]) => {
    if (!m) return scale;
    const center = -m[8] * nx - m[10] * nz;
    const span = Math.abs(m[0] * nx + m[2] * nz) * tanX + Math.abs(m[4] * nx + m[6] * nz) * tanY;
    return scale * Math.max(0, center + span);
  });
  const verticalSpan = m ? Math.abs(m[1]) * tanX + Math.abs(m[5]) * tanY : 1;
  return {
    x,
    z,
    range: scale,
    support,
    down: scale * (verticalSpan + (m?.[9] ?? 0)),
    up: scale * (verticalSpan - (m?.[9] ?? 0)),
    floor,
    ceiling,
  };
}

// Keep room for turning and crossing a tile while a worker reply is in flight.
export function paddedPebbleView(view: PebbleView): PebbleView {
  const turn = Math.max(1, ...view.support, view.down, view.up) * 0.12;
  return {
    ...view,
    range: view.range * 1.08,
    support: view.support.map((v) => v + turn),
    down: view.down + turn,
    up: view.up + turn,
    floor: view.floor - 8,
    ceiling: view.ceiling + 8,
  };
}

export function coversPebbleView(old: PebbleView, view: PebbleView) {
  return (
    old.x === view.x &&
    old.z === view.z &&
    old.range >= view.range &&
    old.floor <= view.floor &&
    old.ceiling >= view.ceiling &&
    old.down >= view.down &&
    old.up >= view.up &&
    view.support.every((v, i) => old.support[i] >= v)
  );
}

export function pebbleInWindow(
  view: PebbleView,
  dx: number,
  dz: number,
  radius: number,
  pad: number,
  groundLimit = Infinity
) {
  const dy = Math.max(0, view.floor, -view.ceiling);
  const reach = radius * view.range + pad;
  if (dx * dx + dy * dy + dz * dz > reach * reach) return false;
  const frustumRadius = Math.min(radius, groundLimit);
  if (
    view.ceiling < -Math.max(0, view.down) * radius - pad ||
    view.floor > Math.max(0, view.up) * radius + pad
  )
    return false;
  for (let i = 0; i < AXES.length; i++) {
    const [nx, nz] = AXES[i];
    if (dx * nx + dz * nz > frustumRadius * view.support[i] + pad) return false;
  }
  return true;
}
