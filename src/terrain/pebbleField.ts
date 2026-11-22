import { RockBuilder } from '../environment/RockBuilder';
import { rockHeightRatio } from '../environment/rockPrototypes';
import type { PebbleStamp } from '../shaders/regolithDetail';
import {
  FINE_PEBBLE_REACH,
  PEBBLE_REACH,
  PEBBLE_TILE_SIZE,
  PebbleAtlas,
  type PlacedPebble,
} from './pebblePlacement';

export const PEBBLE_SHAPES = 8;
// Fourteen interleaved GPU floats (ground, form, bed, width), plus the CPU's shape index.
export const INSTANCE_STRIDE = 14;
export const FIELD_STRIDE = INSTANCE_STRIDE + 1;

function prototype(key: number) {
  const shape = key % PEBBLE_SHAPES;
  const source = RockBuilder.generate(shape, {
    detail: key >= PEBBLE_SHAPES ? 4 : 1,
    roughness: 1.15,
  });
  source.scale(2, 1 / rockHeightRatio(shape), 2);
  return {
    position: source.getAttribute('position').array as Float32Array,
    normal: source.getAttribute('normal').array as Float32Array,
    index: source.getIndex()?.array as Uint16Array | Uint32Array,
  };
}
export type ChipPrototype = ReturnType<typeof prototype>;

export interface PebbleWindow {
  x: number;
  z: number;
  stones: Float32Array;
  shapes?: ChipPrototype[];
}

export interface PebbleRequest {
  x: number;
  z: number;
  /** Sent once, when opening the worker. */
  stamps?: readonly PebbleStamp[];
}

/** The worker keeps overlapping world tiles and transfers only a packed draw list to the renderer. */
export class PebbleField {
  private readonly atlas: PebbleAtlas;
  private readonly tiles = new Map<string, PlacedPebble[]>();
  private builtShapes = false;

  constructor(stamps: readonly PebbleStamp[]) {
    this.atlas = new PebbleAtlas(stamps);
  }

  window(tx: number, tz: number): PebbleWindow {
    const cx = (tx + 0.5) * PEBBLE_TILE_SIZE,
      cz = (tz + 0.5) * PEBBLE_TILE_SIZE;
    const pad = PEBBLE_TILE_SIZE * Math.SQRT1_2;
    const keep = new Set<string>(),
      nearby: PlacedPebble[] = [];
    for (const fine of [false, true]) {
      const reach = fine ? FINE_PEBBLE_REACH : PEBBLE_REACH;
      const rings = Math.ceil((reach + PEBBLE_TILE_SIZE) / PEBBLE_TILE_SIZE);
      for (let z = tz - rings; z <= tz + rings; z++)
        for (let x = tx - rings; x <= tx + rings; x++) {
          if (Math.hypot(x - tx, z - tz) * PEBBLE_TILE_SIZE > reach + 2 * pad) continue;
          const key = `${x},${z},${Number(fine)}`;
          keep.add(key);
          let stones = this.tiles.get(key);
          if (!stones) {
            stones = this.atlas.tile(x, z, fine);
            this.tiles.set(key, stones);
          }
          for (const stone of stones)
            if (Math.hypot(stone.x - cx, stone.z - cz) < stone.reach + pad) nearby.push(stone);
        }
    }
    for (const key of this.tiles.keys()) if (!keep.has(key)) this.tiles.delete(key);
    const data = new Float32Array(nearby.length * FIELD_STRIDE);
    for (let i = 0; i < nearby.length; i++) {
      const p = nearby[i],
        at = i * FIELD_STRIDE;
      data[at] = p.x;
      data[at + 2] = p.z;
      data[at + 3] = p.radius;
      data[at + 4] = p.height;
      data[at + 5] = Math.cos(p.angle);
      data[at + 6] = Math.sin(p.angle);
      data[at + 7] = p.reach;
      data[at + 10] = Math.min(1, Math.max(0, p.stamp.tone * 2.2 + 0.55));
      data[at + 11] = p.burial;
      const r = p.stamp.outline;
      data[at + 12] = (r[0] + r[3]) * 0.5;
      data[at + 13] = (r[1] + r[2] + r[4] + r[5]) * 0.25;
      data[at + 14] = p.shape;
    }
    const result: PebbleWindow = { x: tx, z: tz, stones: data };
    if (!this.builtShapes) {
      result.shapes = Array.from({ length: PEBBLE_SHAPES * 2 }, (_, i) => prototype(i));
      this.builtShapes = true;
    }
    return result;
  }
}
