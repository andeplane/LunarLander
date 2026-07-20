import { describe, it, expect } from 'vitest';
import { computeSkirtedGridDimensions } from './terrain';

describe(computeSkirtedGridDimensions.name, () => {
  it('extends a square chunk by one vertex spacing on each edge', () => {
    const { extendedResolution, extendedWidth, extendedDepth } =
      computeSkirtedGridDimensions(400, 400, 128);

    const spacing = 400 / 128;
    expect(extendedResolution).toBe(130);
    expect(extendedWidth).toBeCloseTo(400 + 2 * spacing, 10);
    expect(extendedDepth).toBeCloseTo(400 + 2 * spacing, 10);
  });

  it('derives the skirt spacing per axis for non-square chunks', () => {
    // The latent seam: deriving both extensions from width/resolution would
    // give the depth axis the wrong skirt size whenever width != depth
    const width = 400;
    const depth = 200;
    const resolution = 64;
    const { extendedWidth, extendedDepth } = computeSkirtedGridDimensions(
      width,
      depth,
      resolution
    );

    expect(extendedWidth - width).toBeCloseTo(2 * (width / resolution), 10);
    expect(extendedDepth - depth).toBeCloseTo(2 * (depth / resolution), 10);
  });

  it('preserves the base grid spacing inside the extended grid (both axes)', () => {
    // Interior vertices of the extended grid must land exactly on the base
    // grid, i.e. the extended mesh keeps the same vertex spacing per axis
    const width = 300;
    const depth = 500;
    const resolution = 32;
    const { extendedResolution, extendedWidth, extendedDepth } =
      computeSkirtedGridDimensions(width, depth, resolution);

    expect(extendedWidth / extendedResolution).toBeCloseTo(width / resolution, 10);
    expect(extendedDepth / extendedResolution).toBeCloseTo(depth / resolution, 10);
  });
});
