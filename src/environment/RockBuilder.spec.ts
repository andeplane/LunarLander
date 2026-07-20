import { describe, it, expect } from 'vitest';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { RockBuilder } from './RockBuilder';

/** Build a geometry from a flat list of [x, y, z, x, y, z, ...] positions. */
function geometryFromPositions(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  return geometry;
}

describe(`${RockBuilder.name}.calculateStableAxis`, () => {
  it('is deterministic for a regular geometry', () => {
    // Elongated point cloud: dominant inertia axis is well-defined
    const geometry = geometryFromPositions([
      3, 0.2, 0.1,
      -3, -0.2, 0.1,
      2.5, 0.3, -0.2,
      -2.5, -0.1, 0.2,
      1, 0.5, 0.4,
      -1, -0.4, -0.5,
    ]);

    const first = RockBuilder.calculateStableAxis(geometry);
    const second = RockBuilder.calculateStableAxis(geometry);

    expect(first.length()).toBeCloseTo(1, 6);
    expect(second.x).toBe(first.x);
    expect(second.y).toBe(first.y);
    expect(second.z).toBe(first.z);
  });

  it('is deterministic when power iteration needs a restart (degenerate tensor)', () => {
    // All vertices on the X axis: the inertia tensor is diag(0, s, s), so the
    // initial power-iteration guess (1, 0, 0) maps to the zero vector and the
    // restart path is taken. With the old Math.random() restart the result
    // varied between calls/sessions; it must now be reproducible.
    const geometry = geometryFromPositions([
      1, 0, 0,
      -1, 0, 0,
      2, 0, 0,
      -2, 0, 0,
      0.5, 0, 0,
      -0.5, 0, 0,
    ]);

    const first = RockBuilder.calculateStableAxis(geometry);
    const second = RockBuilder.calculateStableAxis(geometry);

    expect(Number.isFinite(first.x)).toBe(true);
    expect(Number.isFinite(first.y)).toBe(true);
    expect(Number.isFinite(first.z)).toBe(true);
    expect(first.length()).toBeCloseTo(1, 6);

    // Deterministic across repeated calls
    expect(second.x).toBe(first.x);
    expect(second.y).toBe(first.y);
    expect(second.z).toBe(first.z);

    // The restart direction (0, 1, 0) is an eigenvector of diag(0, s, s), so
    // the iteration must converge to an axis perpendicular to X
    expect(Math.abs(first.x)).toBeLessThan(1e-6);
  });
});
