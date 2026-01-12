import { describe, it, expect } from 'vitest';
import {
  LOD_LEVELS,
  getResolutionForLOD,
  getTargetLODForScreenSize,
} from './index';

describe(getResolutionForLOD.name, () => {
  it('should return correct resolution for LOD 0', () => {
    expect(getResolutionForLOD(0)).toBe(2);
  });

  it('should return correct resolution for LOD 1', () => {
    expect(getResolutionForLOD(1)).toBe(4);
  });

  it('should return correct resolution for LOD 2', () => {
    expect(getResolutionForLOD(2)).toBe(7);
  });

  it('should return correct resolution for LOD 3', () => {
    expect(getResolutionForLOD(3)).toBe(9);
  });

  it('should return correct resolution for LOD 4 (highest)', () => {
    expect(getResolutionForLOD(4)).toBe(17);
  });

  it('should return fallback resolution for invalid negative level', () => {
    expect(getResolutionForLOD(-1)).toBe(LOD_LEVELS[0].resolution);
  });

  it('should return fallback resolution for level beyond max', () => {
    expect(getResolutionForLOD(99)).toBe(LOD_LEVELS[0].resolution);
  });
});

describe(getTargetLODForScreenSize.name, () => {
  it('should return LOD 0 for very small screen size', () => {
    expect(getTargetLODForScreenSize(10)).toBe(0);
  });

  it('should return LOD 0 for screen size just below threshold', () => {
    expect(getTargetLODForScreenSize(49)).toBe(0);
  });

  it('should return LOD 1 for screen size at LOD 0 threshold', () => {
    expect(getTargetLODForScreenSize(50)).toBe(1);
  });

  it('should return LOD 1 for screen size between LOD 0 and 1 thresholds', () => {
    expect(getTargetLODForScreenSize(100)).toBe(1);
  });

  it('should return LOD 2 for screen size at LOD 1 threshold', () => {
    expect(getTargetLODForScreenSize(150)).toBe(2);
  });

  it('should return LOD 2 for screen size between LOD 1 and 2 thresholds', () => {
    expect(getTargetLODForScreenSize(200)).toBe(2);
  });

  it('should return LOD 3 for screen size at LOD 2 threshold', () => {
    expect(getTargetLODForScreenSize(300)).toBe(3);
  });

  it('should return LOD 3 for screen size between LOD 2 and 3 thresholds', () => {
    expect(getTargetLODForScreenSize(400)).toBe(3);
  });

  it('should return LOD 4 for screen size at LOD 3 threshold', () => {
    expect(getTargetLODForScreenSize(500)).toBe(4);
  });

  it('should return LOD 4 (max) for very large screen size', () => {
    expect(getTargetLODForScreenSize(10000)).toBe(4);
  });

  it('should return LOD 0 for zero screen size', () => {
    expect(getTargetLODForScreenSize(0)).toBe(0);
  });

  it('should return LOD 0 for negative screen size', () => {
    expect(getTargetLODForScreenSize(-10)).toBe(0);
  });
});

describe('LOD_LEVELS configuration', () => {
  it('should have 5 LOD levels', () => {
    expect(LOD_LEVELS).toHaveLength(5);
  });

  it('should have increasing resolutions', () => {
    for (let i = 1; i < LOD_LEVELS.length; i++) {
      expect(LOD_LEVELS[i].resolution).toBeGreaterThan(LOD_LEVELS[i - 1].resolution);
    }
  });

  it('should have increasing maxScreenSize thresholds', () => {
    for (let i = 1; i < LOD_LEVELS.length; i++) {
      expect(LOD_LEVELS[i].maxScreenSize).toBeGreaterThan(LOD_LEVELS[i - 1].maxScreenSize);
    }
  });

  it('should have last level with Infinity maxScreenSize', () => {
    expect(LOD_LEVELS[LOD_LEVELS.length - 1].maxScreenSize).toBe(Infinity);
  });

  it('should produce correct triangle counts', () => {
    // triangles = 2 * (resolution-1)^2
    const expectedTriangles = [2, 18, 72, 128, 512];
    
    LOD_LEVELS.forEach((level, index) => {
      const triangles = 2 * Math.pow(level.resolution - 1, 2);
      expect(triangles).toBe(expectedTriangles[index]);
    });
  });
});
