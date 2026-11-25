import { MeshBasicMaterial, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import {
  craterParamsFromTerrainArgs,
  generateLargeCratersInBounds,
  LOD_FADE_END,
} from './craters';
import {
  type ChunkCoverage,
  coverageSignature,
  DEFAULT_FAR_TERRAIN_CONFIG,
  FarTerrain,
  type FarTerrainConfig,
  type FarTerrainGrid,
  generateFarTerrainGrid,
  isChunkCovered,
  FAR_SKIRT_DEPTH_FACTOR,
  farTerrainIndexCapacity,
  writeFarTerrainIndices,
} from './FarTerrain';
import { createHeightSampler } from './heightSampler';
import { RELIEF_LATTICE_SPACING, type TerrainFieldArgs } from './terrain';

const CHUNK = 400;

/** Production terrain settings (mirrors ChunkManager.baseTerrainArgs). */
const baseArgs: TerrainFieldArgs = {
  seed: 0,
  gain: 0.4,
  lacunarity: 2,
  frequency: 0.015,
  amplitude: 0.4,
  altitude: 0.1,
  octaves: 4,
  smoothLowerPlanes: 0,
  width: CHUNK,
  depth: CHUNK,
  renderDistance: 10,
  craterSeed: 42,
  craterDensity: 12000,
  craterMinRadius: 1,
  craterMaxRadius: 250,
  craterPowerLawExponent: -2,
  craterDepthRatio: 0.2,
  craterRimHeight: 0.04,
  craterRimWidth: 1.5,
  craterFloorFlatness: 0,
  craterDegradedDepthRatio: 0.04,
  craterFreshnessExponent: 3,
};

/** A small grid (25 x 25 vertices) so the tests stay fast. */
const smallConfig: FarTerrainConfig = {
  spacing: 100,
  halfExtent: 1200,
  recenterStep: 800,
  rowsPerSlice: 4,
  budgetMs: 2,
};

function generate(
  args: TerrainFieldArgs,
  centerX: number,
  centerZ: number,
  config: FarTerrainConfig
): { grid: FarTerrainGrid; slices: number } {
  const generator = generateFarTerrainGrid(args, centerX, centerZ, config);
  let slices = 1;
  let step = generator.next();
  while (!step.done) {
    slices++;
    step = generator.next();
  }
  return { grid: step.value, slices };
}

/** A clock that advances by a fixed amount every time it is read. */
function steppingClock(stepMs: number): () => number {
  let time = 0;
  return () => {
    time += stepMs;
    return time;
  };
}

const noCoverage: ChunkCoverage = { centerX: 1000, centerZ: 1000, radius: 0 };

describe(isChunkCovered.name, () => {
  it('covers the disc of chunks within the radius, boundary included', () => {
    const coverage: ChunkCoverage = { centerX: 0.25, centerZ: 0, radius: 2 };
    expect(isChunkCovered(0, 0, coverage)).toBe(true);
    expect(isChunkCovered(2, 0, coverage)).toBe(true);
    expect(isChunkCovered(-2, 0, coverage)).toBe(false);
    expect(isChunkCovered(2, 2, coverage)).toBe(false);
    expect(isChunkCovered(2, 0, { centerX: 0, centerZ: 0, radius: 2 })).toBe(true);
  });
});

describe(generateFarTerrainGrid.name, () => {
  it('lays out a world-aligned grid centred on the requested point', () => {
    const { grid } = generate(baseArgs, 800, -1600, smallConfig);

    expect(grid.size).toBe(25);
    expect(grid.spacing).toBe(100);
    expect(grid.originX).toBe(-400);
    expect(grid.originZ).toBe(-2800);
    // Surface vertices, then their lowered copies for the hole's wall
    expect(grid.positions.length).toBe(25 * 25 * 6);
    expect(grid.normals.length).toBe(25 * 25 * 6);
    const lowered = 25 * 25 * 3;
    for (let i = 0; i < lowered; i += 3) {
      expect(grid.positions[lowered + i]).toBe(grid.positions[i]);
      expect(grid.positions[lowered + i + 1]).toBeCloseTo(
        grid.positions[i + 1] - FAR_SKIRT_DEPTH_FACTOR * 100,
        3
      );
      expect(grid.positions[lowered + i + 2]).toBe(grid.positions[i + 2]);
      expect(grid.normals[lowered + i + 1]).toBe(grid.normals[i + 1]);
    }

    for (let row = 0; row < grid.size; row++) {
      for (let col = 0; col < grid.size; col++) {
        const i = (row * grid.size + col) * 3;
        expect(grid.positions[i]).toBe(grid.originX + col * 100);
        expect(grid.positions[i + 2]).toBe(grid.originZ + row * 100);
      }
    }
  });

  it('matches the chunk height function at every vertex', () => {
    // The far grid drops craters below 2.5 vertex spacings the way coarse
    // chunk LODs do, so compare on a population that starts above that
    const args: TerrainFieldArgs = {
      ...baseArgs,
      craterMinRadius: LOD_FADE_END * smallConfig.spacing,
      craterMaxRadius: 600,
      craterDensity: 200000,
    };
    const { grid } = generate(args, 0, 0, smallConfig);
    const sampler = createHeightSampler(args);
    const craterFree = createHeightSampler({ ...args, craterDensity: 0 });

    let maxCraterEffect = 0;
    const vertexCount = grid.size * grid.size;
    for (let i = 0; i < vertexCount; i++) {
      const x = grid.positions[i * 3];
      const z = grid.positions[i * 3 + 2];
      const expected = sampler.heightAt(x, z);
      expect(grid.positions[i * 3 + 1]).toBeCloseTo(expected, 3);
      maxCraterEffect = Math.max(maxCraterEffect, Math.abs(expected - craterFree.heightAt(x, z)));
    }
    // Guard against a vacuous pass: craters shaped this grid
    expect(maxCraterEffect).toBeGreaterThan(1);
  });

  it('gives the same grid whatever the slice size', () => {
    const args: TerrainFieldArgs = { ...baseArgs, craterMaxRadius: 600 };
    const sliced = generate(args, 0, 0, { ...smallConfig, rowsPerSlice: 4 });
    const whole = generate(args, 0, 0, { ...smallConfig, rowsPerSlice: 1000 });

    expect(sliced.slices).toBe(6);
    expect(whole.slices).toBe(1);
    for (let i = 0; i < whole.grid.positions.length; i++) {
      expect(sliced.grid.positions[i]).toBeCloseTo(whole.grid.positions[i], 4);
    }
  });

  it('folds a lone last row into the previous slice and never slices below two rows', () => {
    // 25 rows in slices of 12: 12 + 13, not 12 + 12 + 1
    expect(generate(baseArgs, 0, 0, { ...smallConfig, rowsPerSlice: 12 }).slices).toBe(2);
    // rowsPerSlice below 2 is raised to 2: 11 slices of 2 plus one of 3
    expect(generate(baseArgs, 0, 0, { ...smallConfig, rowsPerSlice: 0 }).slices).toBe(12);
  });

  it('is deterministic and agrees between overlapping grids', () => {
    const args: TerrainFieldArgs = { ...baseArgs, craterMaxRadius: 600 };
    const a = generate(args, 0, 0, smallConfig).grid;
    const b = generate(args, 0, 0, smallConfig).grid;
    expect(b.positions).toEqual(a.positions);
    expect(b.normals).toEqual(a.normals);

    // Shifted by 8 columns: the shared vertices carry the same heights
    const shifted = generate(args, 800, 0, smallConfig).grid;
    for (let row = 0; row < a.size; row++) {
      for (let col = 8; col < a.size; col++) {
        const here = a.positions[(row * a.size + col) * 3 + 1];
        const there = shifted.positions[(row * a.size + col - 8) * 3 + 1];
        expect(there).toBeCloseTo(here, 4);
      }
    }
  });

  it('writes unit normals that follow the height differences', () => {
    const { grid } = generate(baseArgs, 0, 0, smallConfig);
    const { size, spacing, positions, normals } = grid;
    const height = (row: number, col: number): number => positions[(row * size + col) * 3 + 1];

    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const i = (row * size + col) * 3;
        expect(Math.hypot(normals[i], normals[i + 1], normals[i + 2])).toBeCloseTo(1, 5);
        expect(normals[i + 1]).toBeGreaterThan(0);
      }
    }

    // Interior vertex: central differences
    const row = 10;
    const col = 7;
    const slopeX = (height(row, col + 1) - height(row, col - 1)) / (2 * spacing);
    const slopeZ = (height(row + 1, col) - height(row - 1, col)) / (2 * spacing);
    const i = (row * size + col) * 3;
    expect(normals[i] / normals[i + 1]).toBeCloseTo(-slopeX, 4);
    expect(normals[i + 2] / normals[i + 1]).toBeCloseTo(-slopeZ, 4);

    // Corner vertex: one-sided differences
    const cornerSlopeX = (height(0, 1) - height(0, 0)) / spacing;
    const cornerSlopeZ = (height(1, 0) - height(0, 0)) / spacing;
    expect(normals[0] / normals[1]).toBeCloseTo(-cornerSlopeX, 4);
    expect(normals[2] / normals[1]).toBeCloseTo(-cornerSlopeZ, 4);
  });

  it('works without relief (pure fine noise)', () => {
    const flat: TerrainFieldArgs = {
      ...baseArgs,
      craterDensity: 0,
      rollingAmplitude: 0,
      massifHeight: 0,
    };
    const { grid } = generate(flat, 0, 0, smallConfig);
    const sampler = createHeightSampler(flat);
    for (let i = 0; i < grid.size * grid.size; i += 7) {
      expect(grid.positions[i * 3 + 1]).toBeCloseTo(
        sampler.heightAt(grid.positions[i * 3], grid.positions[i * 3 + 2]),
        4
      );
    }
  });

  it('rejects a spacing that is off the relief lattice', () => {
    const generator = generateFarTerrainGrid(baseArgs, 0, 0, {
      ...smallConfig,
      spacing: RELIEF_LATTICE_SPACING * 1.5,
    });
    expect(() => generator.next()).toThrow(/multiple of 25/);
  });
});

describe(writeFarTerrainIndices.name, () => {
  const grid = { originX: -1200, originZ: -1200, spacing: 100, size: 25 };
  const cells = (grid.size - 1) * (grid.size - 1);

  it('writes two triangles per cell when no chunk is covered', () => {
    const indices = new Uint32Array(farTerrainIndexCapacity(grid.size));
    const count = writeFarTerrainIndices(indices, grid, CHUNK, CHUNK, noCoverage);

    expect(count).toBe(cells * 6);
    // First cell: both triangles wind the same way (upward-facing)
    expect(Array.from(indices.subarray(0, 6))).toEqual([0, 25, 1, 1, 25, 26]);
    for (let i = 0; i < count; i++) expect(indices[i]).toBeLessThan(grid.size * grid.size);
  });

  it('leaves out exactly the cells under covered chunks and walls the hole', () => {
    const coverage: ChunkCoverage = { centerX: 0.3, centerZ: -0.2, radius: 1.5 };
    const indices = new Uint32Array(farTerrainIndexCapacity(grid.size));
    const count = writeFarTerrainIndices(indices, grid, CHUNK, CHUNK, coverage);

    // Chunks span 4 x 4 cells here; each chunk side on the outline is 4 walls
    let coveredChunks = 0;
    let outlineSides = 0;
    for (let gridZ = -3; gridZ <= 3; gridZ++) {
      for (let gridX = -3; gridX <= 3; gridX++) {
        if (!isChunkCovered(gridX, gridZ, coverage)) continue;
        coveredChunks++;
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          if (!isChunkCovered(gridX + dx, gridZ + dz, coverage)) outlineSides++;
        }
      }
    }
    expect(coveredChunks).toBeGreaterThan(0);
    const surfaceCount = (cells - coveredChunks * 16) * 6;
    expect(count).toBe(surfaceCount + outlineSides * 4 * 6);

    // No written triangle lies in a covered chunk
    for (let i = 0; i < surfaceCount; i += 3) {
      const col = Math.min(indices[i] % 25, indices[i + 1] % 25, indices[i + 2] % 25);
      const row = Math.floor(Math.min(indices[i], indices[i + 1], indices[i + 2]) / 25);
      const gridX = Math.round((grid.originX + (col + 0.5) * 100) / CHUNK);
      const gridZ = Math.round((grid.originZ + (row + 0.5) * 100) / CHUNK);
      expect(isChunkCovered(gridX, gridZ, coverage)).toBe(false);
    }

    // Every wall quad hangs from an edge on the hole's outline and faces
    // into the hole
    const vertices = grid.size * grid.size;
    const centre = (v: number): [number, number] => [v % 25, Math.floor(v / 25)];
    for (let i = surfaceCount; i < count; i += 6) {
      const [top0, top1, bottom0, top1Again, bottom1, bottom0Again] = indices.subarray(i, i + 6);
      expect(bottom0).toBe(top0 + vertices);
      expect(bottom1).toBe(top1 + vertices);
      expect(top1Again).toBe(top1);
      expect(bottom0Again).toBe(bottom0);

      const [col0, row0] = centre(top0);
      const [col1, row1] = centre(top1);
      expect(Math.abs(col1 - col0) + Math.abs(row1 - row0)).toBe(1);
      // Front face normal of (top0, top1, bottom0) is edge x down
      const normalX = row1 - row0;
      const normalZ = -(col1 - col0);
      const midX = grid.originX + ((col0 + col1) / 2) * 100;
      const midZ = grid.originZ + ((row0 + row1) / 2) * 100;
      const inside = (sign: number): boolean =>
        isChunkCovered(
          Math.round((midX + sign * normalX * 50) / CHUNK),
          Math.round((midZ + sign * normalZ * 50) / CHUNK),
          coverage
        );
      expect(inside(1)).toBe(true);
      expect(inside(-1)).toBe(false);
    }
  });

  it('stops walling when the index buffer is full', () => {
    const coverage: ChunkCoverage = { centerX: 0, centerZ: 0, radius: 0.5 };
    const surfaceCount = (cells - 16) * 6;
    const indices = new Uint32Array(surfaceCount + 6 * 3 + 5);
    const count = writeFarTerrainIndices(indices, grid, CHUNK, CHUNK, coverage);

    expect(count).toBe(surfaceCount + 6 * 3);
  });
});

describe(coverageSignature.name, () => {
  it('is stable while the set of covered chunks is unchanged', () => {
    const a = coverageSignature({ centerX: 0.1, centerZ: 0.1, radius: 2.5 });
    const b = coverageSignature({ centerX: 0.11, centerZ: 0.1, radius: 2.5 });
    expect(b).toBe(a);
  });

  it('changes when a chunk enters or leaves the disc', () => {
    const a = coverageSignature({ centerX: 0.1, centerZ: 0, radius: 2 });
    const b = coverageSignature({ centerX: -0.1, centerZ: 0, radius: 2 });
    const c = coverageSignature({ centerX: 5, centerZ: 0, radius: 2 });
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);
  });
});

describe(generateLargeCratersInBounds.name, () => {
  it('feeds the far grid only craters big enough for its spacing', () => {
    const args: TerrainFieldArgs = { ...baseArgs, craterMaxRadius: 600 };
    const craters = generateLargeCratersInBounds(
      { minX: -1200, maxX: 1200, minZ: -1200, maxZ: 1200 },
      CHUNK,
      CHUNK,
      craterParamsFromTerrainArgs(args),
      125
    );
    expect(craters.length).toBeGreaterThan(0);
    for (const crater of craters) expect(crater.radius).toBeGreaterThanOrEqual(125);
  });
});

describe(FarTerrain.name, () => {
  it('stays hidden until the first grid is ready, generating within its budget', () => {
    const material = new MeshBasicMaterial();
    // Every clock read costs 1 ms: a 2 ms budget allows two slices per update
    const far = new FarTerrain(material, baseArgs, smallConfig, steppingClock(1));

    expect(far.mesh.visible).toBe(false);
    expect(far.mesh.frustumCulled).toBe(false);
    expect(far.ready).toBe(false);

    // 6 slices of 4 rows: two per update, so ready on the third
    expect(far.update(0, 0, noCoverage)).toBe(false);
    expect(far.ready).toBe(false);
    expect(far.update(0, 0, noCoverage)).toBe(false);
    expect(far.update(0, 0, noCoverage)).toBe(true);

    expect(far.ready).toBe(true);
    expect(far.mesh.visible).toBe(true);
    expect(far.mesh.material).toBe(material);
    const cells = 24 * 24;
    expect(far.mesh.geometry.getAttribute('position').count).toBe(25 * 25 * 2);
    expect(far.mesh.geometry.getAttribute('normal').count).toBe(25 * 25 * 2);
    expect(far.mesh.geometry.drawRange.count).toBe(cells * 6);

    // Nothing left to do
    expect(far.update(0, 0, noCoverage)).toBe(false);
  });

  it('rebuilds the hole only when the covered chunks change', () => {
    const far = new FarTerrain(new MeshBasicMaterial(), baseArgs, smallConfig, () => 0);
    const coverage: ChunkCoverage = { centerX: 0, centerZ: 0, radius: 1.2 };
    while (!far.ready) far.update(0, 0, coverage);

    const cells = 24 * 24;
    // Disc of radius 1.2: five chunks of 16 cells, with a 48-edge outline
    expect(far.mesh.geometry.drawRange.count).toBe((cells - 5 * 16 + 48) * 6);
    const version = far.mesh.geometry.getIndex()?.version;

    expect(far.update(10, 0, { centerX: 0.025, centerZ: 0, radius: 1.2 })).toBe(false);
    expect(far.mesh.geometry.getIndex()?.version).toBe(version);

    expect(far.update(10, 0, { centerX: 0.025, centerZ: 0, radius: 0.5 })).toBe(true);
    expect(far.mesh.geometry.drawRange.count).toBe((cells - 16 + 16) * 6);
    expect(far.mesh.geometry.getIndex()?.version).not.toBe(version);
  });

  it('recentres with hysteresis once the camera leaves the middle block', () => {
    const far = new FarTerrain(new MeshBasicMaterial(), baseArgs, smallConfig, () => 0);
    while (!far.ready) far.update(0, 0, noCoverage);
    const first = far.mesh.geometry;
    expect(first.getAttribute('position').getX(0)).toBe(-1200);

    // Past the snap boundary (400 m) but inside the hysteresis band (600 m)
    expect(far.update(500, 0, noCoverage)).toBe(false);
    expect(far.mesh.geometry).toBe(first);

    // Beyond it: a new grid centred on the snapped camera position
    let changed = false;
    for (let i = 0; i < 20 && !changed; i++) changed = far.update(700, 0, noCoverage);
    expect(changed).toBe(true);
    expect(far.mesh.geometry).not.toBe(first);
    expect(far.mesh.geometry.getAttribute('position').getX(0)).toBe(800 - 1200);
    expect(far.mesh.geometry.drawRange.count).toBe(24 * 24 * 6);

    // Hovering near the new centre does not regenerate
    const second = far.mesh.geometry;
    for (let i = 0; i < 5; i++) far.update(450, 0, noCoverage);
    expect(far.mesh.geometry).toBe(second);
  });

  it('keeps drawing the old grid while a new one is generated, and retargets mid-flight', () => {
    const far = new FarTerrain(new MeshBasicMaterial(), baseArgs, smallConfig, steppingClock(10));
    while (!far.ready) far.update(0, 0, noCoverage);
    const first = far.mesh.geometry;

    // One slice per update: still the old grid after the first step
    far.update(700, 0, noCoverage);
    expect(far.mesh.geometry).toBe(first);
    expect(far.mesh.visible).toBe(true);

    // The camera races on before generation finishes: restart for the new centre
    let changed = false;
    for (let i = 0; i < 20 && !changed; i++) changed = far.update(2400, 0, noCoverage);
    expect(far.mesh.geometry.getAttribute('position').getX(0)).toBe(2400 - 1200);
  });

  it('uses the production configuration by default', () => {
    const far = new FarTerrain(new MeshBasicMaterial(), baseArgs);
    expect(DEFAULT_FAR_TERRAIN_CONFIG.halfExtent % CHUNK).toBe(0);
    expect(DEFAULT_FAR_TERRAIN_CONFIG.recenterStep % CHUNK).toBe(0);
    expect(DEFAULT_FAR_TERRAIN_CONFIG.spacing % RELIEF_LATTICE_SPACING).toBe(0);
    expect(CHUNK % DEFAULT_FAR_TERRAIN_CONFIG.spacing).toBe(0);
    // One budgeted step does not finish the default grid
    expect(far.update(0, 0, noCoverage)).toBe(false);
    expect(far.ready).toBe(false);
    far.dispose();
  });

  it('removes its mesh from the scene on dispose', () => {
    const scene = new Scene();
    const far = new FarTerrain(new MeshBasicMaterial(), baseArgs, smallConfig, () => 0);
    scene.add(far.mesh);
    while (!far.ready) far.update(0, 0, noCoverage);

    far.dispose();
    expect(far.mesh.parent).toBeNull();
    expect(far.ready).toBe(false);
  });
});
