import { describe, it, expect } from 'vitest';
import {
  getLodLevelForDistance,
  getResolutionForLodLevel,
  getNeighborKeys,
  parseGridKey,
  createGridKey,
  getChunkWorldCenter,
  getDistanceToChunk,
  LodDetailLevel,
  getTriangleEdgeLength,
  projectToScreenSpace,
  getLodLevelForScreenSize,
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

  it('returns 0 when point is inside chunk at ground level', () => {
    // Chunk (0,0) bounds: X=[0,50], Z=[0,50]
    // Point at (25, 0, 25) is inside chunk, nearest point is itself
    const distance = getDistanceToChunk(25, 0, 25, 0, 0, chunkWidth, chunkDepth);
    expect(distance).toBe(0);
  });

  it('returns Y distance when point is directly above chunk', () => {
    // Chunk (0,0) bounds: X=[0,50], Z=[0,50]
    // Point at (25, 50, 25) is inside chunk horizontally, nearest point is (25, 0, 25)
    const distance = getDistanceToChunk(25, 50, 25, 0, 0, chunkWidth, chunkDepth);
    expect(distance).toBe(50);
  });

  it('returns distance to nearest edge when point is outside chunk', () => {
    // Chunk (0,0) bounds: X=[0,50], Z=[0,50]
    // Point at (25, 0, 75) is outside on Z axis
    // Nearest point on chunk is (25, 0, 50) - the south edge
    const distance = getDistanceToChunk(25, 0, 75, 0, 0, chunkWidth, chunkDepth);
    expect(distance).toBe(25); // Distance from Z=75 to Z=50
  });

  it('returns distance to nearest corner when point is diagonally outside', () => {
    // Chunk (0,0) bounds: X=[0,50], Z=[0,50]
    // Point at (75, 0, 75) is outside on both axes
    // Nearest point on chunk is corner (50, 0, 50)
    const distance = getDistanceToChunk(75, 0, 75, 0, 0, chunkWidth, chunkDepth);
    // Distance = sqrt((75-50)^2 + (75-50)^2) = sqrt(625 + 625) = sqrt(1250) ≈ 35.36
    expect(distance).toBeCloseTo(Math.sqrt(1250), 5);
  });

  it('returns minimal distance when point is at chunk edge', () => {
    // Chunk (0,0) bounds: X=[0,50], Z=[0,50]
    // Point at (50, 10, 25) is on east edge, nearest point is (50, 0, 25)
    const distance = getDistanceToChunk(50, 10, 25, 0, 0, chunkWidth, chunkDepth);
    expect(distance).toBe(10); // Just the Y distance
  });

  it('handles point inside chunk near edge', () => {
    // Chunk (0,0) bounds: X=[0,50], Z=[0,50]
    // Point at (1, 5, 1) is inside chunk, nearest point is itself
    const distance = getDistanceToChunk(1, 5, 1, 0, 0, chunkWidth, chunkDepth);
    expect(distance).toBe(5); // Just the Y distance (nearest point is (1, 0, 1))
  });
});

// ============================================================================
// Screen-space LOD selection tests
// ============================================================================

describe('LodDetailLevel', () => {
  it('has correct values for each level', () => {
    expect(LodDetailLevel.Maximum).toBe(1);
    expect(LodDetailLevel.High).toBe(2);
    expect(LodDetailLevel.Balanced).toBe(4);
    expect(LodDetailLevel.Performance).toBe(8);
  });
});

describe(getTriangleEdgeLength.name, () => {
  it.each([
    { resolution: 512, chunkWidth: 50, expected: 50 / 511 },
    { resolution: 256, chunkWidth: 50, expected: 50 / 255 },
    { resolution: 128, chunkWidth: 50, expected: 50 / 127 },
    { resolution: 64, chunkWidth: 50, expected: 50 / 63 },
    { resolution: 2, chunkWidth: 100, expected: 100 },
  ])(
    'returns $expected for resolution=$resolution, chunkWidth=$chunkWidth',
    ({ resolution, chunkWidth, expected }) => {
      expect(getTriangleEdgeLength(resolution, chunkWidth)).toBeCloseTo(expected);
    }
  );

  it('handles edge case of resolution <= 1', () => {
    expect(getTriangleEdgeLength(1, 50)).toBe(50);
    expect(getTriangleEdgeLength(0, 50)).toBe(50);
  });
});

describe(projectToScreenSpace.name, () => {
  const fov70Radians = (70 * Math.PI) / 180;
  const screenHeight = 1080;

  it('returns larger screen size for closer objects', () => {
    const closeSize = projectToScreenSpace(1, 10, fov70Radians, screenHeight);
    const farSize = projectToScreenSpace(1, 100, fov70Radians, screenHeight);

    expect(closeSize).toBeGreaterThan(farSize);
  });

  it('returns larger screen size for larger world objects', () => {
    const smallSize = projectToScreenSpace(1, 100, fov70Radians, screenHeight);
    const largeSize = projectToScreenSpace(10, 100, fov70Radians, screenHeight);

    expect(largeSize).toBeGreaterThan(smallSize);
  });

  it('returns screen height for zero distance', () => {
    const size = projectToScreenSpace(1, 0, fov70Radians, screenHeight);
    expect(size).toBe(screenHeight);
  });

  it('scales with screen height', () => {
    const size1080 = projectToScreenSpace(1, 100, fov70Radians, 1080);
    const size720 = projectToScreenSpace(1, 100, fov70Radians, 720);

    expect(size1080 / size720).toBeCloseTo(1080 / 720);
  });

  it('applies terrain tilt factor', () => {
    // With tilt, projected size should be smaller (cos factor)
    const noTilt = projectToScreenSpace(1, 100, fov70Radians, screenHeight, 0);
    const withTilt = projectToScreenSpace(1, 100, fov70Radians, screenHeight, Math.PI / 12);

    expect(withTilt).toBeLessThan(noTilt);
    expect(withTilt / noTilt).toBeCloseTo(Math.cos(Math.PI / 12));
  });
});

describe(getLodLevelForScreenSize.name, () => {
  const lodLevels = [512, 256, 128, 64];
  const chunkWidth = 50;
  const fov70Radians = (70 * Math.PI) / 180;
  const screenHeight = 1080;

  it('returns higher LOD index (coarser detail) for farther distances', () => {
    // Traditional LOD: fine detail close, coarse detail far
    const closeLod = getLodLevelForScreenSize(
      10, lodLevels, chunkWidth, fov70Radians, screenHeight, LodDetailLevel.Balanced
    );
    const farLod = getLodLevelForScreenSize(
      500, lodLevels, chunkWidth, fov70Radians, screenHeight, LodDetailLevel.Balanced
    );

    // Far = coarser (higher index), close = finer (lower index)
    expect(farLod).toBeGreaterThanOrEqual(closeLod);
  });

  it('returns different LOD levels based on target pixel size', () => {
    // At a distance where triangles are moderately sized
    // Maximum (1px) target is easier to meet -> can use coarser LOD (higher index)
    // Performance (8px) target is harder to meet -> needs finer LOD (lower index)
    const maxDetail = getLodLevelForScreenSize(
      300, lodLevels, chunkWidth, fov70Radians, screenHeight, LodDetailLevel.Maximum
    );
    const perfDetail = getLodLevelForScreenSize(
      300, lodLevels, chunkWidth, fov70Radians, screenHeight, LodDetailLevel.Performance
    );

    // Maximum target (1px) is easier to meet, so can use coarser LOD
    expect(maxDetail).toBeGreaterThanOrEqual(perfDetail);
  });

  it('returns 0 for empty lodLevels array', () => {
    const lod = getLodLevelForScreenSize(
      100, [], chunkWidth, fov70Radians, screenHeight, LodDetailLevel.Balanced
    );
    expect(lod).toBe(0);
  });

  it('returns valid LOD index within array bounds', () => {
    for (const distance of [1, 10, 100, 500, 1000]) {
      for (const detail of [LodDetailLevel.Maximum, LodDetailLevel.High, LodDetailLevel.Balanced, LodDetailLevel.Performance]) {
        const lod = getLodLevelForScreenSize(
          distance, lodLevels, chunkWidth, fov70Radians, screenHeight, detail
        );
        expect(lod).toBeGreaterThanOrEqual(0);
        expect(lod).toBeLessThan(lodLevels.length);
      }
    }
  });

  it('returns finest LOD when very close (traditional LOD behavior)', () => {
    // Traditional LOD: use finest detail when close
    const lod = getLodLevelForScreenSize(
      1, lodLevels, chunkWidth, fov70Radians, screenHeight, LodDetailLevel.Balanced
    );
    // At distance=1, we want maximum detail - LOD 0
    expect(lod).toBe(0); // Finest LOD
  });
});
