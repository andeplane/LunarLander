import { FbmNoiseBuilder } from "./noise";
import { displaceY } from "./displacements";
import { PlaneGeometry } from "three";

export type TerrainArgs = {
  // Noise parameters
  seed: number;
  gain: number;
  lacunarity: number;
  frequency: number;
  amplitude: number;
  altitude: number;
  octaves: number;
  smoothLowerPlanes: number;       // Displacement strength control (0 = full strength; see terrainDisplacementStrength)
  
  // Chunk dimensions
  width: number;
  depth: number;
  resolution: number;
  /** World-space X offset of the chunk origin (gridX * chunkWidth) */
  posX: number;
  /** World-space Z offset of the chunk origin (gridZ * chunkDepth) */
  posZ: number;
  renderDistance: number;
  
  // Crater generation parameters
  craterSeed: number;
  craterDensity: number;           // Craters per km² at reference size
  craterMinRadius: number;         // Minimum crater radius in meters
  craterMaxRadius: number;         // Maximum crater radius in meters
  craterPowerLawExponent: number;  // Size-frequency distribution exponent
  craterDepthRatio: number;        // Crater depth = radius * ratio
  craterRimHeight: number;         // Rim height as fraction of depth
  craterRimWidth: number;          // Rim extends beyond radius by this fraction
  craterFloorFlatness: number;     // 0 = parabolic bowl, 1 = flat floor
};

/**
 * Vertical displacement strength applied to the terrain evaluator output.
 *
 * Single source of truth: rock placement in ChunkWorker samples heights with
 * this exact multiplier — if the formula drifts, rocks silently float or sink
 * relative to the terrain mesh.
 */
export function terrainDisplacementStrength(smoothLowerPlanes: number): number {
  return 2.8 * (1 - smoothLowerPlanes * 0.5);
}

/**
 * Creates a terrain height evaluation function that can be used for both
 * full mesh generation and single-point sampling.
 *
 * @param args Terrain generation arguments
 * @returns Function that takes (x, z) in local chunk space and returns the height
 */
export function createTerrainEvaluator(args: TerrainArgs): (x: number, z: number) => number {
  // Primary terrain noise - gentle undulating lunar surface
  const fbm = new FbmNoiseBuilder()
    .octaves(args.octaves)
    .lacunarity(args.lacunarity)
    .gain(args.gain)
    .seed(args.seed)
    .offset(0)
    .amplitude(args.amplitude)
    .frequency(args.frequency)
    .build();

  // Large-scale altitude variation (like lunar maria vs highlands).
  // The 0.75 offset raises the whole field (was previously an implicit
  // builder default); kept explicit to preserve the existing terrain.
  const fbmAltitude = new FbmNoiseBuilder()
    .octaves(2)
    .seed(args.seed + 4)
    .frequency(0.003)
    .amplitude(0.5)
    .offset(0.75)
    .build();

  return (x: number, z: number) => {
    // Sample base terrain noise (posX/posZ are world-space chunk offsets)
    const terrainNoise = fbm(x + args.posX, z + args.posZ);

    // Add large-scale altitude variation
    const altitudeVariation = fbmAltitude(x + args.posX, z + args.posZ) * 0.5;
    
    // Combine: base terrain + altitude + variation
    return terrainNoise + args.altitude + altitudeVariation;
  };
}

/**
 * Generate a displaced terrain plane.
 *
 * @param args Terrain generation arguments
 * @param computeNormals Recompute vertex normals after displacement (default
 *   true). Pass false when heights will be modified again (e.g. craters) and
 *   normals recomputed afterwards, to avoid a wasted normals pass.
 */
export function generateTerrain(args: TerrainArgs, computeNormals: boolean = true) {
  const geometry = new PlaneGeometry(
    args.width,
    args.depth,
    args.resolution,
    args.resolution
  );
  geometry.rotateX(-Math.PI / 2);

  const evaluateTerrain = createTerrainEvaluator(args);

  displaceY(geometry, evaluateTerrain, terrainDisplacementStrength(args.smoothLowerPlanes), computeNormals);

  return geometry;
}
