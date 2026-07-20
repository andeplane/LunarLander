import { describe, it, expect } from 'vitest';
import {
  PHYSICS_RESOLUTION_CAP,
  effectivePhysicsResolution,
  sampleHeightfield,
  selectPhysicsSourceLod,
  type HeightfieldSample,
} from './HeightfieldUtils';

/** Sample and assert the result is valid (avoids non-null assertions). */
function mustSample(
  getY: (vertexIndex: number) => number,
  meshResolution: number,
  numCells: number
): HeightfieldSample {
  const sample = sampleHeightfield(getY, meshResolution, numCells);
  if (!sample) {
    throw new Error('expected sampleHeightfield to succeed');
  }
  return sample;
}

/**
 * Build a getY accessor for a synthetic grid mesh of the given resolution,
 * where each vertex's height is a function of its normalized (u, v) position
 * in the chunk. This mirrors how different LOD meshes sample the same terrain.
 */
function makeGetY(
  meshResolution: number,
  heightAt: (u: number, v: number) => number
): (vertexIndex: number) => number {
  const vertexCount = meshResolution + 1;
  return (vertexIndex: number) => {
    const row = Math.floor(vertexIndex / vertexCount);
    const col = vertexIndex % vertexCount;
    return heightAt(col / meshResolution, row / meshResolution);
  };
}

describe('effectivePhysicsResolution', () => {
  it('passes through resolutions below the cap', () => {
    expect(effectivePhysicsResolution(32)).toBe(32);
    expect(effectivePhysicsResolution(64)).toBe(64);
  });

  it('caps resolutions at PHYSICS_RESOLUTION_CAP', () => {
    expect(effectivePhysicsResolution(128)).toBe(128);
    expect(effectivePhysicsResolution(256)).toBe(128);
    expect(effectivePhysicsResolution(512)).toBe(128);
    expect(effectivePhysicsResolution(1024)).toBe(128);
    expect(PHYSICS_RESOLUTION_CAP).toBe(128);
  });

  it('is equal across LOD flips at or above the cap (no-op rebuild seam)', () => {
    // 1024 <-> 512 <-> 256 <-> 128 flips all produce the same physics resolution
    const resolutions = [128, 256, 512, 1024].map((r) =>
      effectivePhysicsResolution(r)
    );
    expect(new Set(resolutions).size).toBe(1);
  });

  it('supports a custom cap', () => {
    expect(effectivePhysicsResolution(64, 16)).toBe(16);
  });
});

describe(selectPhysicsSourceLod.name, () => {
  // Matches DEFAULT_LOD_LEVELS: finest first
  const lodResolutions = [1024, 512, 256, 128, 64, 32, 16, 8, 4];

  it('prefers the coarsest built level at or above the cap', () => {
    // Levels 0..3 (1024..128) all meet the 128 cap; 3 is the coarsest
    expect(selectPhysicsSourceLod([0, 1, 2, 3, 5, 8], lodResolutions)).toBe(3);
  });

  it('yields the same source class for chunks displaying different LODs', () => {
    // Two neighboring chunks with different visual LODs but each having some
    // mesh at/above the cap: both colliders sample a >=cap mesh, which the
    // sampling invariant makes bit-identical along the shared edge
    const chunkA = selectPhysicsSourceLod([0, 1, 5, 8], lodResolutions);
    const chunkB = selectPhysicsSourceLod([2, 3, 5, 8], lodResolutions);
    expect(chunkA).not.toBeNull();
    expect(chunkB).not.toBeNull();
    if (chunkA === null || chunkB === null) return;
    expect(lodResolutions[chunkA]).toBeGreaterThanOrEqual(PHYSICS_RESOLUTION_CAP);
    expect(lodResolutions[chunkB]).toBeGreaterThanOrEqual(PHYSICS_RESOLUTION_CAP);
  });

  it('falls back to the finest built level when nothing meets the cap', () => {
    expect(selectPhysicsSourceLod([5, 6, 8], lodResolutions)).toBe(5);
  });

  it('returns null when nothing is built', () => {
    expect(selectPhysicsSourceLod([], lodResolutions)).toBeNull();
  });

  it('ignores levels with no known resolution', () => {
    expect(selectPhysicsSourceLod([42], lodResolutions)).toBeNull();
  });

  it('is order-independent over the built set', () => {
    expect(selectPhysicsSourceLod([8, 3, 0], lodResolutions)).toBe(
      selectPhysicsSourceLod([0, 3, 8], lodResolutions)
    );
  });

  it('supports a custom cap', () => {
    // With a cap of 32, level 5 (res 32) is the coarsest that meets it
    expect(selectPhysicsSourceLod([2, 4, 5, 6], lodResolutions, 32)).toBe(5);
  });
});

describe('sampleHeightfield', () => {
  it('produces (numCells+1)^2 heights with correct min/max', () => {
    const getY = makeGetY(4, (u, v) => u + 2 * v);
    const sample = mustSample(getY, 4, 4);
    expect(sample.heights.length).toBe(25);
    expect(sample.numCells).toBe(4);
    expect(sample.numVertices).toBe(5);
    expect(sample.minHeight).toBe(0);
    expect(sample.maxHeight).toBe(3);
  });

  it('stores heights X-major (index = col * numVertices + row)', () => {
    // Height encodes position: u (X) in units, v (Z) in hundredths
    const getY = makeGetY(2, (u, v) => u * 2 + (v * 2) / 100);
    const sample = mustSample(getY, 2, 2);
    // col = X index, row = Z index
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const expected = col + row / 100;
        expect(sample.heights[col * 3 + row]).toBeCloseTo(expected, 5);
      }
    }
  });

  it('downsamples a higher-res mesh onto the same world grid points', () => {
    const getY = makeGetY(8, (u, v) => Math.sin(u * 7) + Math.cos(v * 5));
    const sample = mustSample(getY, 8, 4);
    // Every physics vertex must equal the mesh height at the same (u, v)
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const expected = Math.sin((col / 4) * 7) + Math.cos((row / 4) * 5);
        expect(sample.heights[col * 5 + row]).toBeCloseTo(expected, 5);
      }
    }
  });

  it('produces identical heightfields for different mesh LODs of the same terrain', () => {
    // This is the invariant that justifies skipping rebuilds on LOD flips
    // when the effective physics resolution is unchanged
    const heightAt = (u: number, v: number) => Math.sin(u * 13) * Math.cos(v * 9);
    const numCells = 16;
    const low = mustSample(makeGetY(32, heightAt), 32, numCells);
    const high = mustSample(makeGetY(64, heightAt), 64, numCells);
    expect(low.heights).toEqual(high.heights);
  });

  it('returns null when a sampled height is NaN', () => {
    const getY = makeGetY(4, (u, v) => (u === 0.5 && v === 0.5 ? NaN : 1));
    expect(sampleHeightfield(getY, 4, 4)).toBeNull();
  });

  it('returns null when a sampled height is Infinity', () => {
    const getY = () => Infinity;
    expect(sampleHeightfield(getY, 4, 4)).toBeNull();
  });

  it('handles flat terrain', () => {
    const sample = mustSample(() => 5, 4, 4);
    expect(sample.minHeight).toBe(5);
    expect(sample.maxHeight).toBe(5);
    expect(sample.heights.every((h) => h === 5)).toBe(true);
  });
});
