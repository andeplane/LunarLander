import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MoonMaterial } from '../shaders/MoonMaterial';
import { type PebbleGroundSampler, PebbleSurface } from './PebbleSurface';

describe('grounded pebble relief', () => {
  it('pins the mesh to the ground grid, reuses support and fades back to shaded terrain', () => {
    const terrain = new MoonMaterial();
    const cover = vi.spyOn(terrain, 'setPebbleCover');
    const sample = vi.fn<PebbleGroundSampler>((x, z, out, i) => {
      out.set([0, 1, 0, -7 + 0.03 * x + 0.02 * z], i);
      return true;
    });
    const patch = new PebbleSurface(terrain, 0.4, 0.4, sample);
    const camera = new Vector3(-10.02, -6.7, 19.15);
    expect(patch.update(camera, 0.6, 1)).toBe(true);
    expect(patch.root.visible).toBe(true);
    expect(cover.mock.lastCall?.[2]).toBeGreaterThan(4.8);
    expect(patch.root.position.x).toBeCloseTo(-10);
    const samples = sample.mock.calls.length;
    camera.x += 0.03;
    expect(patch.update(camera, 0.6, 1)).toBe(false);
    expect(sample).toHaveBeenCalledTimes(samples);
    terrain.setParam('pebbleHeight', 1.5);
    expect(patch.update(camera, 0.6, 1)).toBe(true);
    expect(sample).toHaveBeenCalledTimes(samples);
    expect(patch.update(camera, 32, 1)).toBe(true);
    expect(patch.root.visible).toBe(false);
    expect(cover).toHaveBeenLastCalledWith(0, 0, 0, 0);
    expect(sample).toHaveBeenCalledTimes(samples);
    expect(patch.update(camera, 0.6, 2)).toBe(true);
    sample.mockReturnValue(false);
    expect(patch.update(camera, 0.6, 3)).toBe(true);
    expect(patch.root.visible).toBe(false);
    expect(cover).toHaveBeenLastCalledWith(0, 0, 0, 0);
    patch.dispose();
    terrain.dispose();
  });
});
