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
  smoothLowerPlanes: number;       // Height multiplier (0 = full strength)
  
  // Chunk dimensions
  width: number;
  depth: number;
  resolution: number;
  posX: number;
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
 * Creates a terrain height evaluation function that can be used for both
 * full mesh generation and single-point sampling.
 * 
 * @param args Terrain generation arguments
 * @returns Function that takes (x, z) in local chunk space and returns {y: height, biome: [biome, water, 0]}
 */
export function createTerrainEvaluator(args: TerrainArgs): (x: number, z: number) => {y: number; biome: number[]} {
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

  // Large-scale altitude variation (like lunar maria vs highlands)
  const fbmAltitude = new FbmNoiseBuilder()
    .octaves(2)
    .seed(args.seed + 4)
    .frequency(0.003)
    .amplitude(0.5)
    .build();

  return (x: number, z: number) => {
    // Sample base terrain noise
    const terrainNoise = fbm(x + args.posX * 25, z + args.posZ * 25);
    
    // Add large-scale altitude variation
    const altitudeVariation = fbmAltitude(x + args.posX * 25, z + args.posZ * 25) * 0.5;
    
    // Combine: base terrain + altitude + variation
    const height = terrainNoise + args.altitude + altitudeVariation;
    
    // Return height with neutral biome (no water, no special biomes)
    return { y: height, biome: [0.5, 0, 0] };
  };
}

export function generateTerrain(args: TerrainArgs) {
  const geometry = new PlaneGeometry(
    args.width,
    args.depth,
    args.resolution,
    args.resolution
  );
  geometry.rotateX(-Math.PI / 2);

  const evaluateTerrain = createTerrainEvaluator(args);

  displaceY(geometry, evaluateTerrain, 2.8 * (1 - args.smoothLowerPlanes * 0.5));

  return geometry;
}
