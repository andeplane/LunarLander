/**
 * Deterministic rock lookup for the pad search (ADR-0004 §1): enumerates the
 * rock population of the chunks overlapping the search area on the main
 * thread and returns world-space positions + diameters.
 *
 * Uses the same enumeration (forEachRock) the chunk worker places rocks
 * with, so the result is exactly the LOD 0 population, without sampling any
 * terrain height. A rendered rock sits within its own burial depth times the
 * terrain slope of the position reported here (centimeters).
 */

import { forEachRock } from '../terrain/rockPlacement';
import type { TerrainArgs } from '../terrain/terrain';
import type { RockGenerationConfig } from '../types';
import type { RockNearby } from './padSearch';

/**
 * All rocks whose chunks overlap the given world-space bounds.
 *
 * @param baseArgs ChunkManager.getBaseTerrainArgs()
 * @param rockConfig the same RockGenerationConfig main.ts feeds ChunkManager
 * @param _rockLibrarySize prototype count (unused: the population does not depend on the shapes)
 */
export function rocksInArea(
  baseArgs: Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'>,
  rockConfig: RockGenerationConfig,
  _rockLibrarySize: number,
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
      const posX = gx * width;
      const posZ = gz * depth;
      forEachRock(
        { seed: baseArgs.seed, width, depth, posX, posZ },
        rockConfig,
        (x, z, diameter) => {
          rocks.push({ x: x + posX, z: z + posZ, diameter });
        }
      );
    }
  }
  return rocks;
}
