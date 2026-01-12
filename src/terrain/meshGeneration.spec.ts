import { describe, it, expect } from 'vitest';
import {
  LOD_RESOLUTIONS,
  getResolutionForLOD,
  calculateVertexCount,
  calculateIndexCount,
  calculateTriangleCount,
  generateChunkMesh,
  getTerrainHeight,
  type NeighborLODs,
} from './meshGeneration';

// Helper to extract edge vertex heights from a mesh
function getEdgeVertexHeights(
  mesh: { vertices: Float32Array },
  resolution: number,
  edge: 'north' | 'south' | 'east' | 'west'
): number[] {
  const heights: number[] = [];
  
  for (let i = 0; i < resolution; i++) {
    let x: number, z: number;
    
    switch (edge) {
      case 'south': // z = 0
        x = i;
        z = 0;
        break;
      case 'north': // z = resolution - 1
        x = i;
        z = resolution - 1;
        break;
      case 'west': // x = 0
        x = 0;
        z = i;
        break;
      case 'east': // x = resolution - 1
        x = resolution - 1;
        z = i;
        break;
    }
    
    const vertexIndex = z * resolution + x;
    heights.push(mesh.vertices[vertexIndex * 3 + 1]); // Y component
  }
  
  return heights;
}

// Test that adjacent chunks have matching edges
describe('adjacent chunk edge matching', () => {
  it('should have matching edges between horizontally adjacent chunks with same LOD', () => {
    const lodLevel = 2;
    const size = 64;
    const neighborLODs: NeighborLODs = { north: lodLevel, south: lodLevel, east: lodLevel, west: lodLevel };
    
    // Chunk A at (0, 0) - its east edge
    const chunkA = generateChunkMesh(0, 0, lodLevel, size, neighborLODs);
    // Chunk B at (1, 0) - its west edge (shares edge with chunk A's east edge)
    const chunkB = generateChunkMesh(1, 0, lodLevel, size, neighborLODs);
    
    const resolution = getResolutionForLOD(lodLevel);
    
    const chunkAEastEdge = getEdgeVertexHeights(chunkA, resolution, 'east');
    const chunkBWestEdge = getEdgeVertexHeights(chunkB, resolution, 'west');
    
    // These edges share the same world X coordinate (size = 64)
    // They should have identical heights at each vertex
    expect(chunkAEastEdge).toEqual(chunkBWestEdge);
  });

  it('should have matching edges between vertically adjacent chunks with same LOD', () => {
    const lodLevel = 2;
    const size = 64;
    const neighborLODs: NeighborLODs = { north: lodLevel, south: lodLevel, east: lodLevel, west: lodLevel };
    
    // Chunk A at (0, 0) - its north edge
    const chunkA = generateChunkMesh(0, 0, lodLevel, size, neighborLODs);
    // Chunk B at (0, 1) - its south edge (shares edge with chunk A's north edge)
    const chunkB = generateChunkMesh(0, 1, lodLevel, size, neighborLODs);
    
    const resolution = getResolutionForLOD(lodLevel);
    
    const chunkANorthEdge = getEdgeVertexHeights(chunkA, resolution, 'north');
    const chunkBSouthEdge = getEdgeVertexHeights(chunkB, resolution, 'south');
    
    // These edges share the same world Z coordinate (size = 64)
    // They should have identical heights at each vertex
    expect(chunkANorthEdge).toEqual(chunkBSouthEdge);
  });

  // This test simulates what happens at runtime when chunks are built
  // at different times with different neighbor states
  describe('realistic runtime scenarios', () => {
    it('should match when chunk A built first, then chunk B with A as neighbor', () => {
      const lodLevel = 2;
      const size = 64;
      
      // Chunk A is built first - no neighbors exist yet
      // So it gets neighborLODs = { east: 2, ... } (same as its own LOD)
      const chunkANeighbors: NeighborLODs = { north: 2, south: 2, east: 2, west: 2 };
      const chunkA = generateChunkMesh(0, 0, lodLevel, size, chunkANeighbors);
      
      // Chunk B is built second - chunk A exists with LOD 2
      // So it gets neighborLODs = { west: 2, ... }
      const chunkBNeighbors: NeighborLODs = { north: 2, south: 2, east: 2, west: 2 };
      const chunkB = generateChunkMesh(1, 0, lodLevel, size, chunkBNeighbors);
      
      const resolution = getResolutionForLOD(lodLevel);
      const chunkAEastEdge = getEdgeVertexHeights(chunkA, resolution, 'east');
      const chunkBWestEdge = getEdgeVertexHeights(chunkB, resolution, 'west');
      
      expect(chunkAEastEdge).toEqual(chunkBWestEdge);
    });

    it('PROBLEM: chunk A upgrades LOD while chunk B stays at lower LOD', () => {
      const size = 64;
      
      // Step 1: Both chunks built at LOD 0
      // Chunk B at (1,0) is built at LOD 0
      const chunkB_lod0 = generateChunkMesh(1, 0, 0, size, { north: 0, south: 0, east: 0, west: 0 });
      
      // Step 2: Chunk A at (0,0) upgrades to LOD 2
      // When built, it sees neighbor B at LOD 0, so it stitches to LOD 0
      const chunkA_lod2 = generateChunkMesh(0, 0, 2, size, { north: 2, south: 2, east: 0, west: 2 });
      
      // The east edge of chunk A (LOD 2, stitched to LOD 0) 
      // should match the west edge of chunk B (LOD 0)
      const resA = getResolutionForLOD(2);
      const resB = getResolutionForLOD(0);
      
      const chunkAEastEdge = getEdgeVertexHeights(chunkA_lod2, resA, 'east');
      const chunkBWestEdge = getEdgeVertexHeights(chunkB_lod0, resB, 'west');
      
      // Chunk A has 7 vertices on its edge, chunk B has 2
      // The 2 vertices of chunk B should match 2 of chunk A's vertices (first and last)
      expect(chunkAEastEdge[0]).toBeCloseTo(chunkBWestEdge[0], 5);
      expect(chunkAEastEdge[resA - 1]).toBeCloseTo(chunkBWestEdge[resB - 1], 5);
      
      // The middle vertices of chunk A should be linearly interpolated
      // and should lie on the line between chunk B's two vertices
      const h0 = chunkBWestEdge[0];
      const h1 = chunkBWestEdge[1];
      for (let i = 1; i < resA - 1; i++) {
        const t = i / (resA - 1);
        const expectedHeight = h0 + t * (h1 - h0);
        expect(chunkAEastEdge[i]).toBeCloseTo(expectedHeight, 5);
      }
    });
  });
});

describe('LOD_RESOLUTIONS', () => {
  it('should have 5 levels', () => {
    expect(LOD_RESOLUTIONS).toHaveLength(5);
  });

  it('should match LOD_LEVELS from types', () => {
    // These must stay in sync with LOD_LEVELS in types/index.ts
    expect(LOD_RESOLUTIONS).toEqual([2, 4, 7, 9, 17]);
  });
});

describe(getResolutionForLOD.name, () => {
  it('should return 2 for LOD 0', () => {
    expect(getResolutionForLOD(0)).toBe(2);
  });

  it('should return 4 for LOD 1', () => {
    expect(getResolutionForLOD(1)).toBe(4);
  });

  it('should return 7 for LOD 2', () => {
    expect(getResolutionForLOD(2)).toBe(7);
  });

  it('should return 9 for LOD 3', () => {
    expect(getResolutionForLOD(3)).toBe(9);
  });

  it('should return 17 for LOD 4', () => {
    expect(getResolutionForLOD(4)).toBe(17);
  });

  it('should return fallback for invalid level', () => {
    expect(getResolutionForLOD(-1)).toBe(2);
    expect(getResolutionForLOD(99)).toBe(2);
  });
});

describe(calculateVertexCount.name, () => {
  it('should return resolution squared', () => {
    expect(calculateVertexCount(2)).toBe(4);
    expect(calculateVertexCount(4)).toBe(16);
    expect(calculateVertexCount(7)).toBe(49);
    expect(calculateVertexCount(9)).toBe(81);
    expect(calculateVertexCount(17)).toBe(289);
  });
});

describe(calculateIndexCount.name, () => {
  it('should return (resolution-1)^2 * 6', () => {
    expect(calculateIndexCount(2)).toBe(6);    // 1 quad * 6
    expect(calculateIndexCount(4)).toBe(54);   // 9 quads * 6
    expect(calculateIndexCount(7)).toBe(216);  // 36 quads * 6
    expect(calculateIndexCount(9)).toBe(384);  // 64 quads * 6
    expect(calculateIndexCount(17)).toBe(1536); // 256 quads * 6
  });
});

describe(calculateTriangleCount.name, () => {
  it('should return (resolution-1)^2 * 2', () => {
    expect(calculateTriangleCount(2)).toBe(2);
    expect(calculateTriangleCount(4)).toBe(18);
    expect(calculateTriangleCount(7)).toBe(72);
    expect(calculateTriangleCount(9)).toBe(128);
    expect(calculateTriangleCount(17)).toBe(512);
  });
});

describe(generateChunkMesh.name, () => {
  describe('array sizes', () => {
    it('should generate correct sizes for LOD 0', () => {
      const mesh = generateChunkMesh(0, 0, 0, 64);
      
      expect(mesh.vertices.length).toBe(4 * 3);  // 4 vertices * 3 components
      expect(mesh.normals.length).toBe(4 * 3);
      expect(mesh.indices.length).toBe(6);       // 2 triangles * 3 indices
    });

    it('should generate correct sizes for LOD 4', () => {
      const mesh = generateChunkMesh(0, 0, 4, 64);
      
      expect(mesh.vertices.length).toBe(289 * 3);
      expect(mesh.normals.length).toBe(289 * 3);
      expect(mesh.indices.length).toBe(1536);
    });
  });

  describe('vertex positions', () => {
    it('should start at chunk origin for chunk (0,0)', () => {
      const mesh = generateChunkMesh(0, 0, 0, 64);
      
      expect(mesh.vertices[0]).toBe(0);  // X
      expect(typeof mesh.vertices[1]).toBe('number');  // Y (terrain height)
      expect(mesh.vertices[2]).toBe(0);  // Z
    });

    it('should end at chunk corner', () => {
      const mesh = generateChunkMesh(0, 0, 0, 64);
      
      // Last vertex for 2x2 grid (index 3)
      expect(mesh.vertices[9]).toBe(64);   // X
      expect(typeof mesh.vertices[10]).toBe('number');  // Y (terrain height)
      expect(mesh.vertices[11]).toBe(64);  // Z
    });

    it('should offset by chunk coordinates', () => {
      const mesh = generateChunkMesh(2, 3, 0, 64);
      
      // First vertex at (2*64, Y, 3*64)
      expect(mesh.vertices[0]).toBe(128);  // X = 2 * 64
      expect(typeof mesh.vertices[1]).toBe('number');  // Y (terrain height)
      expect(mesh.vertices[2]).toBe(192);  // Z = 3 * 64
    });

    it('should handle negative chunk coordinates', () => {
      const mesh = generateChunkMesh(-1, -2, 0, 64);
      
      expect(mesh.vertices[0]).toBe(-64);   // X = -1 * 64
      expect(typeof mesh.vertices[1]).toBe('number');  // Y (terrain height)
      expect(mesh.vertices[2]).toBe(-128);  // Z = -2 * 64
    });

    it('should keep all vertices within chunk bounds (X/Z)', () => {
      const chunkX = 5;
      const chunkZ = -3;
      const size = 64;
      const mesh = generateChunkMesh(chunkX, chunkZ, 1, size);
      
      const minX = chunkX * size;
      const maxX = (chunkX + 1) * size;
      const minZ = chunkZ * size;
      const maxZ = (chunkZ + 1) * size;
      
      for (let i = 0; i < mesh.vertices.length; i += 3) {
        const x = mesh.vertices[i];
        const z = mesh.vertices[i + 2];
        
        expect(x).toBeGreaterThanOrEqual(minX);
        expect(x).toBeLessThanOrEqual(maxX);
        expect(z).toBeGreaterThanOrEqual(minZ);
        expect(z).toBeLessThanOrEqual(maxZ);
      }
    });

    it('should have varying heights from terrain noise', () => {
      const mesh = generateChunkMesh(0, 0, 2, 64);
      
      // Collect all Y values
      const heights: number[] = [];
      for (let i = 1; i < mesh.vertices.length; i += 3) {
        heights.push(mesh.vertices[i]);
      }
      
      // Should have some variation (not all the same)
      const uniqueHeights = new Set(heights);
      expect(uniqueHeights.size).toBeGreaterThan(1);
    });
  });

  describe('normals', () => {
    it('should be normalized unit vectors', () => {
      const mesh = generateChunkMesh(0, 0, 2, 64);
      
      for (let i = 0; i < mesh.normals.length; i += 3) {
        const nx = mesh.normals[i];
        const ny = mesh.normals[i + 1];
        const nz = mesh.normals[i + 2];
        
        // Check that normal is a unit vector (length ~= 1)
        const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
        expect(length).toBeCloseTo(1, 3);
      }
    });

    it('should have positive Y component (pointing generally up)', () => {
      const mesh = generateChunkMesh(0, 0, 2, 64);
      
      for (let i = 0; i < mesh.normals.length; i += 3) {
        const ny = mesh.normals[i + 1];
        // Normals should point generally upward (Y > 0)
        // Even steep terrain shouldn't have normals pointing down
        expect(ny).toBeGreaterThan(0);
      }
    });
  });

  describe('indices', () => {
    it('should reference valid vertices', () => {
      const mesh = generateChunkMesh(0, 0, 1, 64);
      const vertexCount = mesh.vertices.length / 3;
      
      for (const index of mesh.indices) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(vertexCount);
      }
    });

    it('should form complete triangles', () => {
      const mesh = generateChunkMesh(0, 0, 2, 64);
      expect(mesh.indices.length % 3).toBe(0);
    });
  });

  describe('edge stitching', () => {
    // Helper to get vertex height at grid position
    const getVertexHeight = (mesh: { vertices: Float32Array }, resolution: number, x: number, z: number): number => {
      const index = (z * resolution + x) * 3 + 1; // +1 for Y component
      return mesh.vertices[index];
    };

    // Helper to get edge vertices (excluding corners)
    const getEdgeHeights = (
      mesh: { vertices: Float32Array },
      resolution: number,
      edge: 'north' | 'south' | 'east' | 'west'
    ): number[] => {
      const heights: number[] = [];
      if (edge === 'south') {
        // z = 0, x = 1 to resolution-2 (excluding corners)
        for (let x = 1; x < resolution - 1; x++) {
          heights.push(getVertexHeight(mesh, resolution, x, 0));
        }
      } else if (edge === 'north') {
        // z = resolution-1, x = 1 to resolution-2
        for (let x = 1; x < resolution - 1; x++) {
          heights.push(getVertexHeight(mesh, resolution, x, resolution - 1));
        }
      } else if (edge === 'west') {
        // x = 0, z = 1 to resolution-2
        for (let z = 1; z < resolution - 1; z++) {
          heights.push(getVertexHeight(mesh, resolution, 0, z));
        }
      } else if (edge === 'east') {
        // x = resolution-1, z = 1 to resolution-2
        for (let z = 1; z < resolution - 1; z++) {
          heights.push(getVertexHeight(mesh, resolution, resolution - 1, z));
        }
      }
      return heights;
    };

    it('should produce identical results without neighborLODs parameter', () => {
      const meshWithout = generateChunkMesh(0, 0, 2, 64);
      const meshWith = generateChunkMesh(0, 0, 2, 64, { north: 2, south: 2, east: 2, west: 2 });
      
      // Should be identical when all neighbors have same LOD
      expect(meshWith.vertices).toEqual(meshWithout.vertices);
    });

    it('should not modify edge heights when neighbor has same LOD', () => {
      const lodLevel = 2;
      const neighborLODs: NeighborLODs = { north: lodLevel, south: lodLevel, east: lodLevel, west: lodLevel };
      
      const meshWithStitching = generateChunkMesh(0, 0, lodLevel, 64, neighborLODs);
      const meshWithoutStitching = generateChunkMesh(0, 0, lodLevel, 64);
      
      expect(meshWithStitching.vertices).toEqual(meshWithoutStitching.vertices);
    });

    it('should not modify edge heights when neighbor has higher LOD', () => {
      const lodLevel = 2;
      const neighborLODs: NeighborLODs = { north: 4, south: 4, east: 4, west: 4 };
      
      const meshWithStitching = generateChunkMesh(0, 0, lodLevel, 64, neighborLODs);
      const meshWithoutStitching = generateChunkMesh(0, 0, lodLevel, 64);
      
      expect(meshWithStitching.vertices).toEqual(meshWithoutStitching.vertices);
    });

    it('should modify west edge heights when west neighbor has lower LOD', () => {
      const lodLevel = 3;  // 9 vertices
      const neighborLODs: NeighborLODs = { north: 3, south: 3, east: 3, west: 1 }; // west has LOD 1 (4 vertices)
      
      const meshWithStitching = generateChunkMesh(0, 0, lodLevel, 64, neighborLODs);
      const meshWithoutStitching = generateChunkMesh(0, 0, lodLevel, 64);
      
      const resolution = getResolutionForLOD(lodLevel);
      
      // West edge heights should be different (stitched)
      const stitchedWest = getEdgeHeights(meshWithStitching, resolution, 'west');
      const originalWest = getEdgeHeights(meshWithoutStitching, resolution, 'west');
      expect(stitchedWest).not.toEqual(originalWest);
      
      // Other edges should be unchanged
      const stitchedEast = getEdgeHeights(meshWithStitching, resolution, 'east');
      const originalEast = getEdgeHeights(meshWithoutStitching, resolution, 'east');
      expect(stitchedEast).toEqual(originalEast);
    });

    it('should modify east edge heights when east neighbor has lower LOD', () => {
      const lodLevel = 3;
      const neighborLODs: NeighborLODs = { north: 3, south: 3, east: 1, west: 3 };
      
      const meshWithStitching = generateChunkMesh(0, 0, lodLevel, 64, neighborLODs);
      const meshWithoutStitching = generateChunkMesh(0, 0, lodLevel, 64);
      
      const resolution = getResolutionForLOD(lodLevel);
      
      const stitchedEast = getEdgeHeights(meshWithStitching, resolution, 'east');
      const originalEast = getEdgeHeights(meshWithoutStitching, resolution, 'east');
      expect(stitchedEast).not.toEqual(originalEast);
    });

    it('should modify north edge heights when north neighbor has lower LOD', () => {
      const lodLevel = 3;
      const neighborLODs: NeighborLODs = { north: 1, south: 3, east: 3, west: 3 };
      
      const meshWithStitching = generateChunkMesh(0, 0, lodLevel, 64, neighborLODs);
      const meshWithoutStitching = generateChunkMesh(0, 0, lodLevel, 64);
      
      const resolution = getResolutionForLOD(lodLevel);
      
      const stitchedNorth = getEdgeHeights(meshWithStitching, resolution, 'north');
      const originalNorth = getEdgeHeights(meshWithoutStitching, resolution, 'north');
      expect(stitchedNorth).not.toEqual(originalNorth);
    });

    it('should modify south edge heights when south neighbor has lower LOD', () => {
      const lodLevel = 3;
      const neighborLODs: NeighborLODs = { north: 3, south: 1, east: 3, west: 3 };
      
      const meshWithStitching = generateChunkMesh(0, 0, lodLevel, 64, neighborLODs);
      const meshWithoutStitching = generateChunkMesh(0, 0, lodLevel, 64);
      
      const resolution = getResolutionForLOD(lodLevel);
      
      const stitchedSouth = getEdgeHeights(meshWithStitching, resolution, 'south');
      const originalSouth = getEdgeHeights(meshWithoutStitching, resolution, 'south');
      expect(stitchedSouth).not.toEqual(originalSouth);
    });

    it('should modify corner vertices to use minimum LOD of adjacent neighbors', () => {
      const lodLevel = 2;
      const size = 64;
      const neighborLODs: NeighborLODs = { north: 0, south: 0, east: 0, west: 0 };
      
      const meshWithStitching = generateChunkMesh(0, 0, lodLevel, size, neighborLODs);
      
      const resolution = getResolutionForLOD(lodLevel);
      
      // Corners should be sampled at minimum LOD of adjacent edges
      // Southwest corner (0,0): min(lodLevel, west, south) = min(2, 0, 0) = 0
      // Southeast corner (res-1,0): min(lodLevel, east, south) = min(2, 0, 0) = 0
      // Northwest corner (0,res-1): min(lodLevel, west, north) = min(2, 0, 0) = 0
      // Northeast corner (res-1,res-1): min(lodLevel, east, north) = min(2, 0, 0) = 0
      const corners = [
        { gridX: 0, gridZ: 0, worldX: 0, worldZ: 0, expectedLOD: 0 },
        { gridX: resolution - 1, gridZ: 0, worldX: size, worldZ: 0, expectedLOD: 0 },
        { gridX: 0, gridZ: resolution - 1, worldX: 0, worldZ: size, expectedLOD: 0 },
        { gridX: resolution - 1, gridZ: resolution - 1, worldX: size, worldZ: size, expectedLOD: 0 },
      ];
      
      for (const corner of corners) {
        const meshHeight = getVertexHeight(meshWithStitching, resolution, corner.gridX, corner.gridZ);
        const expectedHeight = getTerrainHeight(corner.worldX, corner.worldZ, corner.expectedLOD);
        expect(meshHeight).toBeCloseTo(expectedHeight, 5);
      }
    });

    it('should not modify interior vertices', () => {
      const lodLevel = 3;  // 9x9 grid, has interior vertices
      const neighborLODs: NeighborLODs = { north: 0, south: 0, east: 0, west: 0 };
      
      const meshWithStitching = generateChunkMesh(0, 0, lodLevel, 64, neighborLODs);
      const meshWithoutStitching = generateChunkMesh(0, 0, lodLevel, 64);
      
      const resolution = getResolutionForLOD(lodLevel);
      
      // Check interior vertices (not on any edge)
      for (let z = 1; z < resolution - 1; z++) {
        for (let x = 1; x < resolution - 1; x++) {
          const stitchedHeight = getVertexHeight(meshWithStitching, resolution, x, z);
          const originalHeight = getVertexHeight(meshWithoutStitching, resolution, x, z);
          expect(stitchedHeight).toBe(originalHeight);
        }
      }
    });

    it('should produce stitched heights that interpolate between neighbor edge vertices', () => {
      const lodLevel = 2;  // 7 vertices per edge
      const neighborLOD = 0;  // 2 vertices per edge
      const size = 64;
      const neighborLODs: NeighborLODs = { north: lodLevel, south: lodLevel, east: lodLevel, west: neighborLOD };
      
      const mesh = generateChunkMesh(0, 0, lodLevel, size, neighborLODs);
      const resolution = getResolutionForLOD(lodLevel);
      
      // West edge vertices should be interpolated between the 2 vertices of the neighbor
      // Neighbor at LOD 0 has vertices at z=0 and z=size
      const h0 = getTerrainHeight(0, 0, neighborLOD);  // Neighbor's first vertex
      const h1 = getTerrainHeight(0, size, neighborLOD);  // Neighbor's last vertex
      
      // Check a middle vertex on west edge - should be interpolated
      const middleZ = 3;  // Middle vertex index on west edge (for 7-vertex edge)
      const middleHeight = getVertexHeight(mesh, resolution, 0, middleZ);
      const expectedT = (middleZ * size / (resolution - 1)) / size;  // Interpolation factor
      const expectedHeight = h0 + expectedT * (h1 - h0);
      
      expect(middleHeight).toBeCloseTo(expectedHeight, 3);
    });
  });
});
