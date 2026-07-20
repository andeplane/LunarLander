import { describe, it, expect, beforeEach } from 'vitest';
import {
  calculateStepRatio,
  getResolutionForLevel,
  getVertexIndex,
  generateGridIndices,
  isOnEdge,
  computeStitchedIndices,
  clearStitchCache,
  getStitchCacheSize,
} from './EdgeStitcher';
import type { NeighborLods } from './LodUtils';

describe(calculateStepRatio.name, () => {
  it.each([
    { myRes: 512, neighborRes: 512, expected: 1 },
    { myRes: 512, neighborRes: 256, expected: 2 },
    { myRes: 512, neighborRes: 128, expected: 4 },
    { myRes: 512, neighborRes: 64, expected: 8 },
    { myRes: 256, neighborRes: 128, expected: 2 },
    { myRes: 256, neighborRes: 64, expected: 4 },
    { myRes: 128, neighborRes: 64, expected: 2 },
  ])('returns $expected for myRes=$myRes, neighborRes=$neighborRes', 
    ({ myRes, neighborRes, expected }) => {
      expect(calculateStepRatio(myRes, neighborRes)).toBe(expected);
    }
  );

  it('returns 1 when neighbor has higher resolution', () => {
    expect(calculateStepRatio(128, 256)).toBe(1);
    expect(calculateStepRatio(64, 512)).toBe(1);
  });

  it('returns 1 when neighbor resolution is 0 or negative', () => {
    expect(calculateStepRatio(512, 0)).toBe(1);
    expect(calculateStepRatio(512, -1)).toBe(1);
  });
});

describe(getResolutionForLevel.name, () => {
  const lodLevels = [512, 256, 128, 64];

  it.each([
    { level: 0, expected: 512 },
    { level: 1, expected: 256 },
    { level: 2, expected: 128 },
    { level: 3, expected: 64 },
  ])('returns $expected for level $level', ({ level, expected }) => {
    expect(getResolutionForLevel(level, lodLevels)).toBe(expected);
  });

  it('returns first level for negative index', () => {
    expect(getResolutionForLevel(-1, lodLevels)).toBe(512);
  });

  it('returns first level for index beyond array', () => {
    expect(getResolutionForLevel(10, lodLevels)).toBe(512);
  });
});

describe(getVertexIndex.name, () => {
  it('returns correct index for origin', () => {
    expect(getVertexIndex(0, 0, 4)).toBe(0);
  });

  it('returns correct index for end of first row', () => {
    // Resolution 4 means 5 vertices per row (0,1,2,3,4)
    expect(getVertexIndex(4, 0, 4)).toBe(4);
  });

  it('returns correct index for start of second row', () => {
    // Resolution 4 means 5 vertices per row
    expect(getVertexIndex(0, 1, 4)).toBe(5);
  });

  it('returns correct index for last vertex', () => {
    // 4x4 grid has 5x5=25 vertices, last is at (4,4) = index 24
    expect(getVertexIndex(4, 4, 4)).toBe(24);
  });

  it('calculates index correctly for larger grid', () => {
    // Resolution 128 means 129 vertices per row
    expect(getVertexIndex(0, 1, 128)).toBe(129);
    expect(getVertexIndex(128, 0, 128)).toBe(128);
    expect(getVertexIndex(128, 128, 128)).toBe(129 * 129 - 1);
  });
});

describe(generateGridIndices.name, () => {
  it('generates correct number of indices for small grid', () => {
    const indices = generateGridIndices(2);
    // 2x2 grid = 4 quads = 8 triangles = 24 indices
    expect(indices.length).toBe(2 * 2 * 2 * 3);
  });

  it('generates correct number of indices for larger grid', () => {
    const indices = generateGridIndices(4);
    // 4x4 grid = 16 quads = 32 triangles = 96 indices
    expect(indices.length).toBe(4 * 4 * 2 * 3);
  });

  it('generates valid vertex references', () => {
    const resolution = 4;
    const indices = generateGridIndices(resolution);
    const maxVertexIndex = (resolution + 1) * (resolution + 1) - 1;
    
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(maxVertexIndex);
    }
  });

  it('generates indices in groups of 3 (triangles)', () => {
    const indices = generateGridIndices(4);
    expect(indices.length % 3).toBe(0);
  });
});

describe(isOnEdge.name, () => {
  const resolution = 4;

  it.each([
    { x: 0, z: 0, edge: 'north' as const, expected: true },
    { x: 2, z: 0, edge: 'north' as const, expected: true },
    { x: 4, z: 0, edge: 'north' as const, expected: true },
    { x: 0, z: 1, edge: 'north' as const, expected: false },
  ])('north edge: ($x,$z) is $expected', ({ x, z, edge, expected }) => {
    expect(isOnEdge(x, z, resolution, edge)).toBe(expected);
  });

  it.each([
    { x: 0, z: 4, edge: 'south' as const, expected: true },
    { x: 2, z: 4, edge: 'south' as const, expected: true },
    { x: 0, z: 3, edge: 'south' as const, expected: false },
  ])('south edge: ($x,$z) is $expected', ({ x, z, edge, expected }) => {
    expect(isOnEdge(x, z, resolution, edge)).toBe(expected);
  });

  it.each([
    { x: 0, z: 0, edge: 'west' as const, expected: true },
    { x: 0, z: 2, edge: 'west' as const, expected: true },
    { x: 1, z: 0, edge: 'west' as const, expected: false },
  ])('west edge: ($x,$z) is $expected', ({ x, z, edge, expected }) => {
    expect(isOnEdge(x, z, resolution, edge)).toBe(expected);
  });

  it.each([
    { x: 4, z: 0, edge: 'east' as const, expected: true },
    { x: 4, z: 2, edge: 'east' as const, expected: true },
    { x: 3, z: 0, edge: 'east' as const, expected: false },
  ])('east edge: ($x,$z) is $expected', ({ x, z, edge, expected }) => {
    expect(isOnEdge(x, z, resolution, edge)).toBe(expected);
  });
});

describe(computeStitchedIndices.name, () => {
  beforeEach(() => {
    clearStitchCache();
  });

  describe('when all neighbors have same LOD', () => {
    it('returns standard grid indices', () => {
      const neighborLods: NeighborLods = { north: 0, south: 0, east: 0, west: 0 };
      const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      const standardIndices = generateGridIndices(4);
      
      expect(indices.length).toBe(standardIndices.length);
    });
  });

  describe('when one neighbor has lower LOD', () => {
    it('generates valid indices with north neighbor lower', () => {
      // Use small resolution for easier testing
      const neighborLods: NeighborLods = { north: 1, south: 0, east: 0, west: 0 };
      const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      
      // Should have valid indices
      expect(indices.length).toBeGreaterThan(0);
      expect(indices.length % 3).toBe(0);
      
      // All indices should be valid vertex references
      const maxVertexIndex = 5 * 5 - 1; // (4+1)^2 - 1
      for (const idx of indices) {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThanOrEqual(maxVertexIndex);
      }
    });

    it('generates valid indices with south neighbor lower', () => {
      const neighborLods: NeighborLods = { north: 0, south: 1, east: 0, west: 0 };
      const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      
      expect(indices.length).toBeGreaterThan(0);
      expect(indices.length % 3).toBe(0);
    });

    it('generates valid indices with east neighbor lower', () => {
      const neighborLods: NeighborLods = { north: 0, south: 0, east: 1, west: 0 };
      const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      
      expect(indices.length).toBeGreaterThan(0);
      expect(indices.length % 3).toBe(0);
    });

    it('generates valid indices with west neighbor lower', () => {
      const neighborLods: NeighborLods = { north: 0, south: 0, east: 0, west: 1 };
      const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      
      expect(indices.length).toBeGreaterThan(0);
      expect(indices.length % 3).toBe(0);
    });
  });

  describe('when multiple neighbors have lower LOD', () => {
    it('generates valid indices with two adjacent lower neighbors', () => {
      const neighborLods: NeighborLods = { north: 1, south: 0, east: 1, west: 0 };
      const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      
      expect(indices.length).toBeGreaterThan(0);
      expect(indices.length % 3).toBe(0);
    });

    it('generates valid indices with all neighbors lower', () => {
      const neighborLods: NeighborLods = { north: 1, south: 1, east: 1, west: 1 };
      const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      
      expect(indices.length).toBeGreaterThan(0);
      expect(indices.length % 3).toBe(0);
    });
  });

  describe('caching', () => {
    it('caches results for identical configurations', () => {
      const neighborLods: NeighborLods = { north: 1, south: 0, east: 0, west: 0 };
      
      const indices1 = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      const indices2 = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      
      // Should be the same array reference (cached)
      expect(indices1).toBe(indices2);
      expect(getStitchCacheSize()).toBe(1);
    });

    it('creates separate cache entries for different configurations', () => {
      const neighborLods1: NeighborLods = { north: 1, south: 0, east: 0, west: 0 };
      const neighborLods2: NeighborLods = { north: 0, south: 1, east: 0, west: 0 };

      computeStitchedIndices(4, neighborLods1, 0, [4, 2, 1]);
      computeStitchedIndices(4, neighborLods2, 0, [4, 2, 1]);

      expect(getStitchCacheSize()).toBe(2);
    });

    it('evicts least-recently-used entries, not least-recently-inserted', () => {
      const maxCacheSize = 256;
      const lodLevels = [8, 4, 2, 1];

      // Fill the cache to capacity with distinct configurations
      const configs: NeighborLods[] = [];
      for (let n = 0; n < 4 && configs.length < maxCacheSize; n++) {
        for (let s = 0; s < 4 && configs.length < maxCacheSize; s++) {
          for (let e = 0; e < 4 && configs.length < maxCacheSize; e++) {
            for (let w = 0; w < 4 && configs.length < maxCacheSize; w++) {
              configs.push({ north: n, south: s, east: e, west: w });
            }
          }
        }
      }
      const results = configs.map((c) => computeStitchedIndices(8, c, 0, lodLevels));
      expect(getStitchCacheSize()).toBe(maxCacheSize);

      // Touch the oldest entry to refresh its recency
      expect(computeStitchedIndices(8, configs[0], 0, lodLevels)).toBe(results[0]);

      // Inserting a new configuration evicts the second-oldest entry,
      // not the recently-touched oldest one
      computeStitchedIndices(4, { north: 1, south: 0, east: 0, west: 0 }, 0, [4, 2, 1]);
      expect(getStitchCacheSize()).toBe(maxCacheSize);

      expect(computeStitchedIndices(8, configs[0], 0, lodLevels)).toBe(results[0]);
      expect(computeStitchedIndices(8, configs[1], 0, lodLevels)).not.toBe(results[1]);
    });
  });

  describe('with realistic LOD levels', () => {
    it('handles 512/256 transition', () => {
      // Simulating a chunk at LOD 0 (512) next to a chunk at LOD 1 (256)
      const neighborLods: NeighborLods = { north: 1, south: 0, east: 0, west: 0 };
      const indices = computeStitchedIndices(8, neighborLods, 0, [8, 4, 2, 1]);
      
      expect(indices.length).toBeGreaterThan(0);
      expect(indices.length % 3).toBe(0);
    });
  });

  describe('edge nearest-neighbor structure', () => {
    it('generates nearest-neighbor pattern for north edge', () => {
      // Resolution 4, north neighbor has stepRatio 2
      // Snapped edge vertices at x=0, 2, 4 (indices 0, 2, 4)
      const neighborLods: NeighborLods = { north: 1, south: 0, east: 0, west: 0 };
      const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
      
      // Extract triangles (groups of 3)
      const triangles: number[][] = [];
      for (let i = 0; i < indices.length; i += 3) {
        triangles.push([indices[i], indices[i + 1], indices[i + 2]]);
      }
      
      // North edge vertices are at z=0: indices 0, 1, 2, 3, 4
      // Interior vertices are at z=1: indices 5, 6, 7, 8, 9
      const northEdgeVertices = new Set([0, 1, 2, 3, 4]);
      
      // Find triangles that touch the north edge (contain a north edge vertex)
      const northEdgeTriangles = triangles.filter(tri => 
        tri.some(v => northEdgeVertices.has(v))
      );
      
      // With stepRatio=2, snapped positions are at x=0, 2, 4
      // Interior vertices at x=0,1 should snap to edge x=0 (index 0)
      // Interior vertices at x=2,3 should snap to edge x=2 (index 2)
      // Interior vertices at x=4 should snap to edge x=4 (index 4)
      const snappedEdgeVertices = new Set([0, 2, 4]); // x=0, x=2, x=4
      
      // Verify nearest-neighbor: each triangle should connect to a snapped edge vertex
      for (const tri of northEdgeTriangles) {
        const hasSnappedEdge = tri.some(v => snappedEdgeVertices.has(v));
        expect(hasSnappedEdge).toBe(true);
      }
      
      // Verify triangles connect interior vertices to their nearest snapped edge
      // Interior x=0,1 (indices 5,6) should connect to edge x=0 (index 0)
      const trianglesWithEdge0 = northEdgeTriangles.filter(tri => tri.includes(0));
      // Interior vertices 5,6 should connect to edge 0
      expect(trianglesWithEdge0.length).toBeGreaterThan(0);
      
      // All triangles should be valid (no duplicate vertices in same triangle)
      for (const tri of triangles) {
        expect(new Set(tri).size).toBe(3); // All 3 vertices should be unique
      }
    });

    it('generates nearest-neighbor pattern for all edges', () => {
      // Test all four edges with lower LOD neighbors
      const testCases: Array<{ neighborLods: NeighborLods; description: string }> = [
        { neighborLods: { north: 1, south: 0, east: 0, west: 0 }, description: 'north' },
        { neighborLods: { north: 0, south: 1, east: 0, west: 0 }, description: 'south' },
        { neighborLods: { north: 0, south: 0, east: 1, west: 0 }, description: 'east' },
        { neighborLods: { north: 0, south: 0, east: 0, west: 1 }, description: 'west' },
      ];
      
      for (const { neighborLods } of testCases) {
        const indices = computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
        
        // Extract triangles
        const triangles: number[][] = [];
        for (let i = 0; i < indices.length; i += 3) {
          triangles.push([indices[i], indices[i + 1], indices[i + 2]]);
        }
        
        // Verify all triangles are valid (no degenerate triangles)
        for (const tri of triangles) {
          expect(new Set(tri).size).toBe(3); // All vertices unique
          expect(tri.every(v => v >= 0 && v < 25)).toBe(true); // Valid vertex indices (5x5 grid)
        }
        
        // Should have generated triangles
        expect(triangles.length).toBeGreaterThan(0);
        
        // With stepRatio=2, snapped positions should be at multiples of 2
        // Verify that edge triangles connect to snapped vertices (not all fan from one point)
        // This is a basic sanity check - the detailed nearest-neighbor verification
        // is done in the specific edge test above
      }
    });
  });
});

describe('corner correctness where two stitched edges meet', () => {
  beforeEach(() => {
    clearStitchCache();
  });

  interface Point {
    x: number;
    z: number;
  }

  function toCoord(index: number, resolution: number): Point {
    const vertsPerRow = resolution + 1;
    return { x: index % vertsPerRow, z: Math.floor(index / vertsPerRow) };
  }

  function extractTriangles(indices: Uint32Array): [number, number, number][] {
    const triangles: [number, number, number][] = [];
    for (let i = 0; i < indices.length; i += 3) {
      triangles.push([indices[i], indices[i + 1], indices[i + 2]]);
    }
    return triangles;
  }

  /** Twice the signed area of triangle (p, q, r) in grid coordinates */
  function signedDoubleArea(p: Point, q: Point, r: Point): number {
    return (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  }

  /** Strict point-in-triangle test (points are chosen off all mesh edges) */
  function triangleContains(p0: Point, p1: Point, p2: Point, pt: Point): boolean {
    const d0 = signedDoubleArea(p0, p1, pt);
    const d1 = signedDoubleArea(p1, p2, pt);
    const d2 = signedDoubleArea(p2, p0, pt);
    return (d0 < 0 && d1 < 0 && d2 < 0) || (d0 > 0 && d1 > 0 && d2 > 0);
  }

  interface StitchSteps {
    north: number;
    south: number;
    east: number;
    west: number;
  }

  /**
   * Full structural validation of a stitched index buffer:
   * - no degenerate or duplicated triangles, consistent winding
   * - triangle areas sum to the full grid area
   * - a dense grid of interior sample points is each covered by exactly one
   *   triangle (no overlapping triangles, no holes - watertight)
   * - vertices used on a stitched border lie on snapped (coarse) positions,
   *   so the coarse neighbor sees no T-junctions
   * - no used vertex lies strictly inside another triangle's edge
   *   (no internal T-junctions)
   */
  function assertStitchedMeshIsSound(
    indices: Uint32Array,
    resolution: number,
    steps: StitchSteps
  ): void {
    const triangles = extractTriangles(indices);
    expect(triangles.length).toBeGreaterThan(0);

    // No degenerate triangles, consistent winding
    const seen = new Set<string>();
    let totalDoubleArea = 0;
    for (const tri of triangles) {
      expect(new Set(tri).size).toBe(3);
      const [a, b, c] = tri.map((v) => toCoord(v, resolution));
      const doubleArea = signedDoubleArea(a, b, c);
      expect(doubleArea).toBeLessThan(0); // same orientation as the base grid
      totalDoubleArea += -doubleArea;

      // Canonical form for duplicate detection (any vertex order)
      const key = [...tri].sort((x, y) => x - y).join(',');
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }

    // Areas must sum exactly to the full grid area (all areas are multiples
    // of 0.5, so this is exact in floating point)
    expect(totalDoubleArea).toBe(2 * resolution * resolution);

    // Every interior sample point must be covered by exactly one triangle.
    // Offsets are chosen so no sample lies on any mesh edge (edges only run
    // between integer lattice points with small direction components).
    const offsets: Point[] = [
      { x: 0.37, z: 0.11 },
      { x: 0.11, z: 0.37 },
      { x: 0.68, z: 0.29 },
      { x: 0.29, z: 0.68 },
    ];
    const coords = triangles.map(
      (tri) => tri.map((v) => toCoord(v, resolution)) as [Point, Point, Point]
    );
    for (let cellZ = 0; cellZ < resolution; cellZ++) {
      for (let cellX = 0; cellX < resolution; cellX++) {
        for (const offset of offsets) {
          const pt = { x: cellX + offset.x, z: cellZ + offset.z };
          let cover = 0;
          for (const [p0, p1, p2] of coords) {
            if (triangleContains(p0, p1, p2, pt)) cover++;
          }
          expect(
            cover,
            `point (${pt.x},${pt.z}) covered ${cover} times`
          ).toBe(1);
        }
      }
    }

    // Vertices used on a stitched border must be snapped to the coarse
    // neighbor's grid - otherwise the neighbor sees a T-junction
    const usedVertices = new Set<number>(indices);
    for (const v of usedVertices) {
      const { x, z } = toCoord(v, resolution);
      if (steps.north > 1 && z === 0) {
        expect(x % steps.north, `north border vertex (${x},${z}) not snapped`).toBe(0);
      }
      if (steps.south > 1 && z === resolution) {
        expect(x % steps.south, `south border vertex (${x},${z}) not snapped`).toBe(0);
      }
      if (steps.west > 1 && x === 0) {
        expect(z % steps.west, `west border vertex (${x},${z}) not snapped`).toBe(0);
      }
      if (steps.east > 1 && x === resolution) {
        expect(z % steps.east, `east border vertex (${x},${z}) not snapped`).toBe(0);
      }
    }

    // No used vertex may lie strictly inside another triangle's edge
    // (internal T-junction: cracks under displacement)
    const usedCoords = [...usedVertices].map((v) => ({ v, p: toCoord(v, resolution) }));
    for (const [t0, t1, t2] of triangles) {
      const edges: [number, number][] = [
        [t0, t1],
        [t1, t2],
        [t2, t0],
      ];
      for (const [e0, e1] of edges) {
        const p = toCoord(e0, resolution);
        const q = toCoord(e1, resolution);
        for (const { v, p: r } of usedCoords) {
          if (v === e0 || v === e1) continue;
          // Collinear (exact integer arithmetic) and strictly between p and q?
          if (signedDoubleArea(p, q, r) !== 0) continue;
          const dot = (r.x - p.x) * (q.x - p.x) + (r.z - p.z) * (q.z - p.z);
          const lenSq = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
          const strictlyInside = dot > 0 && dot < lenSq;
          expect(
            strictlyInside,
            `vertex (${r.x},${r.z}) lies inside edge (${p.x},${p.z})-(${q.x},${q.z})`
          ).toBe(false);
        }
      }
    }
  }

  function stepsFor(
    resolution: number,
    neighborLods: NeighborLods,
    lodLevels: readonly number[]
  ): StitchSteps {
    return {
      north: calculateStepRatio(resolution, getResolutionForLevel(neighborLods.north, lodLevels)),
      south: calculateStepRatio(resolution, getResolutionForLevel(neighborLods.south, lodLevels)),
      east: calculateStepRatio(resolution, getResolutionForLevel(neighborLods.east, lodLevels)),
      west: calculateStepRatio(resolution, getResolutionForLevel(neighborLods.west, lodLevels)),
    };
  }

  const lodLevels4 = [4, 2, 1] as const;
  const lodLevels8 = [8, 4, 2, 1] as const;

  it.each([
    { name: 'north+west coarser (step 2)', res: 4, lods: lodLevels4, n: { north: 1, south: 0, east: 0, west: 1 } },
    { name: 'north+east coarser (step 2)', res: 4, lods: lodLevels4, n: { north: 1, south: 0, east: 1, west: 0 } },
    { name: 'south+west coarser (step 2)', res: 4, lods: lodLevels4, n: { north: 0, south: 1, east: 0, west: 1 } },
    { name: 'south+east coarser (step 2)', res: 4, lods: lodLevels4, n: { north: 0, south: 1, east: 1, west: 0 } },
    { name: 'all neighbors coarser (step 2)', res: 4, lods: lodLevels4, n: { north: 1, south: 1, east: 1, west: 1 } },
    { name: 'north+west coarser (step 4)', res: 8, lods: lodLevels8, n: { north: 2, south: 0, east: 0, west: 2 } },
    { name: 'mixed levels: north step 4, west step 2', res: 8, lods: lodLevels8, n: { north: 2, south: 0, east: 0, west: 1 } },
    { name: 'mixed levels: north step 2, east step 4', res: 8, lods: lodLevels8, n: { north: 1, south: 0, east: 2, west: 0 } },
    { name: 'all coarser, mixed steps', res: 8, lods: lodLevels8, n: { north: 1, south: 2, east: 1, west: 2 } },
    { name: 'three coarser: north, east, west', res: 8, lods: lodLevels8, n: { north: 1, south: 0, east: 1, west: 1 } },
  ])('produces a watertight, non-overlapping mesh for $name', ({ res, lods, n }) => {
    const indices = computeStitchedIndices(res, n, 0, lods);
    assertStitchedMeshIsSound(indices, res, stepsFor(res, n, lods));
  });

  it('emits the corner cell exactly once when north and west are both coarser', () => {
    // Hand-traced regression for the issue: with step 2 on both edges, the
    // corner cell used to be double-covered and the north fan pinned the
    // unsnapped west-border vertex (0,1).
    const neighborLods: NeighborLods = { north: 1, south: 0, east: 0, west: 1 };
    const indices = computeStitchedIndices(4, neighborLods, 0, lodLevels4);
    const usedVertices = new Set<number>(indices);

    // (0,1) is on the west border but not on the coarse west grid; (1,0) is
    // on the north border but not on the coarse north grid. Neither may be
    // referenced.
    expect(usedVertices.has(getVertexIndex(0, 1, 4))).toBe(false);
    expect(usedVertices.has(getVertexIndex(1, 0, 4))).toBe(false);
  });

  it('remains sound when only one edge is stitched (corners untouched)', () => {
    const singleEdgeConfigs: NeighborLods[] = [
      { north: 1, south: 0, east: 0, west: 0 },
      { north: 0, south: 1, east: 0, west: 0 },
      { north: 0, south: 0, east: 1, west: 0 },
      { north: 0, south: 0, east: 0, west: 1 },
    ];
    for (const neighborLods of singleEdgeConfigs) {
      clearStitchCache();
      const indices = computeStitchedIndices(4, neighborLods, 0, lodLevels4);
      assertStitchedMeshIsSound(indices, 4, stepsFor(4, neighborLods, lodLevels4));
    }
  });
});

describe('clearStitchCache', () => {
  it('clears all cached entries', () => {
    const neighborLods: NeighborLods = { north: 1, south: 0, east: 0, west: 0 };
    computeStitchedIndices(4, neighborLods, 0, [4, 2, 1]);
    
    expect(getStitchCacheSize()).toBeGreaterThan(0);
    
    clearStitchCache();
    
    expect(getStitchCacheSize()).toBe(0);
  });
});
