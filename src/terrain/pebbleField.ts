import { RockBuilder } from '../environment/RockBuilder';
import { hashToUnit, rockHeightRatio } from '../environment/rockPrototypes';
import type { PebbleStamp } from '../shaders/regolithDetail';
import { FINE_PEBBLE_FREQUENCY, MEDIUM_PEBBLE_FREQUENCY } from '../shaders/regolithTiling';
import { PEBBLE_TILE_SIZE, pebbleInWindow, type PebbleView } from './pebbleLod';
import { PebbleAtlas, type PlacedPebble } from './pebblePlacement';

export const PEBBLE_SHAPES = 8;
export const PEBBLE_DETAILS = [0, 1, 4, 11] as const;
// Four interleaved instance attributes, followed by a CPU-only shape index.
export const INSTANCE_STRIDE = 15;
export const FIELD_STRIDE = INSTANCE_STRIDE + 1;

function prototype(key: number) {
  const shape = key % PEBBLE_SHAPES;
  const wear = hashToUnit(shape + 53);
  const source = RockBuilder.generate(shape, {
    archetype: 'fragment',
    detail: PEBBLE_DETAILS[Math.floor(key / PEBBLE_SHAPES)],
    roughness: 1.7 + 1.3 * wear,
    bevel: 1.05 + 1.45 * wear,
    edgeSnap: 0.12,
    creaseAngle: 52 + 14 * wear,
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
  stones: Float32Array;
  shapes?: ChipPrototype[];
}

export interface PebbleRequest {
  view: PebbleView;
  /** Sent once, when opening the worker. */
  stamps?: readonly PebbleStamp[];
}

function pack(stones: PlacedPebble[]) {
  const data = new Float32Array(stones.length * FIELD_STRIDE);
  for (let i = 0; i < stones.length; i++) {
    const p = stones[i],
      at = i * FIELD_STRIDE;
    data[at] = p.x;
    data[at + 2] = p.z;
    data[at + 3] = p.radius;
    data[at + 4] = p.height;
    data[at + 5] = Math.cos(p.angle);
    data[at + 6] = Math.sin(p.angle);
    data[at + 1] = NaN; // The renderer samples the displayed terrain.
    data[at + 10] = Math.min(1, Math.max(0, p.stamp.tone * 2.2 + 0.55));
    data[at + 11] = p.burial;
    const r = p.stamp.outline;
    data[at + 12] = (r[0] + r[3]) * 0.5;
    data[at + 13] = (r[1] + r[2] + r[4] + r[5]) * 0.25;
    // Adjacent marks have similar atlas coordinates. Choose the actual fragment
    // and its mineral exposure independently at each world-space position.
    const seed = Math.imul(Math.round(p.x * 512), 0x8da6b343) ^ Math.round(p.z * 512);
    const variety = hashToUnit(seed) * PEBBLE_SHAPES;
    const shape = Math.floor(variety);
    data[at + 14] = variety - shape;
    data[at + INSTANCE_STRIDE] = shape;
  }
  return data;
}

interface CachedTile {
  stones: Float32Array;
  // Previous draw-list slot plus one, zero if the stone was outside that window.
  slots: Uint32Array;
}

interface StoneBand {
  atlas: PebbleAtlas;
  fine: boolean;
  maxRadius: number;
  tileSize: number;
  tiles: Map<string, CachedTile>;
}

/** Cache immutable placements in size bands. Only the larger marks need distant tiles. */
export class PebbleField {
  private readonly bands: StoneBand[] = [];
  private builtShapes = false;

  constructor(stamps: readonly PebbleStamp[]) {
    for (const fine of [true, false]) {
      const frequency = fine ? FINE_PEBBLE_FREQUENCY : MEDIUM_PEBBLE_FREQUENCY;
      let lower = 0;
      for (const upper of [0.0048, 0.008, Infinity]) {
        const group = stamps.filter(
          (s) => s.radius >= lower && s.radius < upper && (!fine || s.radius / frequency >= 0.017)
        );
        lower = upper;
        if (!group.length) continue;
        this.bands.push({
          atlas: new PebbleAtlas(group),
          fine,
          tileSize: fine ? 2 : 10,
          maxRadius: Math.max(...group.map((s) => s.radius)) / frequency,
          tiles: new Map(),
        });
      }
    }
  }

  window(view: PebbleView): PebbleWindow {
    const cx = (view.x + 0.5) * PEBBLE_TILE_SIZE,
      cz = (view.z + 0.5) * PEBBLE_TILE_SIZE;
    const s = view.support;
    const pad = PEBBLE_TILE_SIZE * 1.5;
    // At a downward (or upward) angle the ground can end the search well before
    // the maximum optical distance, particularly under magnification.
    const groundLimit =
      view.up < 0
        ? (view.floor - pad) / view.up
        : view.down < 0
          ? (view.ceiling + pad) / -view.down
          : Infinity;
    const chunks: { tile: Float32Array; indices: number[]; previous: Uint32Array }[] = [];
    let count = 0;
    for (const band of this.bands) {
      const { tileSize, tiles } = band;
      if (!pebbleInWindow(view, 0, 0, band.maxRadius, pad)) {
        tiles.clear();
        continue;
      }
      const radius = Math.min(band.maxRadius, Math.max(0, groundLimit));
      const reach = band.maxRadius * view.range;
      const extent = (axis: number) => Math.min(reach, radius * s[axis]) + pad;
      const keep = new Map<string, CachedTile>();
      for (
        let z = Math.floor((cz - extent(3)) / tileSize);
        z <= Math.floor((cz + extent(1)) / tileSize);
        z++
      ) {
        for (
          let x = Math.floor((cx - extent(2)) / tileSize);
          x <= Math.floor((cx + extent(0)) / tileSize);
          x++
        ) {
          const dx = (x + 0.5) * tileSize - cx,
            dz = (z + 0.5) * tileSize - cz;
          if (!pebbleInWindow(view, dx, dz, band.maxRadius, pad + tileSize * Math.SQRT1_2, radius))
            continue;
          const key = `${x},${z}`;
          const cached = tiles.get(key);
          const tile = cached?.stones ?? pack(band.atlas.tile(x, z, band.fine, tileSize));
          const slots = new Uint32Array(tile.length / FIELD_STRIDE);
          keep.set(key, { stones: tile, slots });
          const indices: number[] = [];
          for (let at = 0; at < tile.length; at += FIELD_STRIDE) {
            const width = tile[at + 3] * Math.max(tile[at + 12], tile[at + 13]);
            if (pebbleInWindow(view, tile[at] - cx, tile[at + 2] - cz, width, pad, radius)) {
              slots[at / FIELD_STRIDE] = count + indices.length + 1;
              indices.push(at);
            }
          }
          if (indices.length) {
            chunks.push({ tile, indices, previous: cached?.slots ?? new Uint32Array(0) });
            count += indices.length;
          }
        }
      }
      band.tiles = keep;
    }
    const data = new Float32Array(count * FIELD_STRIDE);
    let out = 0;
    for (const { tile, indices, previous } of chunks)
      for (const at of indices) {
        for (let j = 0; j < FIELD_STRIDE; j++) data[out + j] = tile[at + j];
        data[out + 7] = (previous[at / FIELD_STRIDE] ?? 0) - 1;
        out += FIELD_STRIDE;
      }
    const result: PebbleWindow = { stones: data };
    if (count > 0 && !this.builtShapes) {
      result.shapes = Array.from({ length: PEBBLE_SHAPES * PEBBLE_DETAILS.length }, (_, i) =>
        prototype(i)
      );
      this.builtShapes = true;
    }
    return result;
  }
}
