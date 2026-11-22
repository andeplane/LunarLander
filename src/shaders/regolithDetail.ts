import alea from 'alea';
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
} from 'three';

/**
 * Procedural regolith detail map.
 *
 * One seamlessly tiling RGBA texture that MoonMaterial samples at several
 * world scales (millimetre grain, pebbles and clods, metre-sized craterlets):
 *
 *   R, G  surface slope dh/du, dh/dv, encoded as slope / REGOLITH_SLOPE_RANGE * 0.5 + 0.5
 *   B     albedo variation around 0.5 (speckle, dark and bright grains, mottling)
 *   A     normalized height (0 = deepest pit, 1 = highest pebble), used as cavity
 *
 * Heights are in texel units, so the stored slopes are true dimensionless
 * slopes and stay correct at any world scale the texture is tiled at.
 * Mipmapping fades every scale out with distance, which is what keeps the
 * surface free of shimmer without any distance logic in the shader.
 */
export interface PebbleStamp {
  u: number;
  v: number;
  radius: number;
  height: number;
  angle: number;
  tone: number;
  outline: number[];
}

export interface RegolithDetail {
  /** Texture edge length in texels. */
  size: number;
  /** RGBA8 pixels, row-major, `size * size * 4` bytes. */
  data: Uint8Array;
  /** Centres, outlines and elevations of the angular marks, in texture coordinates. */
  pebbles: PebbleStamp[];
}

export interface RegolithDetailOptions {
  /** Texture edge length in texels; must be a power of two ≥ 64. */
  size: number;
  seed: number;
}

/** Slope magnitude that maps to the ends of the encoded range. */
export const REGOLITH_SLOPE_RANGE = 1.5;

/** Most sides a pebble outline can have. */
const MAX_PEBBLE_FACETS = 7;

/** RMS slope of the fine granular (fbm) layer, before pits and pebbles. */
const GRAIN_RMS_SLOPE = 0.2;

function wrapIndex(i: number, size: number): number {
  return ((i % size) + size) % size;
}

/**
 * Seamlessly tiling fractal value noise. Each octave is a `period x period`
 * lattice of random values interpolated with a quintic fade and wrapped at
 * the texture edge.
 */
function addTilingFbm(
  target: Float32Array,
  size: number,
  random: () => number,
  firstPeriod: number,
  octaves: number,
  gain: number
): void {
  let amplitude = 1;
  let period = firstPeriod;
  for (let octave = 0; octave < octaves && period <= size / 2; octave++) {
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = random() * 2 - 1;

    const cell = size / period;
    for (let y = 0; y < size; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const wy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
      const row0 = (y0 % period) * period;
      const row1 = ((y0 + 1) % period) * period;
      for (let x = 0; x < size; x++) {
        const fx = x / cell;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const wx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
        const c0 = x0 % period;
        const c1 = (x0 + 1) % period;
        const top = lattice[row0 + c0] + (lattice[row0 + c1] - lattice[row0 + c0]) * wx;
        const bottom = lattice[row1 + c0] + (lattice[row1 + c1] - lattice[row1 + c0]) * wx;
        target[y * size + x] += amplitude * (top + (bottom - top) * wy);
      }
    }
    amplitude *= gain;
    period *= 2;
  }
}

/** Central-difference slopes with wrap-around, in height units per texel. */
function computeSlopes(height: Float32Array, size: number): { dx: Float32Array; dy: Float32Array } {
  const dx = new Float32Array(size * size);
  const dy = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const up = wrapIndex(y - 1, size) * size;
    const down = wrapIndex(y + 1, size) * size;
    for (let x = 0; x < size; x++) {
      const left = wrapIndex(x - 1, size);
      const right = wrapIndex(x + 1, size);
      dx[y * size + x] = (height[y * size + right] - height[y * size + left]) * 0.5;
      dy[y * size + x] = (height[down + x] - height[up + x]) * 0.5;
    }
  }
  return { dx, dy };
}

/**
 * Stamp a radially symmetric feature into the tile, wrapping at the edges.
 * `apply` receives the normalized distance from the centre (0..reach) and
 * the normalized offset from it.
 */
function stamp(
  size: number,
  centerX: number,
  centerY: number,
  radius: number,
  reach: number,
  apply: (index: number, t: number, dx: number, dy: number) => void
): void {
  const extent = Math.ceil(radius * reach);
  const baseX = Math.round(centerX);
  const baseY = Math.round(centerY);
  for (let oy = -extent; oy <= extent; oy++) {
    const dy = baseY + oy - centerY;
    const row = wrapIndex(baseY + oy, size) * size;
    for (let ox = -extent; ox <= extent; ox++) {
      const dx = baseX + ox - centerX;
      const t = Math.sqrt(dx * dx + dy * dy) / radius;
      if (t < reach) apply(row + wrapIndex(baseX + ox, size), t, dx / radius, dy / radius);
    }
  }
}

/** Polynomial smooth minimum (C1), `k` is the blend width. */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * Generate the regolith detail map. Deterministic for a given size and seed.
 */
export function generateRegolithDetail(options: RegolithDetailOptions): RegolithDetail {
  const { size, seed } = options;
  if (size < 64 || (size & (size - 1)) !== 0) {
    throw new Error(`Regolith detail size must be a power of two >= 64, got ${size}`);
  }

  const random = alea(`regolith-detail:${seed}`);
  const texels = size * size;
  const height = new Float32Array(texels);
  const albedo = new Float32Array(texels);
  const pebbles: PebbleStamp[] = [];

  // --- Granular base: fractal noise scaled to a fixed RMS slope -------------
  addTilingFbm(height, size, random, 4, 8, 0.62);
  const grainSlopes = computeSlopes(height, size);
  let slopeSquares = 0;
  for (let i = 0; i < texels; i++) {
    slopeSquares += grainSlopes.dx[i] * grainSlopes.dx[i] + grainSlopes.dy[i] * grainSlopes.dy[i];
  }
  const grainScale = GRAIN_RMS_SLOPE / Math.sqrt(slopeSquares / texels);
  for (let i = 0; i < texels; i++) height[i] *= grainScale;

  // --- Tonal mottling: patches of lighter and darker soil ------------------
  // Starts at 8 cycles per tile: anything broader would survive mipmapping
  // and show the tile as a repeating grid from a distance.
  const mottle = new Float32Array(texels);
  addTilingFbm(mottle, size, random, 8, 4, 0.55);
  for (let i = 0; i < texels; i++) albedo[i] = mottle[i] * 0.16;

  // --- Pits: small soft craters with a faint raised rim --------------------
  const sizeScale = size / 512;
  const pitCount = Math.round(70 * sizeScale * sizeScale);
  for (let i = 0; i < pitCount; i++) {
    const u = random();
    // Power-law radii: many small pits, few large ones
    const radius = (3 + 23 * u * u * u * u) * sizeScale;
    // Mostly old, shallow bowls: deep pits read as black holes at low sun
    const depth = radius * (0.07 + random() * random() * 0.22);
    const rim = depth * 0.16;
    const tone = (random() - 0.6) * 0.1;
    stamp(size, random() * size, random() * size, radius, 2.4, (index, t) => {
      const bowl = (rim + depth) * t * t - depth;
      const apron = rim / (Math.max(t, 0.6) ** 3);
      const window = 1 - Math.min(Math.max((t - 1.5) / 0.9, 0), 1) ** 2;
      const h = smoothMin(bowl, apron, depth * 0.5) * window;
      height[index] += h;
      // Floors read slightly darker, rims slightly brighter
      albedo[index] += (h / depth) * 0.1 + tone * Math.max(1 - t, 0);
    });
  }

  // --- Pebbles and clods: small angular stones with their own tone ---------
  // Each is a random convex polygon with a flat top and steep sides, so it
  // reads as a chip of rock rather than a blister at any tiling scale.
  const pebbleCount = Math.round(300 * sizeScale * sizeScale);
  const facetX = new Float32Array(MAX_PEBBLE_FACETS);
  const facetY = new Float32Array(MAX_PEBBLE_FACETS);
  const facetReach = new Float32Array(MAX_PEBBLE_FACETS);
  for (let i = 0; i < pebbleCount; i++) {
    const u = random();
    const radius = (1.5 + 5.5 * u * u * u * u) * sizeScale;
    const bump = radius * (0.35 + random() * 0.35);
    const tone = (random() - 0.55) * 0.45;
    const facets = 4 + Math.floor(random() * (MAX_PEBBLE_FACETS - 3));
    const turn = random() * Math.PI * 2;
    for (let f = 0; f < facets; f++) {
      const angle = turn + ((f + (random() - 0.5) * 0.7) / facets) * Math.PI * 2;
      facetX[f] = Math.cos(angle);
      facetY[f] = Math.sin(angle);
      facetReach[f] = 0.55 + random() * 0.45;
    }
    const cx = random() * size;
    const cy = random() * size;
    // Intersect six rays with the same half-planes used below. Keep the
    // half-texel offset: pixel (0, 0) is sampled at (0.5, 0.5) on the GPU.
    const outline = [];
    for (let k = 0; k < 6; k++) {
      const angle = turn + (k * Math.PI) / 3;
      const dx = Math.cos(angle),
        dy = Math.sin(angle);
      let reach = 1;
      for (let f = 0; f < facets; f++)
        reach = Math.min(reach, facetReach[f] / Math.max(0.001, dx * facetX[f] + dy * facetY[f]));
      outline.push(reach);
    }
    pebbles.push({
      u: ((cx + 0.5) / size) % 1,
      v: ((cy + 0.5) / size) % 1,
      radius: radius / size,
      height: bump / size,
      angle: turn,
      tone,
      outline,
    });
    stamp(size, cx, cy, radius, 1, (index, _t, dx, dy) => {
      // Distance to the polygon edge: 0 at the centre, 1 on the outline
      let edge = 0;
      for (let f = 0; f < facets; f++) {
        const d = (dx * facetX[f] + dy * facetY[f]) / facetReach[f];
        if (d > edge) edge = d;
      }
      if (edge >= 1) return;
      const rise = Math.min((1 - edge) * 3, 1);
      const elevation = bump * rise * (1 - 0.25 * edge);
      height[index] += elevation;
      albedo[index] += tone * rise;
    });
  }

  // --- Per-texel speckle: fine grain plus sparse dark and bright grains ----
  for (let i = 0; i < texels; i++) {
    const r = random();
    let grain = (random() - 0.5) * 0.3;
    if (r < 0.035) grain -= 0.3;
    else if (r > 0.985) grain += 0.32;
    albedo[i] += grain;
  }

  // --- Encode --------------------------------------------------------------
  const slopes = computeSlopes(height, size);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  let albedoSum = 0;
  for (let i = 0; i < texels; i++) {
    if (height[i] < minHeight) minHeight = height[i];
    if (height[i] > maxHeight) maxHeight = height[i];
    albedoSum += albedo[i];
  }
  const heightRange = maxHeight - minHeight || 1;
  const albedoMean = albedoSum / texels;

  const data = new Uint8Array(texels * 4);
  const encodeSigned = (value: number): number =>
    Math.round(Math.min(Math.max(value * 0.5 + 0.5, 0), 1) * 255);
  for (let i = 0; i < texels; i++) {
    data[i * 4] = encodeSigned(slopes.dx[i] / REGOLITH_SLOPE_RANGE);
    data[i * 4 + 1] = encodeSigned(slopes.dy[i] / REGOLITH_SLOPE_RANGE);
    data[i * 4 + 2] = encodeSigned((albedo[i] - albedoMean) * 2);
    data[i * 4 + 3] = Math.round(((height[i] - minHeight) / heightRange) * 255);
  }

  return { size, data, pebbles };
}

/** Millimetre-scale fractured rock matrix. RG = slope, B = mineral tone, A = exposed surface. */
export function generateStoneDetail() {
  const size = 256;
  const random = alea('lunar fragment matrix');
  const height = new Float32Array(size * size);
  const mineral = new Float32Array(size * size);
  const cavity = new Float32Array(size * size);
  addTilingFbm(height, size, random, 8, 5, 0.66);
  addTilingFbm(mineral, size, random, 16, 4, 0.7);

  // Flakes break out in slivers. The floor slopes towards one end, with a steeper
  // fracture lip on the opposite end. Their highlights follow the actual sun.
  for (let i = 0; i < 560; i++) {
    const radius = 1.3 + 8.8 * random() ** 3;
    const width = 0.22 + 0.65 * random();
    const angle = 2 * Math.PI * random();
    const cs = Math.cos(angle),
      sn = Math.sin(angle);
    const depth = 0.12 + 0.2 * random();
    stamp(size, random() * size, random() * size, radius, 1, (index, _t, dx, dy) => {
      const along = cs * dx + sn * dy;
      const across = (cs * dy - sn * dx) / width;
      const cut = Math.max(0, 1 - Math.abs(along) ** 1.6 - across * across);
      const hollow = cut * Math.min(1, 1.8 * (along + 1));
      height[index] -= radius * depth * hollow;
      cavity[index] = Math.max(cavity[index], hollow);
    });
  }
  const slope = computeSlopes(height, size);
  const data = new Uint8Array(size * size * 4);
  const byte = (v: number) => Math.round(255 * Math.max(0, Math.min(1, v)));
  for (let i = 0; i < height.length; i++) {
    // Occasional pale inclusions set into a fine-grained darker matrix.
    const grain = random() - 0.5;
    const inclusion = Math.max(0, mineral[i] - 0.46);
    const tone = mineral[i] * 0.1 + inclusion * 0.23 + grain * 0.19 - cavity[i] * 0.11;
    data[i * 4] = byte(0.5 + slope.dx[i] / (2 * REGOLITH_SLOPE_RANGE));
    data[i * 4 + 1] = byte(0.5 + slope.dy[i] / (2 * REGOLITH_SLOPE_RANGE));
    data[i * 4 + 2] = byte(0.5 + tone);
    data[i * 4 + 3] = byte(1 - cavity[i]);
  }
  return { size, data };
}

/**
 * Wrap a generated detail map in a mipmapped, repeating GPU texture.
 */
export function createRegolithDetailTexture(
  detail: Pick<RegolithDetail, 'data' | 'size'>,
  anisotropy = 8
): DataTexture {
  const texture = new DataTexture(
    detail.data,
    detail.size,
    detail.size,
    RGBAFormat,
    UnsignedByteType
  );
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = anisotropy;
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}
