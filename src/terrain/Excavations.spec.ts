import { BufferAttribute, BufferGeometry } from 'three';
import { expect, it } from 'vitest';
import { skirtVertexCount, writeSkirtVertices } from './chunkSkirt';
import { Excavations } from './Excavations';

function grid(res: number) {
  const geo = new BufferGeometry();
  const positions = new Float32Array(((res + 1) ** 2 + skirtVertexCount(res)) * 3);
  const normals = new Float32Array(positions.length);
  for (let z = 0; z <= res; z++)
    for (let x = 0; x <= res; x++) {
      const i = 3 * (z * (res + 1) + x);
      positions.set([(x * 8) / res - 4, 2, (z * 8) / res - 4], i);
      normals[i + 1] = 1;
    }
  writeSkirtVertices(positions, normals, res, 2);
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setAttribute('normal', new BufferAttribute(normals, 3));
  return geo;
}
it('cuts both sides of a chunk border, replays at streamed resolutions and restores the original mesh', () => {
  const field = new Excavations(),
    site = { x: 4, z: 0 };
  for (const [cx, res] of [
    [0, 16],
    [8, 8],
  ]) {
    const geo = grid(res);
    const pos = geo.getAttribute('position'),
      norm = geo.getAttribute('normal');
    const oldPos = pos.array.slice(),
      oldNorm = norm.array.slice();
    const center = (res / 2) * (res + 1) + (cx === 0 ? res : 0);
    field.apply(geo, res, cx, 0, 8, 8, site, 0.32);
    field.apply(geo, res, cx, 0, 8, 8, site, 0.96);
    expect(pos.getY(center)).toBeCloseTo(1.04);
    expect(pos.getY(0)).toBe(2);
    expect(norm.getZ(center + res + 1)).toBeLessThan(0);
    const skirt = (res + 1) ** 2 + (cx === 0 ? 1.5 : 3.5) * res;
    expect(pos.getY(skirt)).toBeCloseTo(-0.96);
    field.apply(geo, res, cx, 0, 8, 8, site, 0);
    expect(pos.array).toEqual(oldPos);
    expect(norm.array).toEqual(oldNorm);
  }
});
