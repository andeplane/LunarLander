import type { BufferAttribute, BufferGeometry } from 'three';
import { hasSkirtVertices, skirtRingVertex } from './chunkSkirt';

export interface DigSite {
  x: number;
  z: number;
}

const RADIUS = 1.9;

/** Apply a rounded spade cut to the actual grid, including its shading and perimeter skirt.
 * Keep only touched vertices so leaving the mode restores the exact worker output.
 * Survey sites are spaced farther apart than two brush diameters. */
export class Excavations {
  readonly depths = new Map<DigSite, number>();
  private originals = new WeakMap<BufferGeometry, Map<number, number[]>>();

  touches(site: DigSite, cx: number, cz: number, width: number, depth: number) {
    return (
      Math.abs(site.x - cx) <= width / 2 + RADIUS && Math.abs(site.z - cz) <= depth / 2 + RADIUS
    );
  }

  apply(
    geometry: BufferGeometry,
    resolution: number,
    cx: number,
    cz: number,
    width: number,
    depth: number,
    site: DigSite,
    cut: number
  ) {
    const positions = geometry.getAttribute('position') as BufferAttribute;
    const normals = geometry.getAttribute('normal') as BufferAttribute;
    const side = resolution + 1;
    const column = (x: number) => ((x - cx) / width + 0.5) * resolution;
    const row = (z: number) => ((z - cz) / depth + 0.5) * resolution;
    const firstX = Math.max(0, Math.ceil(column(site.x - RADIUS)));
    const lastX = Math.min(resolution, Math.floor(column(site.x + RADIUS)));
    const firstZ = Math.max(0, Math.ceil(row(site.z - RADIUS)));
    const lastZ = Math.min(resolution, Math.floor(row(site.z + RADIUS)));
    let originals = this.originals.get(geometry);
    if (!originals) {
      originals = new Map();
      this.originals.set(geometry, originals);
    }
    const write = (i: number) => {
      const x = positions.getX(i) + cx - site.x,
        z = positions.getZ(i) + cz - site.z;
      const weight = 1 - (x * x + z * z) / (RADIUS * RADIUS);
      if (weight <= 0) return;
      const base = originals.get(i) ?? [
        positions.getY(i),
        normals.getX(i),
        normals.getY(i),
        normals.getZ(i),
      ];
      if (cut > 0) originals.set(i, base);
      else originals.delete(i);
      positions.setY(i, base[0] - cut * weight * weight);
      const gradient = (4 * cut * weight) / (RADIUS * RADIUS);
      const nx = base[1] - base[2] * x * gradient,
        nz = base[3] - base[2] * z * gradient;
      const length = cut ? Math.hypot(nx, base[2], nz) : 1;
      normals.setXYZ(i, nx / length, base[2] / length, nz / length);
    };
    for (let j = firstZ; j <= lastZ && firstX <= lastX; j++) {
      for (let i = firstX; i <= lastX; i++) write(j * side + i);
      for (const attr of [positions, normals])
        attr.addUpdateRange((j * side + firstX) * 3, (lastX - firstX + 1) * 3);
    }
    if (
      (firstX === 0 || firstZ === 0 || lastX === resolution || lastZ === resolution) &&
      hasSkirtVertices(positions.count, resolution)
    ) {
      for (let k = 0; k < 4 * resolution; k++) {
        const top = skirtRingVertex(k, resolution);
        const x = top % side,
          z = Math.floor(top / side);
        if (x < firstX || x > lastX || z < firstZ || z > lastZ) continue;
        const i = side * side + k;
        write(i);
        for (const attr of [positions, normals]) attr.addUpdateRange(i * 3, 3);
      }
    }
    positions.needsUpdate = normals.needsUpdate = true;
  }
}
