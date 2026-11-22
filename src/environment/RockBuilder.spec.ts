import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { RockBuilder } from './RockBuilder';
import { ROCK_TIERS, rockArchetype, rockHeightRatio, rockTriangleBudget } from './rockPrototypes';

/** Build a geometry from a flat list of [x, y, z, x, y, z, ...] positions. */
function geometryFromPositions(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}

describe(`${RockBuilder.name}.calculateStableAxis`, () => {
  it('is deterministic for a regular geometry', () => {
    // Elongated point cloud: dominant inertia axis is well-defined
    const geometry = geometryFromPositions([
      3, 0.2, 0.1, -3, -0.2, 0.1, 2.5, 0.3, -0.2, -2.5, -0.1, 0.2, 1, 0.5, 0.4, -1, -0.4, -0.5,
    ]);

    const first = RockBuilder.calculateStableAxis(geometry);
    const second = RockBuilder.calculateStableAxis(geometry);

    expect(first.length()).toBeCloseTo(1, 6);
    expect(second.x).toBe(first.x);
    expect(second.y).toBe(first.y);
    expect(second.z).toBe(first.z);
  });

  it('is deterministic when power iteration needs a restart (degenerate tensor)', () => {
    // All vertices on the X axis: the inertia tensor is diag(0, s, s), so the
    // initial power-iteration guess (1, 0, 0) maps to the zero vector and the
    // restart path is taken. With the old Math.random() restart the result
    // varied between calls/sessions; it must now be reproducible.
    const geometry = geometryFromPositions([
      1, 0, 0, -1, 0, 0, 2, 0, 0, -2, 0, 0, 0.5, 0, 0, -0.5, 0, 0,
    ]);

    const first = RockBuilder.calculateStableAxis(geometry);
    const second = RockBuilder.calculateStableAxis(geometry);

    expect(Number.isFinite(first.x)).toBe(true);
    expect(Number.isFinite(first.y)).toBe(true);
    expect(Number.isFinite(first.z)).toBe(true);
    expect(first.length()).toBeCloseTo(1, 6);

    // Deterministic across repeated calls
    expect(second.x).toBe(first.x);
    expect(second.y).toBe(first.y);
    expect(second.z).toBe(first.z);

    // The restart direction (0, 1, 0) is an eigenvector of diag(0, s, s), so
    // the iteration must converge to an axis perpendicular to X
    expect(Math.abs(first.x)).toBeLessThan(1e-6);
  });
});

/** Bounding box of a geometry's positions. */
function bounds(geometry: BufferGeometry): { min: number[]; max: number[] } {
  const position = geometry.getAttribute('position');
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.count; i++) {
    const p = [position.getX(i), position.getY(i), position.getZ(i)];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}

function triangleCount(geometry: BufferGeometry): number {
  return (geometry.getIndex()?.count ?? 0) / 3;
}

/** Number of vertices that share their position with an earlier vertex (hard edges). */
function splitVertexCount(geometry: BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const seen = new Set<string>();
  let split = 0;
  for (let i = 0; i < position.count; i++) {
    const key = `${position.getX(i)},${position.getY(i)},${position.getZ(i)}`;
    if (seen.has(key)) {
      split++;
    }
    seen.add(key);
  }
  return split;
}

describe(`${RockBuilder.name}.generate`, () => {
  it('is deterministic per seed and detail', () => {
    const first = RockBuilder.generate(5, { detail: 3 });
    const second = RockBuilder.generate(5, { detail: 3 });
    expect(second.getAttribute('position').array).toEqual(first.getAttribute('position').array);
    expect(second.getAttribute('normal').array).toEqual(first.getAttribute('normal').array);
    expect(second.getIndex()?.array).toEqual(first.getIndex()?.array);
  });

  it('gives different seeds different shapes', () => {
    const a = RockBuilder.generate(0, { detail: 2 }).getAttribute('position').array;
    const b = RockBuilder.generate(3, { detail: 2 }).getAttribute('position').array;
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('stays within the triangle budget of every detail tier without losing most of it', () => {
    for (const tier of ROCK_TIERS) {
      for (const seed of [0, 1, 2, 4]) {
        const triangles = triangleCount(RockBuilder.generate(seed, { detail: tier.detail }));
        expect(Number.isInteger(triangles)).toBe(true);
        expect(triangles).toBeLessThanOrEqual(rockTriangleBudget(tier.detail));
        expect(triangles).toBeGreaterThanOrEqual(rockTriangleBudget(tier.detail) * 0.6);
      }
    }
  });

  it('keeps the meshes of small rocks between 40 and 200 triangles', () => {
    for (let seed = 0; seed < 8; seed++) {
      for (const detail of [1, 2]) {
        const triangles = triangleCount(RockBuilder.generate(seed, { detail }));
        expect(triangles).toBeGreaterThanOrEqual(40);
        expect(triangles).toBeLessThanOrEqual(200);
      }
    }
  });

  it('rests on y = 0 with a unit footprint and the canonical height of its shape', () => {
    for (let seed = 0; seed < 12; seed++) {
      for (const detail of [1, 3, 7]) {
        const { min, max } = bounds(RockBuilder.generate(seed, { detail }));
        expect(min[1]).toBeCloseTo(0, 5);
        expect(max[1]).toBeCloseTo(rockHeightRatio(seed), 5);
        expect(Math.max(max[0] - min[0], max[2] - min[2])).toBeCloseTo(1, 5);
        expect(min[0] + max[0]).toBeCloseTo(0, 5);
        expect(min[2] + max[2]).toBeCloseTo(0, 5);
      }
    }
  });

  it('stands stably: lower than wide, with most of its volume over a broad base', () => {
    for (let seed = 0; seed < 12; seed++) {
      const geometry = RockBuilder.generate(seed, { detail: 3 });
      const { min, max } = bounds(geometry);
      expect(max[1]).toBeLessThan(1);
      // Neither horizontal extent collapses to a blade
      expect(Math.min(max[0] - min[0], max[2] - min[2])).toBeGreaterThan(0.35);
    }
  });

  it('produces finite positions, unit normals pointing outwards and valid indices', () => {
    for (let seed = 0; seed < 8; seed++) {
      const geometry = RockBuilder.generate(seed, { detail: 3 });
      const position = geometry.getAttribute('position');
      const normal = geometry.getAttribute('normal');
      const index = geometry.getIndex();
      expect(index).not.toBeNull();
      expect(normal.count).toBe(position.count);

      const center = [0, rockHeightRatio(seed) / 2, 0];
      let outward = 0;
      for (let i = 0; i < position.count; i++) {
        const p = [position.getX(i), position.getY(i), position.getZ(i)];
        const n = [normal.getX(i), normal.getY(i), normal.getZ(i)];
        expect(p.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 4);
        if ((p[0] - center[0]) * n[0] + (p[1] - center[1]) * n[1] + (p[2] - center[2]) * n[2] > 0) {
          outward++;
        }
      }
      // Chips and re-entrant cuts tilt a few normals; a flipped winding would give ~0
      expect(outward / position.count).toBeGreaterThan(0.85);

      for (let i = 0; i < (index?.count ?? 0); i++) {
        expect(index?.getX(i)).toBeLessThan(position.count);
      }
    }
  });

  it('has no degenerate triangles', () => {
    const geometry = RockBuilder.generate(2, { detail: 3 });
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    const corner = (i: number): Vector3 =>
      new Vector3().fromBufferAttribute(position, index?.getX(i) ?? 0);
    for (let t = 0; t < triangleCount(geometry); t++) {
      const a = corner(t * 3);
      const b = corner(t * 3 + 1);
      const c = corner(t * 3 + 2);
      const area = b.sub(a).cross(c.sub(a)).length() / 2;
      expect(area).toBeGreaterThan(0);
    }
  });

  it('is angular: facets meet in hard edges, which a 180° crease angle smooths away', () => {
    for (const seed of [0, 1, 2]) {
      const crisp = RockBuilder.generate(seed, { detail: 7 });
      const smooth = RockBuilder.generate(seed, { detail: 7, creaseAngle: 180 });
      expect(splitVertexCount(crisp)).toBeGreaterThan(20);
      // What is left are vertices snapped onto the same corner of the cut body
      expect(splitVertexCount(smooth)).toBeLessThan(splitVertexCount(crisp) / 2);
      expect(smooth.getAttribute('position').count).toBeLessThan(
        crisp.getAttribute('position').count
      );
    }
  });

  it('has large flat facets: many triangles share a normal direction', () => {
    const geometry = RockBuilder.generate(0, { detail: 7, roughness: 0 });
    const position = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const buckets = new Map<string, number>();
    const corner = (i: number): Vector3 =>
      new Vector3().fromBufferAttribute(position, index?.getX(i) ?? 0);
    const triangles = triangleCount(geometry);
    for (let t = 0; t < triangles; t++) {
      const a = corner(t * 3);
      const n = corner(t * 3 + 1)
        .sub(a)
        .cross(corner(t * 3 + 2).sub(a))
        .normalize();
      const key = `${Math.round(n.x * 20)},${Math.round(n.y * 20)},${Math.round(n.z * 20)}`;
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const largest = Math.max(...buckets.values());
    // A sphere of this detail puts under 1 % of its triangles in one bucket
    expect(largest / triangles).toBeGreaterThan(0.06);
  });

  it('applies the roughness and edge snapping options', () => {
    const base = Array.from(RockBuilder.generate(1, { detail: 3 }).getAttribute('position').array);
    const smooth = Array.from(
      RockBuilder.generate(1, { detail: 3, roughness: 0 }).getAttribute('position').array
    );
    const unsnapped = RockBuilder.generate(1, { detail: 3, edgeSnap: 0 });
    expect(smooth).not.toEqual(base);
    expect(Array.from(unsnapped.getAttribute('position').array)).not.toEqual(base);
    expect(triangleCount(unsnapped)).toBeLessThanOrEqual(rockTriangleBudget(3));
  });

  it('defaults to detail 3', () => {
    const byDefault = RockBuilder.generate(6);
    const explicit = RockBuilder.generate(6, { detail: 3 });
    expect(byDefault.getAttribute('position').array).toEqual(
      explicit.getAttribute('position').array
    );
  });

  it('covers the archetypes: slabs are much flatter than blocks and wedges', () => {
    const heightOf = (seed: number): number =>
      bounds(RockBuilder.generate(seed, { detail: 2 })).max[1];
    const byArchetype = new Map<string, number[]>();
    for (let seed = 0; seed < 16; seed++) {
      const list = byArchetype.get(rockArchetype(seed)) ?? [];
      list.push(heightOf(seed));
      byArchetype.set(rockArchetype(seed), list);
    }
    expect([...byArchetype.keys()].sort()).toEqual(['block', 'round', 'slab', 'wedge']);
    const tallestSlab = Math.max(...(byArchetype.get('slab') ?? []));
    for (const family of ['block', 'wedge', 'round']) {
      expect(Math.min(...(byArchetype.get(family) ?? []))).toBeGreaterThan(tallestSlab);
    }
  });
});

/** Squared distance from p to its nearest vertex of a geometry (brute force). */
function nearestVertexDistance(geometry: BufferGeometry, p: Vector3): number {
  const position = geometry.getAttribute('position');
  let best = Infinity;
  for (let i = 0; i < position.count; i++) {
    const dx = position.getX(i) - p.x;
    const dy = position.getY(i) - p.y;
    const dz = position.getZ(i) - p.z;
    best = Math.min(best, dx * dx + dy * dy + dz * dz);
  }
  return Math.sqrt(best);
}

/**
 * Largest distance from a vertex of `a` (every 7th) to the nearest vertex of
 * `b`. Creased output duplicates vertices differently per mesh, so meshes are
 * compared by nearest vertex instead of by index.
 */
function largestDisplacement(a: BufferGeometry, b: BufferGeometry): number {
  const position = a.getAttribute('position');
  let worst = 0;
  const p = new Vector3();
  for (let i = 0; i < position.count; i += 7) {
    p.fromBufferAttribute(position, i);
    worst = Math.max(worst, nearestVertexDistance(b, p));
  }
  return worst;
}

describe(`${RockBuilder.name}.generate surface`, () => {
  it('rounds edges: with a bevel, fine meshes have far fewer hard (split) vertices', () => {
    for (const seed of [0, 3, 6]) {
      const worn = RockBuilder.generate(seed, { detail: 31, roughness: 0 });
      const sharp = RockBuilder.generate(seed, { detail: 31, roughness: 0, bevel: 0 });
      expect(splitVertexCount(worn)).toBeLessThan(splitVertexCount(sharp) * 0.85);
      // Some edges stay crisp
      expect(splitVertexCount(worn)).toBeGreaterThan(0);
    }
  });

  it('shades fine meshes smoothly: only a small share of vertices is split by creases', () => {
    for (const seed of [0, 1, 2, 3]) {
      const geometry = RockBuilder.generate(seed, { detail: 31 });
      const ratio = splitVertexCount(geometry) / geometry.getAttribute('position').count;
      expect(ratio).toBeLessThan(0.1);
    }
  });

  it('adds relief of a few percent of the diameter on fine meshes', () => {
    for (const seed of [0, 2, 4]) {
      const rough = RockBuilder.generate(seed, { detail: 23 });
      const smooth = RockBuilder.generate(seed, { detail: 23, roughness: 0 });
      const relief = largestDisplacement(rough, smooth);
      expect(relief).toBeGreaterThan(0.015);
      expect(relief).toBeLessThan(0.1);
    }
  });

  it('band-limits the relief: coarse tiers are a smoothed sampling of the same surface', () => {
    for (const seed of [0, 1, 2, 3, 4]) {
      const fine = RockBuilder.generate(seed, { detail: 31 });
      for (const detail of [3, 7, 15]) {
        const coarse = RockBuilder.generate(seed, { detail });
        // Every coarse vertex lies on (near) the fine surface; the fine mesh's
        // vertex spacing is about 0.02
        expect(largestDisplacement(coarse, fine)).toBeLessThan(0.06);
      }
    }
  });

  it('stays star-shaped: fine triangles face away from the rock center', () => {
    for (const seed of [0, 2, 5, 7]) {
      const geometry = RockBuilder.generate(seed, { detail: 23 });
      const position = geometry.getAttribute('position');
      const index = geometry.getIndex();
      const { min, max } = bounds(geometry);
      const center = new Vector3(
        (min[0] + max[0]) / 2,
        (min[1] + max[1]) / 2,
        (min[2] + max[2]) / 2
      );
      const corner = (i: number): Vector3 =>
        new Vector3().fromBufferAttribute(position, index?.getX(i) ?? 0);
      let outward = 0;
      const triangles = triangleCount(geometry);
      for (let t = 0; t < triangles; t++) {
        const a = corner(t * 3);
        const n = corner(t * 3 + 1)
          .sub(a)
          .cross(corner(t * 3 + 2).sub(a));
        if (n.dot(a.sub(center)) > 0) {
          outward++;
        }
      }
      expect(outward / triangles).toBeGreaterThan(0.97);
    }
  });

  it('keeps every vertex within the normalized bounds', () => {
    const geometry = RockBuilder.generate(9, { detail: 15 });
    const { min, max } = bounds(geometry);
    expect(min[1]).toBeCloseTo(0, 5);
    expect(max[1]).toBeCloseTo(rockHeightRatio(9), 5);
    expect(Math.max(max[0] - min[0], max[2] - min[2])).toBeCloseTo(1, 5);
  });

  it('leaves the cut body, and with it the resting pose, independent of the surface options', () => {
    // The pose comes from the sharp body alone: switching bevel and relief off
    // moves vertices by the relief only, never re-orients the rock
    const plain = RockBuilder.generate(4, { detail: 15, roughness: 0, bevel: 0 });
    const full = RockBuilder.generate(4, { detail: 15 });
    expect(largestDisplacement(full, plain)).toBeLessThan(0.12);
  });
});

describe(`${RockBuilder.name}.calculateStableAxis on generated rocks`, () => {
  it('points up for slabs: prototypes are built lying on their broadest face', () => {
    for (const seed of [1, 5, 9, 13]) {
      expect(rockArchetype(seed)).toBe('slab');
      // A vertex-cloud measure: detail 7 samples the surface evenly enough
      const axis = RockBuilder.calculateStableAxis(RockBuilder.generate(seed, { detail: 7 }));
      expect(Math.abs(axis.y)).toBeGreaterThan(0.8);
    }
  });
});

describe(`${RockBuilder.name}.generateLibrary`, () => {
  it('returns generate(i) for i = 0..count-1', () => {
    const library = RockBuilder.generateLibrary(3, { detail: 1 });
    expect(library).toHaveLength(3);
    for (let i = 0; i < library.length; i++) {
      expect(library[i].getAttribute('position').array).toEqual(
        RockBuilder.generate(i, { detail: 1 }).getAttribute('position').array
      );
    }
  });

  it('returns an empty library for a count of zero', () => {
    expect(RockBuilder.generateLibrary(0)).toEqual([]);
  });
});

describe(`${RockBuilder.name}.createLibraryBuilder`, () => {
  it('builds one prototype per call and then reports completion', () => {
    const builder = RockBuilder.createLibraryBuilder(2, { detail: 1 });
    expect(builder.total).toBe(2);
    expect(builder.builtCount).toBe(0);
    expect(builder.buildNext()).toBeInstanceOf(BufferGeometry);
    expect(builder.builtCount).toBe(1);
    expect(builder.buildNext()).toBeInstanceOf(BufferGeometry);
    expect(builder.buildNext()).toBeNull();
    expect(builder.builtCount).toBe(2);
  });

  it('stops after dispose', () => {
    const builder = RockBuilder.createLibraryBuilder(2, { detail: 1 });
    builder.dispose();
    expect(builder.buildNext()).toBeNull();
    expect(builder.builtCount).toBe(0);
  });
});
