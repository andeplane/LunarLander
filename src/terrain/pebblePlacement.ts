import alea from 'alea';
import { createNoise2D } from 'simplex-noise';
import type { PebbleStamp } from '../shaders/regolithDetail';
import {
  FINE_PEBBLE_FREQUENCY,
  MEDIUM_PEBBLE_FREQUENCY,
  patchTransform,
} from '../shaders/regolithTiling';

import { PEBBLE_TILE_SIZE } from './pebbleLod';

export interface PlacedPebble {
  x: number;
  z: number;
  radius: number;
  height: number;
  burial: number;
  angle: number;
  stamp: PebbleStamp;
}

const BINS = 16;
// Keep some patches dusty and others more exposed without moving their stones.
const exposure = createNoise2D(alea('regolith burial'));
const SKEW = 0.57735027;
const STRETCH = 1.15470054;
const SCALE = 3.464;

/** The cubed barycentric weight used by moonPatchWeights at this stone's centre. */
function patchWeight(u: number, v: number, vx: number, vz: number) {
  const qx = (u - SKEW * v) * SCALE,
    qz = v * STRETCH * SCALE;
  const bx = Math.floor(qx),
    bz = Math.floor(qz);
  const fx = qx - bx,
    fz = qz - bz,
    top = 1 - fx - fz;
  const a = Math.abs(top) ** 3,
    b = (top > 0 ? fz : 1 - fz) ** 3,
    c = (top > 0 ? fx : 1 - fx) ** 3;
  if (vx === bx && vz === bz + 1) return b / (a + b + c);
  if (vx === bx + 1 && vz === bz) return c / (a + b + c);
  const diagonal = top > 0 ? 0 : 1;
  return vx === bx + diagonal && vz === bz + diagonal ? a / (a + b + c) : 0;
}

/** Invert each overlapping material patch to find the *actual* stamped rocks in a world tile. */
export class PebbleAtlas {
  private readonly bins: PebbleStamp[][] = Array.from({ length: BINS ** 2 }, () => []);

  constructor(stamps: readonly PebbleStamp[]) {
    for (const stamp of stamps)
      this.bins[Math.floor(stamp.v * BINS) * BINS + Math.floor(stamp.u * BINS)].push(stamp);
  }

  tile(tx: number, tz: number, fine: boolean, tileSize = PEBBLE_TILE_SIZE): PlacedPebble[] {
    const frequency = fine ? FINE_PEBBLE_FREQUENCY : MEDIUM_PEBBLE_FREQUENCY;
    const offsetU = fine ? 0 : 0.37,
      offsetV = fine ? 0 : 0.11;
    const x0 = tx * tileSize,
      z0 = tz * tileSize;
    const x1 = x0 + tileSize,
      z1 = z0 + tileSize;
    const extent = tileSize * frequency;
    const u0 = x0 * frequency + offsetU,
      v0 = z0 * frequency + offsetV;
    const output: PlacedPebble[] = [];
    for (
      let pz = Math.floor(v0 * STRETCH * SCALE);
      pz <= Math.ceil((v0 + extent) * STRETCH * SCALE);
      pz++
    ) {
      const minX = Math.floor((u0 - SKEW * (v0 + extent)) * SCALE);
      const maxX = Math.ceil((u0 + extent - SKEW * v0) * SCALE);
      for (let px = minX; px <= maxX; px++) {
        // Clip to the hexagon's bounding box before looking up atlas bins. A fine
        // world tile spans many transformed patches, each covering only a fraction of it.
        const patchV = pz / (STRETCH * SCALE),
          patchU = px / SCALE + SKEW * patchV;
        const loU = Math.max(u0, patchU - 1.001 / SCALE),
          hiU = Math.min(u0 + extent, patchU + 1.001 / SCALE);
        const loV = Math.max(v0, patchV - 1.001 / (STRETCH * SCALE)),
          hiV = Math.min(v0 + extent, patchV + 1.001 / (STRETCH * SCALE));
        if (loU >= hiU || loV >= hiV) continue;
        const t = patchTransform(px, pz);
        const centerU = (loU + hiU) / 2,
          centerV = (loV + hiV) / 2;
        const halfU = (hiU - loU) / 2,
          halfV = (hiV - loV) / 2;
        const midU = t.c * centerU - t.s * centerV + t.u,
          midV = t.s * centerU + t.c * centerV + t.v;
        const spanU = Math.abs(t.c) * halfU + Math.abs(t.s) * halfV;
        const spanV = Math.abs(t.s) * halfU + Math.abs(t.c) * halfV;
        for (
          let bz = Math.floor((midV - spanV) * BINS);
          bz <= Math.floor((midV + spanV) * BINS);
          bz++
        ) {
          for (
            let bx = Math.floor((midU - spanU) * BINS);
            bx <= Math.floor((midU + spanU) * BINS);
            bx++
          ) {
            const bin = (bz & (BINS - 1)) * BINS + (bx & (BINS - 1));
            for (const stamp of this.bins[bin]) {
              const radius = stamp.radius / frequency;
              // The smallest grains stay in the normal map.
              if (fine && radius < 0.017) continue;
              const du = stamp.u + Math.floor(bx / BINS) - t.u;
              const dv = stamp.v + Math.floor(bz / BINS) - t.v;
              const u = t.c * du + t.s * dv,
                v = -t.s * du + t.c * dv;
              const x = (u - offsetU) / frequency,
                z = (v - offsetV) / frequency;
              if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
              const weight = patchWeight(u, v, px, pz);
              if (weight < 0.23) continue;
              output.push({
                x,
                z,
                burial:
                  0.32 + 0.3 * stamp.u + 0.13 * (1 - weight) + 0.17 * exposure(x * 0.21, z * 0.21),
                radius: radius * (0.79 + 0.21 * weight),
                height:
                  (stamp.height / frequency) *
                  (0.86 + 0.94 * ((stamp.u * 17.19) % 1)) *
                  weight ** 0.75,
                angle: stamp.angle - t.angle,
                stamp,
              });
            }
          }
        }
      }
    }
    return output;
  }
}
