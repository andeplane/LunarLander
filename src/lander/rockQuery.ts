/**
 * Deterministic rock lookup for the pad search (ADR-0004 §1): re-runs the
 * chunk worker's rock placement math on the main thread for the chunks
 * overlapping the search area and returns world-space positions + diameters.
 *
 * Approximation note: the worker seeds its unified height sampler with the
 * chunk's craters before placing rocks; standalone calls run without that
 * crater cache, so rocks that sit near craters can land a few meters from
 * their rendered spot (findFlatterPosition sees slightly different slopes).
 * The pad search adds the rock's own radius as clearance and rejects
 * cratered discs anyway, so this inaccuracy is harmless for exclusion.
 */
import type { TerrainArgs } from '../terrain/terrain';
import { generateRockPlacements } from '../terrain/ChunkWorker';
import { createGridKey } from '../terrain/LodUtils';
import type { RockGenerationConfig } from '../types';
import type { RockNearby } from './padSearch';

const EMPTY_POSITIONS: number[] = [];

/**
 * All rocks whose chunks overlap the given world-space bounds.
 *
 * @param baseArgs ChunkManager.getBaseTerrainArgs()
 * @param rockConfig the same RockGenerationConfig main.ts feeds ChunkManager
 * @param rockLibrarySize prototype count (RockManager's constructor arg)
 */
export function rocksInArea(
  baseArgs: Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'>,
  rockConfig: RockGenerationConfig,
  rockLibrarySize: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number
): RockNearby[] {
  const width = baseArgs.width;
  const depth = baseArgs.depth;
  const rocks: RockNearby[] = [];

  const minGridX = Math.round(minX / width - 0.5);
  const maxGridX = Math.round(maxX / width + 0.5);
  const minGridZ = Math.round(minZ / depth - 0.5);
  const maxGridZ = Math.round(maxZ / depth + 0.5);

  for (let gx = minGridX; gx <= maxGridX; gx++) {
    for (let gz = minGridZ; gz <= maxGridZ; gz++) {
      const args: TerrainArgs = {
        ...baseArgs,
        resolution: 64, // ignored by analytic height sampling
        posX: gx * width,
        posZ: gz * depth,
      };
      const placements = generateRockPlacements(
        EMPTY_POSITIONS,
        args,
        0, // finest LOD = full rock population
        createGridKey(gx, gz),
        rockLibrarySize,
        rockConfig
      );
      for (const placement of placements) {
        const m = placement.matrices;
        for (let i = 0; i < m.length; i += 16) {
          // Column-major 4x4: translation at 12/13/14; uniform scale =
          // length of the first column = the rock diameter
          const diameter = Math.hypot(m[i], m[i + 1], m[i + 2]);
          rocks.push({
            x: m[i + 12] + args.posX,
            z: m[i + 14] + args.posZ,
            diameter,
          });
        }
      }
    }
  }
  return rocks;
}
