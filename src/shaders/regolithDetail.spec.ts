import { LinearMipmapLinearFilter, RepeatWrapping } from 'three';
import { describe, expect, it } from 'vitest';
import {
  createRegolithDetailTexture,
  generateRegolithDetail,
  REGOLITH_SLOPE_RANGE,
  type RegolithDetail,
} from './regolithDetail';

const SIZE = 128;

function channel(detail: RegolithDetail, offset: number): number[] {
  const values: number[] = [];
  for (let i = offset; i < detail.data.length; i += 4) values.push(detail.data[i]);
  return values;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deviation(values: number[]): number {
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

describe('generateRegolithDetail', () => {
  const detail = generateRegolithDetail({ size: SIZE, seed: 7 });

  it('returns RGBA8 pixels of the requested size', () => {
    expect(detail.size).toBe(SIZE);
    expect(detail.data).toBeInstanceOf(Uint8Array);
    expect(detail.data.length).toBe(SIZE * SIZE * 4);
  });

  it('keeps the seeded outlines and elevation of the stamped pebbles', () => {
    expect(detail.pebbles.length).toBeGreaterThan(0);
    for (const p of detail.pebbles) {
      expect(p.u).toBeGreaterThanOrEqual(0);
      expect(p.u).toBeLessThan(1);
      expect(p.height).toBeGreaterThan(0);
      expect(p.outline).toHaveLength(6);
      expect(Math.max(...p.outline)).toBeLessThanOrEqual(1);
    }
    expect(generateRegolithDetail({ size: SIZE, seed: 7 }).pebbles).toEqual(detail.pebbles);
  });

  it('is deterministic for a seed and differs between seeds', () => {
    const again = generateRegolithDetail({ size: SIZE, seed: 7 });
    const other = generateRegolithDetail({ size: SIZE, seed: 8 });

    expect(again.data).toEqual(detail.data);
    expect(other.data).not.toEqual(detail.data);
  });

  it.each([0, 48, 100, 63.5, -64])('rejects size %s', (size) => {
    expect(() => generateRegolithDetail({ size, seed: 1 })).toThrow(/power of two/);
  });

  it('stores slopes centred on zero with real relief', () => {
    for (const offset of [0, 1]) {
      const slopes = channel(detail, offset);
      expect(Math.abs(mean(slopes) - 127.5)).toBeLessThan(2);
      // At least the granular layer's RMS slope must survive encoding
      expect(deviation(slopes)).toBeGreaterThan((0.1 / REGOLITH_SLOPE_RANGE) * 127.5);
    }
  });

  it('rarely clips slopes at the ends of the encoded range', () => {
    const clipped = [...channel(detail, 0), ...channel(detail, 1)].filter((v) => v === 0 || v === 255);
    expect(clipped.length / (SIZE * SIZE * 2)).toBeLessThan(0.03);
  });

  it('stores albedo variation around mid grey', () => {
    const albedo = channel(detail, 2);
    expect(Math.abs(mean(albedo) - 127.5)).toBeLessThan(6);
    expect(deviation(albedo)).toBeGreaterThan(10);
  });

  it('normalizes height to the full range', () => {
    const height = channel(detail, 3);
    expect(Math.min(...height)).toBe(0);
    expect(Math.max(...height)).toBe(255);
  });

  it('tiles seamlessly: edge texels are as similar as neighbours inside', () => {
    const heightAt = (x: number, y: number): number => detail.data[(y * SIZE + x) * 4 + 3];
    let seam = 0;
    let interior = 0;
    for (let i = 0; i < SIZE; i++) {
      seam += Math.abs(heightAt(0, i) - heightAt(SIZE - 1, i)) + Math.abs(heightAt(i, 0) - heightAt(i, SIZE - 1));
      interior +=
        Math.abs(heightAt(SIZE / 2, i) - heightAt(SIZE / 2 - 1, i)) +
        Math.abs(heightAt(i, SIZE / 2) - heightAt(i, SIZE / 2 - 1));
    }
    expect(seam).toBeLessThan(interior * 2.5 + SIZE);
  });
});

describe('createRegolithDetailTexture', () => {
  it('wraps the data in a repeating, mipmapped texture', () => {
    const detail = generateRegolithDetail({ size: 64, seed: 3 });
    const texture = createRegolithDetailTexture(detail, 4);

    expect(texture.image.width).toBe(64);
    expect(texture.image.height).toBe(64);
    expect(texture.image.data).toBe(detail.data);
    expect(texture.wrapS).toBe(RepeatWrapping);
    expect(texture.wrapT).toBe(RepeatWrapping);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.anisotropy).toBe(4);
    expect(createRegolithDetailTexture(detail).anisotropy).toBe(8);
  });
});
