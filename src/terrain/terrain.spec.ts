import { describe, expect, it } from 'vitest';
import {
  computeSkirtedGridDimensions,
  createReliefField,
  createReliefSource,
  createLatticeTerrainEvaluator,
  createTerrainEvaluator,
  generateTerrain,
  RELIEF_DEFAULTS,
  RELIEF_LATTICE_SPACING,
  type ReliefParams,
  reliefParamsFromTerrainArgs,
  type TerrainArgs,
  terrainDisplacementStrength,
} from './terrain';

/** Production noise settings (mirrors ChunkManager.baseTerrainArgs), no craters. */
function productionArgs(gridX: number, gridZ: number, resolution = 64): TerrainArgs {
  return {
    seed: 0,
    gain: 0.4,
    lacunarity: 2,
    frequency: 0.015,
    amplitude: 0.4,
    altitude: 0.1,
    octaves: 4,
    smoothLowerPlanes: 0,
    width: 400,
    depth: 400,
    resolution,
    posX: gridX * 400,
    posZ: gridZ * 400,
    renderDistance: 10,
    craterSeed: 42,
    craterDensity: 0,
    craterMinRadius: 1,
    craterMaxRadius: 250,
    craterPowerLawExponent: -2,
    craterDepthRatio: 0.2,
    craterRimHeight: 0.04,
    craterRimWidth: 1.5,
    craterFloorFlatness: 0,
  };
}

const reliefParams: ReliefParams = { seed: 0, ...RELIEF_DEFAULTS };

describe(computeSkirtedGridDimensions.name, () => {
  it('extends a square chunk by one vertex spacing on each edge', () => {
    const { extendedResolution, extendedWidth, extendedDepth } = computeSkirtedGridDimensions(
      400,
      400,
      128
    );

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
    const { extendedWidth, extendedDepth } = computeSkirtedGridDimensions(width, depth, resolution);

    expect(extendedWidth - width).toBeCloseTo(2 * (width / resolution), 10);
    expect(extendedDepth - depth).toBeCloseTo(2 * (depth / resolution), 10);
  });

  it('preserves the base grid spacing inside the extended grid (both axes)', () => {
    // Interior vertices of the extended grid must land exactly on the base
    // grid, i.e. the extended mesh keeps the same vertex spacing per axis
    const width = 300;
    const depth = 500;
    const resolution = 32;
    const { extendedResolution, extendedWidth, extendedDepth } = computeSkirtedGridDimensions(
      width,
      depth,
      resolution
    );

    expect(extendedWidth / extendedResolution).toBeCloseTo(width / resolution, 10);
    expect(extendedDepth / extendedResolution).toBeCloseTo(depth / resolution, 10);
  });
});

describe(terrainDisplacementStrength.name, () => {
  it('is 2.8 at full strength and halves with smoothLowerPlanes = 1', () => {
    expect(terrainDisplacementStrength(0)).toBeCloseTo(2.8, 12);
    expect(terrainDisplacementStrength(1)).toBeCloseTo(1.4, 12);
  });
});

describe(reliefParamsFromTerrainArgs.name, () => {
  it('applies the defaults for missing fields and keeps explicit values', () => {
    expect(reliefParamsFromTerrainArgs({ seed: 5 })).toEqual({ seed: 5, ...RELIEF_DEFAULTS });
    expect(
      reliefParamsFromTerrainArgs({
        seed: 5,
        rollingAmplitude: 0,
        massifHeight: 12,
        spawnFlatRadius: 50,
      })
    ).toEqual({ seed: 5, rollingAmplitude: 0, massifHeight: 12, spawnFlatRadius: 50 });
  });
});

describe(createReliefSource.name, () => {
  it('is deterministic and depends on the seed', () => {
    const a = createReliefSource(reliefParams);
    const b = createReliefSource(reliefParams);
    const other = createReliefSource({ ...reliefParams, seed: 1 });
    let differs = false;
    for (const [x, z] of [
      [0, 0],
      [1234, -777],
      [-3500, 2100],
      [9000, 9000],
    ] as const) {
      expect(a(x, z)).toBe(b(x, z));
      if (a(x, z) !== other(x, z)) differs = true;
    }
    expect(differs).toBe(true);
  });

  it('is exactly 0 when both layers are disabled', () => {
    const flat = createReliefSource({ ...reliefParams, rollingAmplitude: 0, massifHeight: 0 });
    expect(flat(123, 456)).toBe(0);
    expect(flat(-5000, 2500)).toBe(0);
  });

  it('keeps massifs out of the spawn area', () => {
    const massifs = createReliefSource({ ...reliefParams, rollingAmplitude: 0 });
    for (let x = -300; x <= 300; x += 20) {
      for (let z = -300; z <= 300; z += 20) {
        if (Math.hypot(x, z) <= RELIEF_DEFAULTS.spawnFlatRadius) {
          expect(massifs(x, z)).toBe(0);
        }
      }
    }
    // A zero spawn radius is allowed (massifs may then rise anywhere)
    const noSpawn = createReliefSource({
      ...reliefParams,
      rollingAmplitude: 0,
      spawnFlatRadius: 0,
    });
    expect(Number.isFinite(noSpawn(0, 0))).toBe(true);
  });

  it('leaves most of the area as plains and raises smooth massifs in some regions', () => {
    const massifs = createReliefSource({ ...reliefParams, rollingAmplitude: 0 });
    let plains = 0;
    let total = 0;
    let highest = 0;
    let steepest = 0;
    const step = 50;
    for (let x = -12000; x <= 12000; x += step) {
      for (let z = -12000; z <= 12000; z += step) {
        const h = massifs(x, z);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(RELIEF_DEFAULTS.massifHeight);
        if (h === 0) plains++;
        total++;
        highest = Math.max(highest, h);
        steepest = Math.max(steepest, Math.abs(massifs(x + step, z) - h) / step);
      }
    }
    expect(plains / total).toBeGreaterThan(0.6);
    expect(plains / total).toBeLessThan(0.95);
    // In meters (x2.8): massifs well over 100 m tall, flanks under ~35 degrees
    expect(highest * 2.8).toBeGreaterThan(100);
    expect(steepest * 2.8).toBeLessThan(Math.tan((35 * Math.PI) / 180));
  });

  it('adds gentle rolling relief within its amplitude, reduced near spawn', () => {
    const rolling = createReliefSource({ ...reliefParams, massifHeight: 0 });
    let maxNear = 0;
    let maxFar = 0;
    for (let x = -100; x <= 100; x += 10) {
      for (let z = -100; z <= 100; z += 10) {
        maxNear = Math.max(maxNear, Math.abs(rolling(x, z)));
        maxFar = Math.max(maxFar, Math.abs(rolling(x + 5000, z + 5000)));
        expect(Math.abs(rolling(x * 40, z * 40))).toBeLessThanOrEqual(
          RELIEF_DEFAULTS.rollingAmplitude
        );
      }
    }
    expect(maxNear).toBeLessThanOrEqual(0.35 * RELIEF_DEFAULTS.rollingAmplitude);
    expect(maxFar).toBeGreaterThan(0);
  });
});

describe(createReliefField.name, () => {
  const source = createReliefSource(reliefParams);
  const bounds = { minX: 1000, maxX: 1400, minZ: -600, maxZ: -200 };

  it('reproduces the source exactly on lattice nodes and closely in between', () => {
    const field = createReliefField(source, bounds);
    for (let i = 40; i <= 56; i += 4) {
      for (let j = -24; j <= -8; j += 4) {
        const x = i * RELIEF_LATTICE_SPACING;
        const z = j * RELIEF_LATTICE_SPACING;
        expect(field(x, z)).toBeCloseTo(source(x, z), 12);
      }
    }
    let maxError = 0;
    for (let x = bounds.minX; x <= bounds.maxX; x += 7.3) {
      for (let z = bounds.minZ; z <= bounds.maxZ; z += 7.3) {
        maxError = Math.max(maxError, Math.abs(field(x, z) - source(x, z)));
      }
    }
    // Well under 0.3 m (x2.8) on relief of over 100 m
    expect(maxError).toBeLessThan(0.1);
  });

  it('gives bit-identical values from the precomputed patch and the fallback', () => {
    const inPatch = createReliefField(source, bounds);
    const elsewhere = createReliefField(source, { minX: -8000, maxX: -7600, minZ: 0, maxZ: 400 });
    const neighbor = createReliefField(source, { minX: 1400, maxX: 1800, minZ: -600, maxZ: -200 });
    for (let x = bounds.minX - 30; x <= bounds.maxX + 30; x += 13.7) {
      for (let z = bounds.minZ - 30; z <= bounds.maxZ + 30; z += 13.7) {
        const value = inPatch(x, z);
        expect(elsewhere(x, z)).toBe(value);
        expect(neighbor(x, z)).toBe(value);
      }
    }
  });

  it('is C1 across lattice cell borders', () => {
    const field = createReliefField(source, bounds, 25);
    const h = 1e-3;
    for (const z of [-555.5, -400, -312.3]) {
      for (let node = 1025; node <= 1375; node += 25) {
        const left = (field(node, z) - field(node - h, z)) / h;
        const right = (field(node + h, z) - field(node, z)) / h;
        expect(Math.abs(right - left)).toBeLessThan(1e-3);
      }
    }
  });

  it('supports a custom lattice spacing', () => {
    const coarse = createReliefField(source, bounds, 100);
    expect(coarse(1200, -400)).toBeCloseTo(source(1200, -400), 12);
  });
});

describe(createTerrainEvaluator.name, () => {
  it('is deterministic', () => {
    const a = createTerrainEvaluator(productionArgs(2, -1));
    const b = createTerrainEvaluator(productionArgs(2, -1));
    for (const [x, z] of [
      [0, 0],
      [-200, 200],
      [13.5, -77.25],
    ] as const) {
      expect(a(x, z)).toBe(b(x, z));
    }
  });

  it('agrees exactly between neighboring chunks on shared edges and corners', () => {
    for (const [gridX, gridZ] of [
      [0, 0],
      [4, -3],
      [-7, 9],
    ] as const) {
      const here = createTerrainEvaluator(productionArgs(gridX, gridZ));
      const east = createTerrainEvaluator(productionArgs(gridX + 1, gridZ));
      const south = createTerrainEvaluator(productionArgs(gridX, gridZ + 1));
      const diagonal = createTerrainEvaluator(productionArgs(gridX + 1, gridZ + 1));
      for (let i = 0; i <= 64; i++) {
        const t = -200 + (400 * i) / 64;
        expect(east(-200, t)).toBe(here(200, t));
        expect(south(t, -200)).toBe(here(t, 200));
      }
      expect(diagonal(-200, -200)).toBe(here(200, 200));
    }
  });

  it('is fine noise + altitude only when the relief is disabled', () => {
    const noRelief = { ...productionArgs(3, 3), rollingAmplitude: 0, massifHeight: 0 };
    const flat = createTerrainEvaluator({ ...noRelief, amplitude: 0 });
    expect(flat(12, -34)).toBe(0.1);
    expect(flat(-150, 80)).toBe(0.1);

    // With relief, the same point differs by exactly the relief field
    const withRelief = createTerrainEvaluator(productionArgs(3, 3));
    const fine = createTerrainEvaluator(noRelief);
    const field = createReliefField(createReliefSource({ seed: 0, ...RELIEF_DEFAULTS }), {
      minX: 1000,
      maxX: 1400,
      minZ: 1000,
      maxZ: 1400,
    });
    expect(withRelief(12, -34) - fine(12, -34)).toBeCloseTo(field(1212, 1166), 10);
  });

  it('keeps the spawn area gentle and builds real relief far away', () => {
    const strength = terrainDisplacementStrength(0);
    let spawnMin = Number.POSITIVE_INFINITY;
    let spawnMax = Number.NEGATIVE_INFINITY;
    for (const [gridX, gridZ] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
    ] as const) {
      const evaluate = createTerrainEvaluator(productionArgs(gridX, gridZ));
      for (let x = -200; x < 200; x += 10) {
        for (let z = -200; z < 200; z += 10) {
          if (Math.hypot(x + gridX * 400, z + gridZ * 400) > 300) continue;
          const h = evaluate(x, z) * strength;
          spawnMin = Math.min(spawnMin, h);
          spawnMax = Math.max(spawnMax, h);
        }
      }
    }
    expect(spawnMax - spawnMin).toBeLessThan(12);

    let farMax = Number.NEGATIVE_INFINITY;
    for (let gridX = -12; gridX <= 12; gridX += 2) {
      for (let gridZ = -12; gridZ <= 12; gridZ += 2) {
        const evaluate = createTerrainEvaluator(productionArgs(gridX, gridZ));
        farMax = Math.max(farMax, evaluate(0, 0) * strength);
      }
    }
    expect(farMax).toBeGreaterThan(60);
    expect(farMax).toBeLessThan(200);
  });
});

describe(generateTerrain.name, () => {
  it('displaces a plane by the evaluator times the displacement strength', () => {
    const args = { ...productionArgs(1, 2, 8), smoothLowerPlanes: 0.5 };
    const geometry = generateTerrain(args);
    const positions = geometry.attributes.position;
    const evaluate = createTerrainEvaluator(args);
    const strength = terrainDisplacementStrength(0.5);

    expect(positions.count).toBe(81);
    for (let i = 0; i < positions.count; i++) {
      expect(positions.getY(i)).toBeCloseTo(
        evaluate(positions.getX(i), positions.getZ(i)) * strength,
        4
      );
    }
    expect(geometry.attributes.normal.count).toBe(81);
    geometry.dispose();
  });
});

describe(createLatticeTerrainEvaluator.name, () => {
  it('agrees with the chunk evaluator at relief lattice nodes', () => {
    const lattice = createLatticeTerrainEvaluator(productionArgs(0, 0));
    for (const [gridX, gridZ] of [
      [0, 0],
      [12, -7],
      [-30, 21],
    ] as const) {
      const chunk = createTerrainEvaluator(productionArgs(gridX, gridZ));
      for (let x = -200; x <= 200; x += RELIEF_LATTICE_SPACING * 2) {
        for (let z = -200; z <= 200; z += RELIEF_LATTICE_SPACING * 4) {
          expect(lattice(gridX * 400 + x, gridZ * 400 + z)).toBeCloseTo(chunk(x, z), 9);
        }
      }
    }
  });

  it('is the fine noise plus altitude when relief is off', () => {
    const args = { ...productionArgs(3, 5), rollingAmplitude: 0, massifHeight: 0 };
    const lattice = createLatticeTerrainEvaluator(args);
    const chunk = createTerrainEvaluator(args);
    // Without relief there is no lattice restriction
    expect(lattice(3 * 400 + 13.5, 5 * 400 - 77.25)).toBe(chunk(13.5, -77.25));
  });
});
