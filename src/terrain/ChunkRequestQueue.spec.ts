import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Vector3 } from 'three';
import {
  ChunkRequestQueue,
  defaultPriorityCalculator,
  type QueuedRequest,
  type ChunkConfig,
} from './ChunkRequestQueue';
import type { TerrainArgs } from './terrain';

describe(ChunkRequestQueue.name, () => {
  const chunkConfig: ChunkConfig = { chunkWidth: 50, chunkDepth: 50 };
  let queue: ChunkRequestQueue;

  beforeEach(() => {
    queue = new ChunkRequestQueue(chunkConfig);
  });

  describe('add', () => {
    it('should add request to queue', () => {
      const request = createMockRequest('0,0', 0);
      
      const result = queue.add(request);

      expect(result).toBe(true);
      expect(queue.length).toBe(1);
    });

    it('should not add duplicate requests with same gridKey and lodLevel', () => {
      const request1 = createMockRequest('0,0', 0);
      const request2 = createMockRequest('0,0', 0);

      queue.add(request1);
      const result = queue.add(request2);

      expect(result).toBe(false);
      expect(queue.length).toBe(1);
    });

    it('should allow same gridKey with different lodLevel', () => {
      const request1 = createMockRequest('0,0', 0);
      const request2 = createMockRequest('0,0', 1);

      queue.add(request1);
      queue.add(request2);

      expect(queue.length).toBe(2);
    });
  });

  describe('has', () => {
    it('should return true for queued request', () => {
      queue.add(createMockRequest('1,2', 0));

      expect(queue.has('1,2', 0)).toBe(true);
    });

    it('should return false for non-queued request', () => {
      queue.add(createMockRequest('1,2', 0));

      expect(queue.has('1,2', 1)).toBe(false);
      expect(queue.has('0,0', 0)).toBe(false);
    });
  });

  describe('pruneStale', () => {
    it('should remove requests not in valid set', () => {
      queue.add(createMockRequest('0,0', 0));
      queue.add(createMockRequest('1,1', 0));
      queue.add(createMockRequest('2,2', 0));

      queue.pruneStale(new Set(['0,0', '2,2']));

      expect(queue.length).toBe(2);
      expect(queue.has('0,0', 0)).toBe(true);
      expect(queue.has('1,1', 0)).toBe(false);
      expect(queue.has('2,2', 0)).toBe(true);
    });

    it('should keep all requests when all are valid', () => {
      queue.add(createMockRequest('0,0', 0));
      queue.add(createMockRequest('1,1', 0));

      queue.pruneStale(new Set(['0,0', '1,1', '2,2']));

      expect(queue.length).toBe(2);
    });

    it('should remove all requests when none are valid', () => {
      queue.add(createMockRequest('0,0', 0));
      queue.add(createMockRequest('1,1', 0));

      queue.pruneStale(new Set(['3,3']));

      expect(queue.length).toBe(0);
    });
  });

  describe('sort', () => {
    it('should sort by priority with closest chunks first', () => {
      // Arrange - camera at origin, looking forward (+Z)
      const cameraPos = new Vector3(0, 0, 0);
      const cameraForward = new Vector3(0, 0, 1);

      // Add chunks at different distances (chunk centers at gridX*50+25, gridZ*50+25)
      queue.add(createMockRequest('2,0', 0)); // Far: center at (125, 25)
      queue.add(createMockRequest('0,0', 0)); // Close: center at (25, 25)
      queue.add(createMockRequest('1,0', 0)); // Medium: center at (75, 25)

      // Act
      queue.sort(cameraPos, cameraForward, new Set());

      // Assert - closest should be first
      expect(queue.shift()?.gridKey).toBe('0,0');
      expect(queue.shift()?.gridKey).toBe('1,0');
      expect(queue.shift()?.gridKey).toBe('2,0');
    });

    it('should prioritize chunks in front of camera over chunks behind', () => {
      // Arrange - camera at (100, 0, 100), looking forward (+Z)
      const cameraPos = new Vector3(100, 0, 100);
      const cameraForward = new Vector3(0, 0, 1);

      // Add two chunks at similar distances: one in front, one behind
      // Chunk at (2,3) = center at (125, 175) - in front (higher Z)
      // Chunk at (2,1) = center at (125, 75) - behind (lower Z)
      queue.add(createMockRequest('2,1', 0)); // Behind
      queue.add(createMockRequest('2,3', 0)); // In front

      // Act
      queue.sort(cameraPos, cameraForward, new Set());

      // Assert - chunk in front should have priority
      expect(queue.shift()?.gridKey).toBe('2,3');
      expect(queue.shift()?.gridKey).toBe('2,1');
    });

    it('should use injected priority calculator', () => {
      // Arrange
      const mockCalculator = vi.fn(() => 0);
      const customQueue = new ChunkRequestQueue(chunkConfig, {
        calculatePriority: mockCalculator,
      });
      customQueue.add(createMockRequest('0,0', 0));
      customQueue.add(createMockRequest('1,1', 0));

      const cameraPos = new Vector3(0, 0, 0);
      const cameraForward = new Vector3(0, 0, 1);

      // Act
      customQueue.sort(cameraPos, cameraForward, new Set());

      // Assert - with 2 items, sort calls comparator once (2 calls to calculatePriority)
      expect(mockCalculator).toHaveBeenCalledTimes(2);
      expect(mockCalculator).toHaveBeenCalledWith('0,0', cameraPos, cameraForward, chunkConfig, new Set());
      expect(mockCalculator).toHaveBeenCalledWith('1,1', cameraPos, cameraForward, chunkConfig, new Set());
    });
  });

  describe('shift', () => {
    it('should return and remove first item', () => {
      queue.add(createMockRequest('0,0', 0));
      queue.add(createMockRequest('1,1', 1));

      const item = queue.shift();

      expect(item?.gridKey).toBe('0,0');
      expect(queue.length).toBe(1);
    });

    it('should return undefined when queue is empty', () => {
      expect(queue.shift()).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('should remove all items from queue', () => {
      queue.add(createMockRequest('0,0', 0));
      queue.add(createMockRequest('1,1', 0));

      queue.clear();

      expect(queue.length).toBe(0);
    });
  });
});

describe(defaultPriorityCalculator.name, () => {
  const chunkConfig: ChunkConfig = { chunkWidth: 50, chunkDepth: 50 };

  it('should give chunk in front of camera lower priority value than chunk behind', () => {
    const cameraPos = new Vector3(25, 0, 25);
    const cameraForward = new Vector3(0, 0, 1);
    const nearestChunkKeys = new Set<string>();

    // Calculate priority for chunk in front vs behind
    const frontPriority = defaultPriorityCalculator(
      '0,2', // In front (higher Z)
      cameraPos,
      cameraForward,
      chunkConfig,
      nearestChunkKeys
    );
    const behindPriority = defaultPriorityCalculator(
      '0,-2', // Behind (lower Z)
      cameraPos,
      cameraForward,
      chunkConfig,
      nearestChunkKeys
    );

    // Front should have lower priority value (= higher priority)
    expect(frontPriority).toBeLessThan(behindPriority);
  });

  it('should return lower priority for closer chunks', () => {
    const cameraPos = new Vector3(0, 0, 0);
    const cameraForward = new Vector3(1, 0, 0); // Looking right, neutral for Z axis
    const nearestChunkKeys = new Set<string>();

    const closePriority = defaultPriorityCalculator(
      '0,0', // Center at (25, 25)
      cameraPos,
      cameraForward,
      chunkConfig,
      nearestChunkKeys
    );
    const farPriority = defaultPriorityCalculator(
      '3,3', // Center at (175, 175)
      cameraPos,
      cameraForward,
      chunkConfig,
      nearestChunkKeys
    );

    expect(closePriority).toBeLessThan(farPriority);
  });

  it('should prioritize nearest chunks over all others', () => {
    const cameraPos = new Vector3(0, 0, 0);
    const cameraForward = new Vector3(0, 0, 1);
    const nearestChunkKeys = new Set(['2,2']); // Mark this as nearest

    // Nearest chunk should get highest priority (very low value)
    const nearestPriority = defaultPriorityCalculator(
      '2,2',
      cameraPos,
      cameraForward,
      chunkConfig,
      nearestChunkKeys
    );

    // Non-nearest chunk should get normal priority
    const normalPriority = defaultPriorityCalculator(
      '0,0',
      cameraPos,
      cameraForward,
      chunkConfig,
      nearestChunkKeys
    );

    // Nearest should have much lower priority value (= much higher priority)
    expect(nearestPriority).toBeLessThan(normalPriority);
    expect(nearestPriority).toBe(-1000000);
  });
});

// Helper functions at bottom of file

function createMockRequest(gridKey: string, lodLevel: number): QueuedRequest {
  return {
    gridKey,
    lodLevel,
    terrainArgs: createMockTerrainArgs(),
  };
}

function createMockTerrainArgs(): TerrainArgs {
  return {
    seed: 0,
    gain: 0.5,
    lacunarity: 2,
    frequency: 0.07,
    amplitude: 0.5,
    altitude: 0.1,
    falloff: 0.0,
    erosion: 0.6,
    erosionSoftness: 0.3,
    rivers: 0.18,
    riverWidth: 0.35,
    riverFalloff: 0.06,
    lakes: 0.5,
    lakesFalloff: 0.5,
    riversFrequency: 0.13,
    smoothLowerPlanes: 0,
    octaves: 10,
    width: 50,
    depth: 50,
    resolution: 128,
    posX: 0,
    posZ: 0,
    renderDistance: 10,
    // Crater generation parameters
    craterSeed: 42,
    craterDensity: 50,
    craterMinRadius: 2,
    craterMaxRadius: 200,
    craterPowerLawExponent: -2.4,
    craterDepthRatio: 0.2,
    craterRimHeight: 0.04,
    craterRimWidth: 0.1,
    craterFloorFlatness: 0,
  };
}
