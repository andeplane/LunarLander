import { describe, it, expect } from 'vitest';
import {
  getLodLevelForDistance,
  getResolutionForLodLevel,
  getNeighborKeys,
  parseGridKey,
  createGridKey,
  getChunkWorldCenter,
  getDistanceToChunk,
} from './LodUtils';

describe(getLodLevelForDistance.name, () => {
  const lodDistances = [0, 100, 200, 400];

  it.each([
    { distance: 0, expected: 0 },
    { distance: 50, expected: 0 },
    { distance: 99, expected: 0 },
    { distance: 100, expected: 1 },
    { distance: 150, expected: 1 },
    { distance: 199, expected: 1 },
    { distance: 200, expected: 2 },
    { distance: 300, expected: 2 },
    { distance: 400, expected: 3 },
    { distance: 1000, expected: 3 },
  ])('returns $expected for distance $distance', ({ distance, expected }) => {
    expect(getLodLevelForDistance(distance, lodDistances)).toBe(expected);
  });

  it('returns 0 for negative distance', () => {
    expect(getLodLevelForDistance(-50, lodDistances)).toBe(0);
  });

  it('returns 0 for empty lodDistances array', () => {
    expect(getLodLevelForDistance(100, [])).toBe(0);
  });

  it('handles single LOD level', () => {
    expect(getLodLevelForDistance(0, [0])).toBe(0);
    expect(getLodLevelForDistance(500, [0])).toBe(0);
  });
});

describe(getResolutionForLodLevel.name, () => {
  const lodLevels = [512, 256, 128, 64];

  it.each([
    { lodIndex: 0, expected: 512 },
    { lodIndex: 1, expected: 256 },
    { lodIndex: 2, expected: 128 },
    { lodIndex: 3, expected: 64 },
  ])('returns $expected for lodIndex $lodIndex', ({ lodIndex, expected }) => {
    expect(getResolutionForLodLevel(lodIndex, lodLevels)).toBe(expected);
  });

  it('returns first level for negative index', () => {
    expect(getResolutionForLodLevel(-1, lodLevels)).toBe(512);
  });

  it('returns last level for index beyond array', () => {
    expect(getResolutionForLodLevel(10, lodLevels)).toBe(64);
  });

  it('returns default for empty array', () => {
    expect(getResolutionForLodLevel(0, [])).toBe(512);
  });
});

describe(getNeighborKeys.name, () => {
  it('returns correct neighbor keys for origin chunk', () => {
    const neighbors = getNeighborKeys(0, 0);

    expect(neighbors.north).toBe('0,-1');
    expect(neighbors.south).toBe('0,1');
    expect(neighbors.east).toBe('1,0');
    expect(neighbors.west).toBe('-1,0');
  });

  it('returns correct neighbor keys for positive coordinates', () => {
    const neighbors = getNeighborKeys(5, 3);

    expect(neighbors.north).toBe('5,2');
    expect(neighbors.south).toBe('5,4');
    expect(neighbors.east).toBe('6,3');
    expect(neighbors.west).toBe('4,3');
  });

  it('returns correct neighbor keys for negative coordinates', () => {
    const neighbors = getNeighborKeys(-2, -3);

    expect(neighbors.north).toBe('-2,-4');
    expect(neighbors.south).toBe('-2,-2');
    expect(neighbors.east).toBe('-1,-3');
    expect(neighbors.west).toBe('-3,-3');
  });
});

describe(parseGridKey.name, () => {
  it.each([
    { key: '0,0', expected: [0, 0] },
    { key: '5,3', expected: [5, 3] },
    { key: '-2,-3', expected: [-2, -3] },
    { key: '100,-50', expected: [100, -50] },
  ])('parses "$key" to $expected', ({ key, expected }) => {
    expect(parseGridKey(key)).toEqual(expected);
  });
});

describe(createGridKey.name, () => {
  it.each([
    { x: 0, z: 0, expected: '0,0' },
    { x: 5, z: 3, expected: '5,3' },
    { x: -2, z: -3, expected: '-2,-3' },
  ])('creates "$expected" from ($x, $z)', ({ x, z, expected }) => {
    expect(createGridKey(x, z)).toBe(expected);
  });
});

describe(getChunkWorldCenter.name, () => {
  const chunkWidth = 50;
  const chunkDepth = 50;

  it('returns correct center for origin chunk', () => {
    const center = getChunkWorldCenter(0, 0, chunkWidth, chunkDepth);

    expect(center.x).toBe(25);
    expect(center.z).toBe(25);
  });

  it('returns correct center for chunk at (1, 1)', () => {
    const center = getChunkWorldCenter(1, 1, chunkWidth, chunkDepth);

    expect(center.x).toBe(75);
    expect(center.z).toBe(75);
  });

  it('returns correct center for negative coordinates', () => {
    const center = getChunkWorldCenter(-1, -1, chunkWidth, chunkDepth);

    expect(center.x).toBe(-25);
    expect(center.z).toBe(-25);
  });

  it('handles non-square chunks', () => {
    const center = getChunkWorldCenter(0, 0, 100, 50);

    expect(center.x).toBe(50);
    expect(center.z).toBe(25);
  });
});

describe(getDistanceToChunk.name, () => {
  const chunkWidth = 50;
  const chunkDepth = 50;

  it('returns 0 when point is at chunk center', () => {
    // Chunk (0,0) center is at (25, 25)
    const distance = getDistanceToChunk(25, 25, 0, 0, chunkWidth, chunkDepth);
    expect(distance).toBe(0);
  });

  it('returns correct distance for point on axis', () => {
    // Chunk (0,0) center is at (25, 25)
    // Point at (25, 75) is 50 units away on Z axis
    const distance = getDistanceToChunk(25, 75, 0, 0, chunkWidth, chunkDepth);
    expect(distance).toBe(50);
  });

  it('returns correct distance for diagonal', () => {
    // Chunk (0,0) center is at (25, 25)
    // Point at (25+30, 25+40) = (55, 65) is 50 units away (3-4-5 triangle)
    const distance = getDistanceToChunk(55, 65, 0, 0, chunkWidth, chunkDepth);
    expect(distance).toBe(50);
  });
});
