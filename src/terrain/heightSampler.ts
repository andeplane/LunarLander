/**
 * Shared, synchronous, main-thread terrain height sampler (ADR-0004).
 *
 * Reproduces EXACTLY the height pipeline the chunk worker uses to build
 * terrain meshes (see ChunkWorker.ts: setupHeightSampler / setupCraterCache /
 * sampleHeightFromVertices):
 *
 *   height = createTerrainEvaluator(args)(localX, localZ)
 *              * terrainDisplacementStrength(smoothLowerPlanes)
 *          + getCraterHeightModAt(worldX, worldZ, cratersForRegion)
 *
 * honoring the same coordinate split the worker uses: the terrain evaluator
 * takes CHUNK-LOCAL x/z (with posX/posZ world offsets baked into its args),
 * while craters are evaluated in WORLD coordinates.
 *
 * This lets a landing-pad search query terrain heights deterministically on
 * terrain that has never been built into a mesh.
 */

import {
  type Crater,
  type CraterParams,
  generateCratersForRegion,
  getCraterHeightModAt,
} from './craters';
import { createGridKey } from './LodUtils';
import { createTerrainEvaluator, type TerrainArgs, terrainDisplacementStrength } from './terrain';

/**
 * Configuration for the height sampler.
 *
 * This is exactly the shape of ChunkManager's `baseTerrainArgs`
 * (`Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'>`): the per-chunk fields
 * (resolution, posX, posZ) are derived internally per sampled position, and
 * everything else — noise parameters, chunk dimensions, and the flattened
 * crater parameters — is shared verbatim with the worker requests, so the
 * sampler can never drift from the meshes the worker builds.
 */
export interface HeightSamplerConfig extends Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'> {}

export interface TerrainHeightSampler {
  /** Height of the terrain surface (base + craters) at a world position. */
  heightAt(worldX: number, worldZ: number): number;
  /**
   * Slope in degrees at a world position, sampled at the given baseline
   * (default 1.5 m) via central differences: heights are read at
   * ±baselineM/2 along each axis, so the two samples per axis span exactly
   * one baseline.
   */
  slopeAt(worldX: number, worldZ: number, baselineM?: number): number;
}

const DEFAULT_SLOPE_BASELINE_M = 1.5;
const RAD_TO_DEG = 180 / Math.PI;

/** Per-chunk cache entry: the worker builds these once per chunk message. */
interface ChunkSampleCache {
  /** Terrain evaluator with this chunk's posX/posZ baked in (local x/z in). */
  evaluator: (x: number, z: number) => number;
  /** Craters affecting this chunk (world coordinates), 3x3 neighbor scan. */
  craters: Crater[];
  /** World-space X offset of the chunk origin (gridX * chunkWidth). */
  originX: number;
  /** World-space Z offset of the chunk origin (gridZ * chunkDepth). */
  originZ: number;
}

/**
 * Create a deterministic terrain height sampler.
 *
 * Same config + coordinates always yield identical results, across calls and
 * across instances. Per-chunk state (terrain evaluator, crater region) is
 * cached in a Map keyed by gridKey, with a last-chunk fast path so repeated
 * samples in one area avoid both crater regeneration and Map lookups.
 */
export function createHeightSampler(config: HeightSamplerConfig): TerrainHeightSampler {
  const chunkWidth = config.width;
  const chunkDepth = config.depth;

  // Same strength multiplier as displaceY() applies in generateTerrain
  // (see sampleHeightFromVertices in ChunkWorker.ts)
  const strength = terrainDisplacementStrength(config.smoothLowerPlanes);

  // Identical CraterParams construction to handleChunkMessage in ChunkWorker.ts
  const craterParams: CraterParams = {
    seed: config.craterSeed,
    density: config.craterDensity,
    minRadius: config.craterMinRadius,
    maxRadius: config.craterMaxRadius,
    powerLawExponent: config.craterPowerLawExponent,
    depthRatio: config.craterDepthRatio,
    rimHeight: config.craterRimHeight,
    rimWidth: config.craterRimWidth,
    floorFlatness: config.craterFloorFlatness,
  };

  const chunkCache = new Map<string, ChunkSampleCache>();

  // Last-chunk fast path: consecutive samples overwhelmingly hit one chunk,
  // so skip the grid-key string build and Map lookup for them.
  let lastGridX = Number.NaN;
  let lastGridZ = Number.NaN;
  let lastChunk: ChunkSampleCache | undefined;

  function chunkAt(worldX: number, worldZ: number): ChunkSampleCache {
    // Chunks are centered at (gridX * chunkWidth, gridZ * chunkDepth) and
    // span ±half a chunk (see getChunkWorldCenter in LodUtils.ts), so the
    // containing grid cell is the nearest integer multiple.
    const gridX = Math.round(worldX / chunkWidth);
    const gridZ = Math.round(worldZ / chunkDepth);

    if (gridX === lastGridX && gridZ === lastGridZ && lastChunk !== undefined) {
      return lastChunk;
    }

    const gridKey = createGridKey(gridX, gridZ);
    let entry = chunkCache.get(gridKey);
    if (entry === undefined) {
      const posX = gridX * chunkWidth;
      const posZ = gridZ * chunkDepth;
      entry = {
        // resolution is unused by createTerrainEvaluator (it only reads the
        // noise parameters and posX/posZ), but TerrainArgs requires it
        evaluator: createTerrainEvaluator({
          ...config,
          resolution: 1,
          posX,
          posZ,
        }),
        // Same 3x3 neighbor-aware crater region the worker caches per chunk
        craters: generateCratersForRegion(gridKey, chunkWidth, chunkDepth, craterParams),
        originX: posX,
        originZ: posZ,
      };
      chunkCache.set(gridKey, entry);
    }

    lastGridX = gridX;
    lastGridZ = gridZ;
    lastChunk = entry;
    return entry;
  }

  function heightAt(worldX: number, worldZ: number): number {
    const chunk = chunkAt(worldX, worldZ);

    // Terrain evaluator takes chunk-local coordinates (posX/posZ are baked
    // into its args), exactly like sampleHeightFromVertices in the worker
    const baseHeight = chunk.evaluator(worldX - chunk.originX, worldZ - chunk.originZ) * strength;

    // Craters take world coordinates
    return baseHeight + getCraterHeightModAt(worldX, worldZ, chunk.craters);
  }

  function slopeAt(
    worldX: number,
    worldZ: number,
    baselineM: number = DEFAULT_SLOPE_BASELINE_M
  ): number {
    const half = baselineM / 2;
    const gradX = (heightAt(worldX + half, worldZ) - heightAt(worldX - half, worldZ)) / baselineM;
    const gradZ = (heightAt(worldX, worldZ + half) - heightAt(worldX, worldZ - half)) / baselineM;
    return Math.atan(Math.hypot(gradX, gradZ)) * RAD_TO_DEG;
  }

  return { heightAt, slopeAt };
}
