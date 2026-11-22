import { describe, expect, it } from 'vitest';
import { generateRockPlacements } from '../terrain/ChunkWorker';
import { createGridKey } from '../terrain/LodUtils';
import type { TerrainArgs } from '../terrain/terrain';
import type { RockGenerationConfig } from '../types';
import { rocksInArea } from './rockQuery';

const baseArgs: Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'> = {
  seed: 42,
  gain: 0.5,
  lacunarity: 2.0,
  frequency: 0.01,
  amplitude: 2,
  altitude: 0,
  octaves: 4,
  smoothLowerPlanes: 0,
  width: 400,
  depth: 400,
  renderDistance: 5,
  craterSeed: 42,
  craterDensity: 0,
  craterMinRadius: 5,
  craterMaxRadius: 50,
  craterPowerLawExponent: -2.4,
  craterDepthRatio: 0.2,
  craterRimHeight: 0.3,
  craterRimWidth: 0.4,
  craterFloorFlatness: 0.5,
};

const rockConfig: RockGenerationConfig = {
  minDiameter: 0.33,
  maxDiameter: 12,
  densityConstant: 0.00048,
  powerLawExponent: -2.1,
  lodMinDiameterScale: [1, 1.5, 2.5, 4.5, 9, 18, 40],
};

const LIBRARY_SIZE = 30;

/** World-space positions and footprint scales of the rocks the worker renders in a chunk at LOD 0. */
function renderedRocks(gridX: number, gridZ: number): { x: number; z: number; scaleX: number }[] {
  const args: TerrainArgs = { ...baseArgs, resolution: 64, posX: gridX * 400, posZ: gridZ * 400 };
  const rendered: { x: number; z: number; scaleX: number }[] = [];
  for (const { matrices } of generateRockPlacements(
    [],
    args,
    0,
    createGridKey(gridX, gridZ),
    LIBRARY_SIZE,
    rockConfig
  )) {
    for (let i = 0; i < matrices.length; i += 16) {
      rendered.push({
        x: matrices[i + 12] + args.posX,
        z: matrices[i + 14] + args.posZ,
        scaleX: Math.hypot(matrices[i], matrices[i + 1], matrices[i + 2]),
      });
    }
  }
  return rendered;
}

describe(rocksInArea.name, () => {
  it('returns exactly the rocks the chunk worker renders, at the same places and sizes', () => {
    // Bounds inside chunk (2, -1): the query covers its 3x3 neighbourhood
    const rocks = rocksInArea(baseArgs, rockConfig, LIBRARY_SIZE, 790, 810, -410, -390);
    const rendered: { x: number; z: number; scaleX: number }[] = [];
    for (let gx = 1; gx <= 3; gx++) {
      for (let gz = -2; gz <= 0; gz++) {
        rendered.push(...renderedRocks(gx, gz));
      }
    }
    expect(rocks.length).toBe(rendered.length);
    expect(rocks.length).toBeGreaterThan(2000);

    const cells = new Map<string, { x: number; z: number; diameter: number }[]>();
    for (const rock of rocks) {
      const key = `${Math.floor(rock.x / 4)},${Math.floor(rock.z / 4)}`;
      const cell = cells.get(key) ?? [];
      cell.push(rock);
      cells.set(key, cell);
    }
    for (const { x, z, scaleX } of rendered) {
      let best = Infinity;
      let bestDiameter = 0;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const rock of cells.get(`${Math.floor(x / 4) + dx},${Math.floor(z / 4) + dz}`) ??
            []) {
            const distance = Math.hypot(rock.x - x, rock.z - z);
            if (distance < best) {
              best = distance;
              bestDiameter = rock.diameter;
            }
          }
        }
      }
      // The rendered origin is offset only by the rock's burial along its tilted axis
      expect(best).toBeLessThan(0.5 * bestDiameter);
      // The rendered footprint is the diameter with ±12 % shape variation
      expect(scaleX / bestDiameter).toBeGreaterThan(0.87);
      expect(scaleX / bestDiameter).toBeLessThan(1.13);
    }
  });

  it('is deterministic and does not depend on the library size', () => {
    const first = rocksInArea(baseArgs, rockConfig, LIBRARY_SIZE, -50, 50, -50, 50);
    expect(rocksInArea(baseArgs, rockConfig, LIBRARY_SIZE, -50, 50, -50, 50)).toEqual(first);
    expect(rocksInArea(baseArgs, rockConfig, 3, -50, 50, -50, 50)).toEqual(first);
  });

  it('covers every chunk overlapping the bounds', () => {
    const rocks = rocksInArea(baseArgs, rockConfig, LIBRARY_SIZE, -900, 900, -100, 100);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const rock of rocks) {
      minX = Math.min(minX, rock.x);
      maxX = Math.max(maxX, rock.x);
      minZ = Math.min(minZ, rock.z);
      maxZ = Math.max(maxZ, rock.z);
      expect(rock.diameter).toBeGreaterThanOrEqual(rockConfig.minDiameter);
      expect(rock.diameter).toBeLessThanOrEqual(rockConfig.maxDiameter);
    }
    expect(minX).toBeLessThan(-900);
    expect(maxX).toBeGreaterThan(900);
    expect(minZ).toBeLessThan(-100);
    expect(maxZ).toBeGreaterThan(100);
    // Chunks are centered on multiples of their size: 7 x 3 chunks here
    expect(minX).toBeGreaterThanOrEqual(-1400);
    expect(maxX).toBeLessThanOrEqual(1400);
    expect(minZ).toBeGreaterThanOrEqual(-600);
    expect(maxZ).toBeLessThanOrEqual(600);
  });

  it('follows the terrain seed', () => {
    const other = rocksInArea({ ...baseArgs, seed: 7 }, rockConfig, LIBRARY_SIZE, -50, 50, -50, 50);
    expect(other).not.toEqual(rocksInArea(baseArgs, rockConfig, LIBRARY_SIZE, -50, 50, -50, 50));
  });
});
