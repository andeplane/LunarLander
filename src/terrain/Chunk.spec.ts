import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Chunk } from './Chunk';
import type { ChunkCoord } from '../types';

// Mock Three.js since we don't want to test rendering
// Note: Using class syntax because vi.fn() arrow functions don't work as constructors
vi.mock('three', () => {
  const MockBufferGeometry = vi.fn(function(this: Record<string, unknown>) {
    this.setAttribute = vi.fn();
    this.setIndex = vi.fn();
    this.getAttribute = vi.fn();
    this.getIndex = vi.fn();
    this.dispose = vi.fn();
    this.clone = vi.fn(() => new MockBufferGeometry());
  });

  const MockBufferAttribute = vi.fn(function(this: Record<string, unknown>) {
    // Empty mock
  });

  const MockMesh = vi.fn(function(this: Record<string, unknown>) {
    this.material = { dispose: vi.fn() };
    this.position = { y: 0 };
  });

  const MockMeshStandardMaterial = vi.fn(function(this: Record<string, unknown>) {
    this.dispose = vi.fn();
  });

  const MockMeshBasicMaterial = vi.fn(function(this: Record<string, unknown>) {
    this.dispose = vi.fn();
  });

  const MockColor = vi.fn(function(this: Record<string, unknown>) {
    this.setHSL = vi.fn();
    this.r = 0.5;
    this.g = 0.5;
    this.b = 0.5;
  });

  return {
    BufferGeometry: MockBufferGeometry,
    BufferAttribute: MockBufferAttribute,
    Mesh: MockMesh,
    MeshStandardMaterial: MockMeshStandardMaterial,
    MeshBasicMaterial: MockMeshBasicMaterial,
    Color: MockColor,
    DoubleSide: 2,
  };
});

describe(Chunk.name, () => {
  let chunk: Chunk;
  const coord: ChunkCoord = { x: 5, z: 10 };

  beforeEach(() => {
    chunk = new Chunk(coord);
  });

  describe('constructor', () => {
    it('should initialize with given coordinates', () => {
      expect(chunk.coord).toEqual(coord);
    });

    it('should initialize with queued state', () => {
      expect(chunk.state).toBe('queued');
    });

    it('should initialize with no LODs generated', () => {
      expect(chunk.getHighestGeneratedLOD()).toBe(-1);
    });

    it('should initialize with no LOD rendering', () => {
      expect(chunk.getCurrentRenderingLOD()).toBe(-1);
    });
  });

  describe(Chunk.prototype.hasLOD.name, () => {
    it('should return false when no LODs are generated', () => {
      expect(chunk.hasLOD(0)).toBe(false);
      expect(chunk.hasLOD(1)).toBe(false);
      expect(chunk.hasLOD(4)).toBe(false);
    });

    it('should return true for generated LOD', () => {
      // Add LOD 0
      chunk.addLODFromData(
        0,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.hasLOD(0)).toBe(true);
      expect(chunk.hasLOD(1)).toBe(false);
    });
  });

  describe(Chunk.prototype.getHighestGeneratedLOD.name, () => {
    it('should return -1 when no LODs generated', () => {
      expect(chunk.getHighestGeneratedLOD()).toBe(-1);
    });

    it('should return 0 after adding LOD 0', () => {
      chunk.addLODFromData(
        0,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.getHighestGeneratedLOD()).toBe(0);
    });

    it('should return highest LOD after adding multiple LODs', () => {
      // Add LOD 0
      chunk.addLODFromData(
        0,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      // Add LOD 2 (skipping 1)
      chunk.addLODFromData(
        2,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.getHighestGeneratedLOD()).toBe(2);
    });

    it('should not decrease when adding lower LOD after higher', () => {
      // Add LOD 3 first
      chunk.addLODFromData(
        3,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      // Add LOD 1
      chunk.addLODFromData(
        1,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.getHighestGeneratedLOD()).toBe(3);
    });
  });

  describe(Chunk.prototype.getBestAvailableLOD.name, () => {
    it('should return -1 when no LODs available', () => {
      expect(chunk.getBestAvailableLOD(2)).toBe(-1);
    });

    it('should return exact LOD when available', () => {
      chunk.addLODFromData(
        2,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.getBestAvailableLOD(2)).toBe(2);
    });

    it('should return lower LOD when target not available', () => {
      // Only have LOD 1
      chunk.addLODFromData(
        1,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      // Request LOD 3, should get LOD 1
      expect(chunk.getBestAvailableLOD(3)).toBe(1);
    });

    it('should return highest available when target is higher than all available', () => {
      // Add LOD 0 and 2
      chunk.addLODFromData(
        0,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );
      chunk.addLODFromData(
        2,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      // Request LOD 4, should get LOD 2 (highest available <= target)
      expect(chunk.getBestAvailableLOD(4)).toBe(2);
    });

    it('should return best fit when multiple LODs available', () => {
      // Add LOD 0, 1, 3
      chunk.addLODFromData(
        0,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );
      chunk.addLODFromData(
        1,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );
      chunk.addLODFromData(
        3,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      // Request LOD 2, should get LOD 1 (highest <= 2)
      expect(chunk.getBestAvailableLOD(2)).toBe(1);
    });

    it('should return highest when target is 0 but only higher LODs exist', () => {
      // Only have LOD 2
      chunk.addLODFromData(
        2,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      // Request LOD 0, but we only have LOD 2
      // Should return highest available since nothing <= 0
      expect(chunk.getBestAvailableLOD(0)).toBe(2);
    });
  });

  describe(Chunk.prototype.switchToLOD.name, () => {
    it('should return false when LOD not available', () => {
      expect(chunk.switchToLOD(2)).toBe(false);
    });

    it('should return true when switching to available LOD', () => {
      chunk.addLODFromData(
        1,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.switchToLOD(1)).toBe(true);
    });

    it('should update current rendering LOD', () => {
      chunk.addLODFromData(
        0,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );
      chunk.addLODFromData(
        2,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      chunk.switchToLOD(0);
      expect(chunk.getCurrentRenderingLOD()).toBe(0);

      chunk.switchToLOD(2);
      expect(chunk.getCurrentRenderingLOD()).toBe(2);
    });

    it('should return true when already rendering requested LOD', () => {
      chunk.addLODFromData(
        1,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      chunk.switchToLOD(1);
      // Switch to same LOD again
      expect(chunk.switchToLOD(1)).toBe(true);
    });
  });

  describe(Chunk.prototype.addLODFromData.name, () => {
    it('should set state to active', () => {
      chunk.addLODFromData(
        0,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.state).toBe('active');
    });

    it('should automatically switch to first LOD added', () => {
      chunk.addLODFromData(
        2,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.getCurrentRenderingLOD()).toBe(2);
    });

    it('should switch to higher LOD when added', () => {
      chunk.addLODFromData(
        1,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.getCurrentRenderingLOD()).toBe(1);

      chunk.addLODFromData(
        3,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.getCurrentRenderingLOD()).toBe(3);
    });

    it('should not switch to lower LOD when added', () => {
      chunk.addLODFromData(
        3,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      expect(chunk.getCurrentRenderingLOD()).toBe(3);

      chunk.addLODFromData(
        1,
        new Float32Array([0, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Uint32Array([0]),
        false
      );

      // Should still be rendering LOD 3
      expect(chunk.getCurrentRenderingLOD()).toBe(3);
    });
  });
});
