import { PlaneGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { buildChunkMesh } from './chunkMesh';
import { skirtVertexCount } from './chunkSkirt';
import {
  craterLodWeight,
  craterParamsFromTerrainArgs,
  generateCratersForRegion,
  getCraterHeightModAt,
  LOD_FADE_END,
  LOD_FADE_START,
} from './craters';
import { createHeightSampler } from './heightSampler';
import {
  computeSkirtedGridDimensions,
  createTerrainEvaluator,
  type TerrainArgs,
  terrainDisplacementStrength,
} from './terrain';

/** Production settings (mirrors ChunkManager.baseTerrainArgs + main.ts). */
function chunkArgs(gridX: number, gridZ: number, resolution: number): TerrainArgs {
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
    craterDensity: 6000,
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
}

function cratersFor(args: TerrainArgs) {
  const gridKey = `${Math.round(args.posX / args.width)},${Math.round(args.posZ / args.depth)}`;
  const margin = Math.max(args.width, args.depth) / args.resolution;
  return generateCratersForRegion(
    gridKey,
    args.width,
    args.depth,
    craterParamsFromTerrainArgs(args),
    margin
  );
}

function build(args: TerrainArgs) {
  return buildChunkMesh(args, cratersFor(args));
}

describe(buildChunkMesh.name, () => {
  it('lays out a (resolution + 1)² row-major grid centered on the chunk', () => {
    const args = chunkArgs(2, -1, 16);
    const { positions, normals } = build(args);
    expect(positions.length).toBe(17 * 17 * 3);
    expect(normals.length).toBe(17 * 17 * 3);
    for (let row = 0; row <= 16; row++) {
      for (let col = 0; col <= 16; col++) {
        const offset = (row * 17 + col) * 3;
        expect(positions[offset]).toBe(-200 + col * 25);
        expect(positions[offset + 2]).toBe(-200 + row * 25);
      }
    }
  });

  it('stores exactly the height sampler value at every vertex (float32)', () => {
    // 256 segments = 1.5625 m spacing; craters from 4 m radius up are all
    // beyond the LOD fade, so mesh and point sampler see the same craters
    const args = { ...chunkArgs(3, -2, 256), craterMinRadius: 4 };
    expect(args.craterMinRadius).toBeGreaterThanOrEqual((LOD_FADE_END * 400) / 256);
    const { positions } = build(args);
    const sampler = createHeightSampler(args);
    const craterFree = createHeightSampler({ ...args, craterDensity: 0 });

    let maxCraterEffect = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const worldX = args.posX + positions[i];
      const worldZ = args.posZ + positions[i + 2];
      const sampled = sampler.heightAt(worldX, worldZ);
      expect(positions[i + 1]).toBe(Math.fround(sampled));
      maxCraterEffect = Math.max(
        maxCraterEffect,
        Math.abs(sampled - craterFree.heightAt(worldX, worldZ))
      );
    }
    // Craters really shaped this mesh
    expect(maxCraterEffect).toBeGreaterThan(1);
  });

  it('matches at full LOD0 resolution with the production crater sizes', () => {
    const args = chunkArgs(-1, 4, 1024);
    // 0.39 m spacing: even 1 m craters are past the fade
    expect(craterLodWeight(args.craterMinRadius, 400 / 1024)).toBe(1);
    const { positions } = build(args);
    const sampler = createHeightSampler(args);
    // Every 7th vertex keeps the test fast while covering the whole chunk
    for (let i = 0; i < positions.length; i += 21) {
      const sampled = sampler.heightAt(args.posX + positions[i], args.posZ + positions[i + 2]);
      expect(positions[i + 1]).toBe(Math.fround(sampled));
    }
  });

  it('computes the same normals as three.js on the skirted plane', () => {
    const args = { ...chunkArgs(1, 1, 64), craterMinRadius: 16 };
    const craters = cratersFor(args);
    const { positions, normals } = buildChunkMesh(args, craters);

    // Reference: displaced PlaneGeometry with a one-vertex skirt
    const { extendedResolution, extendedWidth, extendedDepth } = computeSkirtedGridDimensions(
      args.width,
      args.depth,
      args.resolution
    );
    const geometry = new PlaneGeometry(
      extendedWidth,
      extendedDepth,
      extendedResolution,
      extendedResolution
    );
    geometry.rotateX(-Math.PI / 2);
    const evaluate = createTerrainEvaluator(args);
    const strength = terrainDisplacementStrength(args.smoothLowerPlanes);
    const reference = geometry.attributes.position;
    for (let i = 0; i < reference.count; i++) {
      const x = reference.getX(i);
      const z = reference.getZ(i);
      reference.setY(
        i,
        evaluate(x, z) * strength + getCraterHeightModAt(x + args.posX, z + args.posZ, craters)
      );
    }
    geometry.computeVertexNormals();
    const referenceNormals = geometry.attributes.normal;

    const side = args.resolution + 1;
    const extendedSide = extendedResolution + 1;
    let tilted = 0;
    for (let row = 0; row < side; row++) {
      for (let col = 0; col < side; col++) {
        const offset = (row * side + col) * 3;
        const source = (row + 1) * extendedSide + (col + 1);
        expect(positions[offset + 1]).toBeCloseTo(reference.getY(source), 4);
        expect(normals[offset]).toBeCloseTo(referenceNormals.getX(source), 4);
        expect(normals[offset + 1]).toBeCloseTo(referenceNormals.getY(source), 4);
        expect(normals[offset + 2]).toBeCloseTo(referenceNormals.getZ(source), 4);
        expect(Math.hypot(normals[offset], normals[offset + 1], normals[offset + 2])).toBeCloseTo(
          1,
          5
        );
        if (normals[offset + 1] < 0.99) tilted++;
      }
    }
    expect(tilted).toBeGreaterThan(50);
    geometry.dispose();
  });

  it('agrees with its neighbors on shared edges: identical heights, matching normals', () => {
    for (const resolution of [32, 128]) {
      const here = build(chunkArgs(0, 0, resolution));
      const east = build(chunkArgs(1, 0, resolution));
      const south = build(chunkArgs(0, 1, resolution));
      const side = resolution + 1;

      for (let k = 0; k < side; k++) {
        // East edge of `here` (last column) = west edge of `east` (first column)
        const hereEast = (k * side + resolution) * 3;
        const eastWest = k * side * 3;
        expect(east.positions[eastWest + 1]).toBe(here.positions[hereEast + 1]);
        // South edge of `here` (last row) = north edge of `south` (first row)
        const hereSouth = (resolution * side + k) * 3;
        const southNorth = k * 3;
        expect(south.positions[southNorth + 1]).toBe(here.positions[hereSouth + 1]);

        for (let axis = 0; axis < 3; axis++) {
          expect(east.normals[eastWest + axis]).toBeCloseTo(here.normals[hereEast + axis], 4);
          expect(south.normals[southNorth + axis]).toBeCloseTo(here.normals[hereSouth + axis], 4);
        }
      }
    }
  });

  it('leaves craters that are too small for the vertex spacing out of coarse LODs', () => {
    // 16 segments = 25 m spacing: nothing below 31 m radius is drawn
    const args = { ...chunkArgs(0, 0, 16), craterMaxRadius: LOD_FADE_START * 25 };
    expect(cratersFor(args).length).toBeGreaterThan(500);
    const cratered = build(args);
    const bare = buildChunkMesh(args, []);
    expect(Array.from(cratered.positions)).toEqual(Array.from(bare.positions));
    expect(Array.from(cratered.normals)).toEqual(Array.from(bare.normals));

    // ...while the fine LOD of the same chunk shows them
    const fineArgs = { ...args, resolution: 256 };
    const fine = build(fineArgs);
    const fineBare = buildChunkMesh(fineArgs, []);
    let maxDifference = 0;
    for (let i = 1; i < fine.positions.length; i += 3) {
      maxDifference = Math.max(maxDifference, Math.abs(fine.positions[i] - fineBare.positions[i]));
    }
    expect(maxDifference).toBeGreaterThan(1);
  });

  it('hangs a skirt from the perimeter without changing the grid', () => {
    const args = chunkArgs(1, -2, 16);
    const craters = generateCratersForRegion('1,-2', 400, 400, craterParamsFromTerrainArgs(args), 25);
    const plain = buildChunkMesh(args, craters);
    const skirted = buildChunkMesh(args, craters, 12);

    const gridValues = 17 * 17 * 3;
    expect(plain.positions.length).toBe(gridValues);
    expect(skirted.positions.length).toBe(gridValues + skirtVertexCount(16) * 3);
    expect(skirted.normals.length).toBe(skirted.positions.length);
    expect(Array.from(skirted.positions.subarray(0, gridValues))).toEqual(
      Array.from(plain.positions)
    );
    expect(Array.from(skirted.normals.subarray(0, gridValues))).toEqual(Array.from(plain.normals));
    // First skirt vertex hangs below grid vertex 0
    expect(skirted.positions[gridValues]).toBe(plain.positions[0]);
    expect(skirted.positions[gridValues + 1]).toBeCloseTo(plain.positions[1] - 12, 4);
    expect(skirted.positions[gridValues + 2]).toBe(plain.positions[2]);
  });

  it('is deterministic', () => {
    const a = build(chunkArgs(5, 5, 32));
    const b = build(chunkArgs(5, 5, 32));
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.normals)).toEqual(Array.from(b.normals));
  });

  it('returns up-facing normals for perfectly flat terrain', () => {
    const args = {
      ...chunkArgs(0, 0, 8),
      amplitude: 0,
      rollingAmplitude: 0,
      massifHeight: 0,
      craterDensity: 0,
    };
    const { positions, normals } = build(args);
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i + 1]).toBeCloseTo(0.28, 6);
      expect(normals[i]).toBe(0);
      expect(normals[i + 1]).toBe(1);
      expect(normals[i + 2]).toBe(0);
    }
  });
});
