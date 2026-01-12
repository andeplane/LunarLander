import { describe, it, expect } from 'vitest';
import {
  LOD_RESOLUTIONS,
  getResolutionForLOD,
  calculateVertexCount,
  calculateIndexCount,
  calculateTriangleCount,
  generateChunkMesh,
} from './meshGeneration';

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
      expect(mesh.vertices[1]).toBe(0);  // Y
      expect(mesh.vertices[2]).toBe(0);  // Z
    });

    it('should end at chunk corner', () => {
      const mesh = generateChunkMesh(0, 0, 0, 64);
      
      // Last vertex for 2x2 grid (index 3)
      expect(mesh.vertices[9]).toBe(64);   // X
      expect(mesh.vertices[10]).toBe(0);   // Y
      expect(mesh.vertices[11]).toBe(64);  // Z
    });

    it('should offset by chunk coordinates', () => {
      const mesh = generateChunkMesh(2, 3, 0, 64);
      
      // First vertex at (2*64, 0, 3*64)
      expect(mesh.vertices[0]).toBe(128);  // X = 2 * 64
      expect(mesh.vertices[1]).toBe(0);    // Y
      expect(mesh.vertices[2]).toBe(192);  // Z = 3 * 64
    });

    it('should handle negative chunk coordinates', () => {
      const mesh = generateChunkMesh(-1, -2, 0, 64);
      
      expect(mesh.vertices[0]).toBe(-64);   // X = -1 * 64
      expect(mesh.vertices[1]).toBe(0);     // Y
      expect(mesh.vertices[2]).toBe(-128);  // Z = -2 * 64
    });

    it('should keep all vertices within chunk bounds', () => {
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
  });

  describe('normals', () => {
    it('should all point up (0, 1, 0)', () => {
      const mesh = generateChunkMesh(0, 0, 2, 64);
      
      for (let i = 0; i < mesh.normals.length; i += 3) {
        expect(mesh.normals[i]).toBe(0);      // X
        expect(mesh.normals[i + 1]).toBe(1);  // Y (up)
        expect(mesh.normals[i + 2]).toBe(0);  // Z
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
});
