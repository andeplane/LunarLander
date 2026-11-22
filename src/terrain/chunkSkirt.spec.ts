import { describe, expect, it } from 'vitest';
import {
  appendSkirtIndices,
  chunkSkirtDepth,
  hasSkirtVertices,
  skirtIndexCount,
  skirtRingVertex,
  skirtVertexCount,
  writeSkirtIndices,
  writeSkirtVertices,
} from './chunkSkirt';

/** A flat (resolution + 1)² grid with room for the skirt, 10 m apart. */
function flatGrid(resolution: number): { positions: Float32Array; normals: Float32Array } {
  const side = resolution + 1;
  const count = side * side + skirtVertexCount(resolution);
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let z = 0; z < side; z++) {
    for (let x = 0; x < side; x++) {
      const i = (z * side + x) * 3;
      positions[i] = x * 10;
      positions[i + 1] = 5 + x + z * 0.5;
      positions[i + 2] = z * 10;
      normals[i + 1] = 1;
    }
  }
  return { positions, normals };
}

describe(skirtRingVertex.name, () => {
  it('walks the perimeter once, starting along row 0', () => {
    const resolution = 3;
    const ring = Array.from({ length: skirtVertexCount(resolution) }, (_, k) =>
      skirtRingVertex(k, resolution)
    );

    expect(ring).toEqual([0, 1, 2, 3, 7, 11, 15, 14, 13, 12, 8, 4]);
    expect(new Set(ring).size).toBe(ring.length);
  });

  it('covers a single-cell chunk', () => {
    expect([0, 1, 2, 3].map((k) => skirtRingVertex(k, 1))).toEqual([0, 1, 3, 2]);
  });
});

describe(chunkSkirtDepth.name, () => {
  it('grows with the vertex spacing and never vanishes', () => {
    expect(chunkSkirtDepth(0)).toBeGreaterThan(0);
    expect(chunkSkirtDepth(100)).toBeGreaterThan(chunkSkirtDepth(25));
    expect(chunkSkirtDepth(100)).toBeGreaterThanOrEqual(100);
  });
});

describe(writeSkirtVertices.name, () => {
  it('hangs a lowered copy of every perimeter vertex after the grid', () => {
    const resolution = 4;
    const { positions, normals } = flatGrid(resolution);
    writeSkirtVertices(positions, normals, resolution, 7);

    const base = (resolution + 1) * (resolution + 1);
    for (let k = 0; k < skirtVertexCount(resolution); k++) {
      const top = skirtRingVertex(k, resolution) * 3;
      const bottom = (base + k) * 3;
      expect(positions[bottom]).toBe(positions[top]);
      expect(positions[bottom + 1]).toBeCloseTo(positions[top + 1] - 7, 5);
      expect(positions[bottom + 2]).toBe(positions[top + 2]);
      expect(Array.from(normals.subarray(bottom, bottom + 3))).toEqual([0, 1, 0]);
    }
  });
});

describe(writeSkirtIndices.name, () => {
  it('builds a closed wall whose faces point away from the chunk', () => {
    const resolution = 4;
    const { positions, normals } = flatGrid(resolution);
    writeSkirtVertices(positions, normals, resolution, 7);
    const indices = new Uint32Array(3 + skirtIndexCount(resolution));
    const end = writeSkirtIndices(indices, 3, resolution);

    expect(end).toBe(indices.length);
    const centre = (resolution * 10) / 2;
    const point = (v: number): [number, number, number] => [
      positions[v * 3],
      positions[v * 3 + 1],
      positions[v * 3 + 2],
    ];
    for (let i = 3; i < end; i += 3) {
      const [ax, ay, az] = point(indices[i]);
      const [bx, by, bz] = point(indices[i + 1]);
      const [cx, cy, cz] = point(indices[i + 2]);
      // Face normal = (b - a) x (c - a)
      const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const outwardX = (ax + bx + cx) / 3 - centre;
      const outwardZ = (az + bz + cz) / 3 - centre;

      expect(ny).toBeCloseTo(0, 5);
      expect(nx * outwardX + nz * outwardZ).toBeGreaterThan(0);
    }
  });
});

describe(appendSkirtIndices.name, () => {
  it('keeps the grid indices and adds the wall after them', () => {
    const resolution = 2;
    const grid = new Uint32Array([0, 3, 1, 1, 3, 4]);
    const indices = appendSkirtIndices(grid, resolution);

    expect(indices.length).toBe(grid.length + skirtIndexCount(resolution));
    expect(Array.from(indices.subarray(0, 6))).toEqual(Array.from(grid));
    // First wall quad: perimeter vertices 0 and 1, skirt vertices 9 and 10
    expect(Array.from(indices.subarray(6, 12))).toEqual([0, 1, 9, 1, 10, 9]);
    // The last quad closes the ring back onto the first skirt vertex
    expect(Array.from(indices.subarray(indices.length - 6))).toEqual([3, 0, 16, 0, 9, 16]);
    expect(Array.from(grid)).toEqual([0, 3, 1, 1, 3, 4]);
  });
});

describe(hasSkirtVertices.name, () => {
  it('recognises a grid followed by its skirt', () => {
    expect(hasSkirtVertices(5 * 5 + 16, 4)).toBe(true);
    expect(hasSkirtVertices(5 * 5, 4)).toBe(false);
    expect(hasSkirtVertices(5 * 5 + 16, 8)).toBe(false);
  });
});
