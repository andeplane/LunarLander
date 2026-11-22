import { type InstancedBufferGeometry, type Mesh, PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { getSharedPebbleStamps, MoonMaterial } from '../shaders/MoonMaterial';
import { MEDIUM_PEBBLE_FREQUENCY, patchTransform } from '../shaders/regolithTiling';
import { type PebbleGroundSampler, PebbleSurface } from './PebbleSurface';
import { PebbleAtlas } from './pebblePlacement';

describe('grounded pebble meshes', () => {
  it('puts each chip on its own atlas mark across negative coordinates and tile edges', () => {
    const atlas = new PebbleAtlas(getSharedPebbleStamps());
    const left = atlas.tile(-1, -1, false),
      right = atlas.tile(0, -1, false);
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
    const f = MEDIUM_PEBBLE_FREQUENCY;
    for (const p of [...left, ...right]) {
      const u = p.x * f + 0.37,
        v = p.z * f + 0.11;
      const bx = Math.floor((u - 0.57735027 * v) * 3.464),
        bz = Math.floor(v * 1.15470054 * 3.464);
      let error = Infinity;
      for (const x of [bx, bx + 1])
        for (const z of [bz, bz + 1]) {
          const t = patchTransform(x, z);
          const du = t.c * u - t.s * v + t.u - p.stamp.u,
            dv = t.s * u + t.c * v + t.v - p.stamp.v;
          error = Math.min(error, Math.hypot(du - Math.round(du), dv - Math.round(dv)));
        }
      expect(error).toBeLessThan(1e-6);
    }
    expect(left.every((p) => p.x >= -4 && p.x < 0)).toBe(true);
    expect(right.every((p) => p.x >= 0 && p.x < 4)).toBe(true);
  });

  it('retains positions across a recenter and shows the available ground at a streaming boundary', () => {
    const ground = new MoonMaterial();
    const sample = vi.fn<PebbleGroundSampler>((x, z, out, i) => {
      out.set([-0.08, 1, 0.02, 0.08 * x - 0.02 * z], i);
      return x < 9;
    });
    const patch = new PebbleSurface(ground, sample);
    const camera = new Vector3(3.98, 1.7, -2);
    function centres() {
      const result = new Set<string>();
      for (const mesh of patch.root.children as Mesh<InstancedBufferGeometry>[]) {
        const g = mesh.geometry,
          a = g.getAttribute('chipGround');
        for (let i = 0; i < g.instanceCount; i++)
          if (Math.hypot(a.getX(i) - 4, a.getZ(i) + 2) < 1.5)
            result.add(`${a.getX(i)},${a.getY(i)},${a.getZ(i)}`);
      }
      return result;
    }
    expect(patch.update(camera, 1.7, 0)).toBe(true);
    expect(patch.root.visible).toBe(true);
    const before = centres(),
      samples = sample.mock.calls.length;
    expect(before.size).toBeGreaterThan(10);
    ground.setParam('pebbleHeight', 1.3);
    expect(patch.update(camera, 1.7, 0)).toBe(true);
    expect(sample).toHaveBeenCalledTimes(samples);
    camera.x = 4.02;
    patch.update(camera, 1.7, 0);
    expect(centres()).toEqual(before);
    expect(patch.update(camera, 32, 0)).toBe(true);
    expect(patch.root.visible).toBe(false);
    ground.setParam('pebbleHeight', 0);
    expect(patch.update(camera, 1.7, 0)).toBe(false);
    patch.dispose();
    ground.dispose();
  });

  it('refines the same visible stone when its screen footprint grows', () => {
    const ground = new MoonMaterial();
    const patch = new PebbleSurface(ground, (_x, _z, out) => {
      out.set([0, 1, 0, 0]);
      return true;
    });
    const view = new PerspectiveCamera(65, 1, 0.02, 100);
    view.position.set(0, 1.4, 0);
    view.lookAt(0, 0, -2);
    function triangleCounts(viewportHeight: number) {
      patch.update(view.position, 1.4, 0, true, view, viewportHeight);
      const counts = new Map<string, number>();
      for (const mesh of patch.root.children as Mesh<InstancedBufferGeometry>[]) {
        if (!mesh.layers.isEnabled(0)) continue;
        const geometry = mesh.geometry;
        const at = geometry.getAttribute('chipGround');
        const triangles = (geometry.getIndex()?.count ?? 0) / 3;
        for (let i = 0; i < geometry.instanceCount; i++) {
          counts.set(`${at.getX(i)},${at.getZ(i)}`, triangles);
        }
      }
      return counts;
    }
    try {
      const small = triangleCounts(240);
      const large = triangleCounts(1600);
      expect(new Set(large.keys())).toEqual(new Set(small.keys()));
      expect([...large].some(([key, n]) => n > 1200 && n > (small.get(key) ?? 0))).toBe(true);
      expect(Math.min(...large.values())).toBeLessThan(100);
    } finally {
      patch.dispose();
      ground.dispose();
    }
  });
});
