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

  describe('edge fan structure', () => {
    it('generates consistent fan pattern for north edge', () => {
      // Resolution 4, north neighbor has stepRatio 2
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
      
      // All north edge triangles should form a fan from edgeLeft (index 0)
      // Each triangle should contain edgeLeft (0) or edgeRight (4)
      const edgeLeft = 0;
      const edgeRight = 4;
      
      // Verify fan structure: most triangles should share edgeLeft
      const trianglesWithEdgeLeft = northEdgeTriangles.filter(tri => tri.includes(edgeLeft));
      const trianglesWithEdgeRight = northEdgeTriangles.filter(tri => tri.includes(edgeRight));
      
      // Should have at least one triangle with each edge vertex
      expect(trianglesWithEdgeLeft.length).toBeGreaterThan(0);
      expect(trianglesWithEdgeRight.length).toBeGreaterThan(0);
      
      // All triangles should be valid (no duplicate vertices in same triangle)
      for (const tri of triangles) {
        expect(new Set(tri).size).toBe(3); // All 3 vertices should be unique
      }
    });

    it('generates consistent fan pattern for all edges', () => {
      // Test all four edges with lower LOD neighbors
      const testCases: Array<{ neighborLods: NeighborLods; description: string }> = [
        { neighborLods: { north: 1, south: 0, east: 0, west: 0 }, description: 'north' },
        { neighborLods: { north: 0, south: 1, east: 0, west: 0 }, description: 'south' },
        { neighborLods: { north: 0, south: 0, east: 1, west: 0 }, description: 'east' },
        { neighborLods: { north: 0, south: 0, east: 0, west: 1 }, description: 'west' },
      ];
      
      for (const { neighborLods, description } of testCases) {
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
      }
    });
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
