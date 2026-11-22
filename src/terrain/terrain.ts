import alea from 'alea';
import { createNoise2D } from 'simplex-noise';
import { PlaneGeometry } from 'three';
import { displaceY } from './displacements';
import { FbmNoiseBuilder } from './noise';

export type TerrainArgs = {
  // Noise parameters
  seed: number;
  gain: number;
  lacunarity: number;
  frequency: number;
  amplitude: number;
  altitude: number;
  octaves: number;
  smoothLowerPlanes: number; // Displacement strength control (0 = full strength; see terrainDisplacementStrength)

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
  craterDensity: number; // Craters per km² with radius >= 1 m
  craterMinRadius: number; // Minimum crater radius in meters
  craterMaxRadius: number; // Maximum crater radius in meters
  craterPowerLawExponent: number; // Size-frequency distribution exponent
  craterDepthRatio: number; // Depth / diameter of a perfectly fresh crater
  craterRimHeight: number; // Rim height / diameter of a perfectly fresh crater
  craterRimWidth: number; // Ejecta extent beyond the rim, in crater radii
  craterFloorFlatness: number; // Extra floor flattening: 0 = bowl (large craters still flatten), 1 = flat floor
  /** Depth/diameter of the most degraded craters (default 0.04) */
  craterDegradedDepthRatio?: number;
  /** Age skew: freshness = u^exponent, higher = more degraded craters (default 3) */
  craterFreshnessExponent?: number;
  /** Radius above which the size-frequency slope steepens (default none) */
  craterBreakRadius?: number;
  /** Cumulative size-frequency exponent above the break (default -3.2) */
  craterSteepExponent?: number;

  // Large-scale relief (all optional; see RELIEF_DEFAULTS). Heights are in
  // evaluator units, i.e. BEFORE the terrainDisplacementStrength multiplier.
  /** Peak amplitude of the mid-scale rolling relief (150-400 m wavelengths); 0 disables */
  rollingAmplitude?: number;
  /** Height of the tallest massifs (1.2-2.5 km wavelengths); 0 disables */
  massifHeight?: number;
  /** Radius around the world origin kept free of massifs (spawn area), in meters */
  spawnFlatRadius?: number;
};

/**
 * Defaults for the optional relief fields of TerrainArgs (evaluator units:
 * multiply by terrainDisplacementStrength, 2.8 by default, for meters).
 */
export const RELIEF_DEFAULTS = {
  /** x2.8 = rolling relief of roughly +-8 m */
  rollingAmplitude: 3.0,
  /** x2.8 = massifs up to ~140 m tall */
  massifHeight: 50,
  spawnFlatRadius: 300,
} as const;

/** Spacing (m) of the world-aligned lattice the relief is interpolated on. */
export const RELIEF_LATTICE_SPACING = 25;

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
 * Dimensions of the extended (skirted) chunk grid used for normal computation.
 * The mesh is generated with a one-vertex skirt on each edge so edge vertices
 * have full face neighborhoods, then the skirt is stripped.
 */
export interface SkirtedGridDimensions {
  /** Segments per axis including the skirt (+1 vertex per edge) */
  extendedResolution: number;
  extendedWidth: number;
  extendedDepth: number;
}

/**
 * Compute the extended grid dimensions for a one-vertex skirt on each edge.
 *
 * Vertex spacing is derived per axis (width/resolution and depth/resolution
 * independently) so the interior vertices of the extended grid land exactly on
 * the base grid even for non-square chunks — deriving both extensions from the
 * width alone would shift every interior vertex whenever width != depth.
 */
export function computeSkirtedGridDimensions(
  width: number,
  depth: number,
  resolution: number
): SkirtedGridDimensions {
  const extendedResolution = resolution + 2; // +2 segments = +1 vertex per edge
  const vertexSpacingX = width / resolution;
  const vertexSpacingZ = depth / resolution;
  return {
    extendedResolution,
    extendedWidth: width + 2 * vertexSpacingX,
    extendedDepth: depth + 2 * vertexSpacingZ,
  };
}

function smoothstep01(t: number): number {
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Resolved relief parameters (TerrainArgs optionals with defaults applied). */
export interface ReliefParams {
  seed: number;
  rollingAmplitude: number;
  massifHeight: number;
  spawnFlatRadius: number;
}

export function reliefParamsFromTerrainArgs(
  args: Pick<TerrainArgs, 'seed' | 'rollingAmplitude' | 'massifHeight' | 'spawnFlatRadius'>
): ReliefParams {
  return {
    seed: args.seed,
    rollingAmplitude: args.rollingAmplitude ?? RELIEF_DEFAULTS.rollingAmplitude,
    massifHeight: args.massifHeight ?? RELIEF_DEFAULTS.massifHeight,
    spawnFlatRadius: args.spawnFlatRadius ?? RELIEF_DEFAULTS.spawnFlatRadius,
  };
}

// Relief shape constants. "Wavelength" follows the convention used for the
// fine FBM (1 / simplex frequency).
const ROLLING_WAVELENGTH_1 = 400;
const ROLLING_WAVELENGTH_2 = 190;
const ROLLING_WEIGHT_1 = 0.7;
const ROLLING_WEIGHT_2 = 0.3;
const MASSIF_WAVELENGTH_1 = 2400;
const MASSIF_WAVELENGTH_2 = 1000;
const MASSIF_WEIGHT_1 = 0.88;
const MASSIF_WEIGHT_2 = 0.12;
/** Noise level where massifs start to rise: everything below stays plains. */
const MASSIF_THRESHOLD = 0.3;
/** Noise level at which a massif reaches its full height. */
const MASSIF_FULL = 0.9;

/**
 * Large-scale relief at a world position, evaluated directly from noise
 * (evaluator units). This is the SOURCE that createReliefField samples on a
 * coarse world lattice; terrain heights use the interpolated field, never
 * this function directly.
 *
 * Two layers:
 * - rolling: two octaves of gentle mid-scale undulation
 * - massifs: low-frequency noise pushed through a threshold + smoothstep, so
 *   most of the area stays plains and smooth rounded hills rise in some
 *   regions. Massifs fade out completely around the world origin (spawn).
 */
export function createReliefSource(
  params: ReliefParams
): (worldX: number, worldZ: number) => number {
  const { rollingAmplitude, massifHeight, spawnFlatRadius } = params;
  const rolling1 = createNoise2D(alea(params.seed + 101));
  const rolling2 = createNoise2D(alea(params.seed + 102));
  const massif1 = createNoise2D(alea(params.seed + 103));
  const massif2 = createNoise2D(alea(params.seed + 104));
  // Massifs are fully suppressed inside spawnFlatRadius and fully present
  // 3 radii out; rolling relief is only partly reduced near spawn.
  const massifFadeSpan = Math.max(2 * spawnFlatRadius, 1);
  const rollingFadeStart = 0.5 * spawnFlatRadius;
  const rollingFadeSpan = Math.max(1.5 * spawnFlatRadius, 1);

  return (worldX: number, worldZ: number): number => {
    const distance = Math.hypot(worldX, worldZ);
    let relief = 0;

    if (rollingAmplitude !== 0) {
      const mask = 0.35 + 0.65 * smoothstep01((distance - rollingFadeStart) / rollingFadeSpan);
      relief +=
        rollingAmplitude *
        mask *
        (ROLLING_WEIGHT_1 * rolling1(worldX / ROLLING_WAVELENGTH_1, worldZ / ROLLING_WAVELENGTH_1) +
          ROLLING_WEIGHT_2 *
            rolling2(worldX / ROLLING_WAVELENGTH_2, worldZ / ROLLING_WAVELENGTH_2));
    }

    if (massifHeight !== 0) {
      const mask = smoothstep01((distance - spawnFlatRadius) / massifFadeSpan);
      if (mask > 0) {
        const m =
          MASSIF_WEIGHT_1 * massif1(worldX / MASSIF_WAVELENGTH_1, worldZ / MASSIF_WAVELENGTH_1) +
          MASSIF_WEIGHT_2 * massif2(worldX / MASSIF_WAVELENGTH_2, worldZ / MASSIF_WAVELENGTH_2);
        relief +=
          massifHeight *
          mask *
          smoothstep01((m - MASSIF_THRESHOLD) / (MASSIF_FULL - MASSIF_THRESHOLD));
      }
    }

    return relief;
  };
}

/** World-space rectangle whose lattice nodes a relief field precomputes. */
export interface ReliefBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Catmull-Rom spline through p1..p2 (C1 across segments). */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return (
    p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
  );
}

/**
 * Relief field: bicubic (Catmull-Rom) interpolation of `source` sampled on a
 * world-aligned lattice.
 *
 * The relief only contains wavelengths of 150 m and up, so evaluating four
 * simplex octaves for each of the million vertices of an LOD0 chunk would be
 * wasted work. Instead the interpolant itself is the DEFINITION of the
 * relief: lattice nodes sit at integer multiples of `spacing` in world space
 * and the cell is picked from the world coordinate, so every chunk, the
 * worker's point sampler and the main-thread height sampler all run the same
 * arithmetic on the same node values and agree bit for bit.
 *
 * Nodes inside `bounds` (plus the 2-node spline support) are precomputed;
 * queries outside fall back to evaluating the source at the nodes they need.
 */
export function createReliefField(
  source: (worldX: number, worldZ: number) => number,
  bounds: ReliefBounds,
  spacing: number = RELIEF_LATTICE_SPACING
): (worldX: number, worldZ: number) => number {
  const i0 = Math.floor(bounds.minX / spacing) - 1;
  const j0 = Math.floor(bounds.minZ / spacing) - 1;
  const ni = Math.floor(bounds.maxX / spacing) + 2 - i0 + 1;
  const nj = Math.floor(bounds.maxZ / spacing) + 2 - j0 + 1;
  const nodes = new Float64Array(ni * nj);
  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      nodes[j * ni + i] = source((i0 + i) * spacing, (j0 + j) * spacing);
    }
  }

  // Scratch for the out-of-patch fallback (16 spline support nodes)
  const support = new Float64Array(16);

  return (worldX: number, worldZ: number): number => {
    const fx = worldX / spacing;
    const fz = worldZ / spacing;
    const cellX = Math.floor(fx);
    const cellZ = Math.floor(fz);
    const tx = fx - cellX;
    const tz = fz - cellZ;
    const li = cellX - 1 - i0;
    const lj = cellZ - 1 - j0;

    if (li >= 0 && lj >= 0 && li + 3 < ni && lj + 3 < nj) {
      const r0 = lj * ni + li;
      const r1 = r0 + ni;
      const r2 = r1 + ni;
      const r3 = r2 + ni;
      return catmullRom(
        catmullRom(nodes[r0], nodes[r0 + 1], nodes[r0 + 2], nodes[r0 + 3], tx),
        catmullRom(nodes[r1], nodes[r1 + 1], nodes[r1 + 2], nodes[r1 + 3], tx),
        catmullRom(nodes[r2], nodes[r2 + 1], nodes[r2 + 2], nodes[r2 + 3], tx),
        catmullRom(nodes[r3], nodes[r3 + 1], nodes[r3 + 2], nodes[r3 + 3], tx),
        tz
      );
    }

    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        support[j * 4 + i] = source((cellX - 1 + i) * spacing, (cellZ - 1 + j) * spacing);
      }
    }
    return catmullRom(
      catmullRom(support[0], support[1], support[2], support[3], tx),
      catmullRom(support[4], support[5], support[6], support[7], tx),
      catmullRom(support[8], support[9], support[10], support[11], tx),
      catmullRom(support[12], support[13], support[14], support[15], tx),
      tz
    );
  };
}

/**
 * Creates a terrain height evaluation function that can be used for both
 * full mesh generation and single-point sampling.
 *
 * height = fine FBM undulation + altitude + large-scale relief (rolling
 * ground + massifs, see createReliefField). The result is in evaluator units;
 * callers multiply by terrainDisplacementStrength.
 *
 * @param args Terrain generation arguments
 * @returns Function that takes (x, z) in local chunk space and returns the height
 */
export function createTerrainEvaluator(args: TerrainArgs): (x: number, z: number) => number {
  const fbm = createFineNoise(args);

  const { posX, posZ, altitude } = args;
  const reliefParams = reliefParamsFromTerrainArgs(args);

  if (reliefParams.rollingAmplitude === 0 && reliefParams.massifHeight === 0) {
    // posX/posZ are world-space chunk offsets
    return (x: number, z: number) => fbm(x + posX, z + posZ) + altitude;
  }

  const relief = createReliefField(createReliefSource(reliefParams), {
    minX: posX - args.width / 2,
    maxX: posX + args.width / 2,
    minZ: posZ - args.depth / 2,
    maxZ: posZ + args.depth / 2,
  });

  return (x: number, z: number) => {
    const worldX = x + posX;
    const worldZ = z + posZ;
    return fbm(worldX, worldZ) + altitude + relief(worldX, worldZ);
  };
}

/** Arguments of the terrain height function that do not depend on a chunk. */
export type TerrainFieldArgs = Omit<TerrainArgs, 'resolution' | 'posX' | 'posZ'>;

/** Fine terrain noise - gentle undulating lunar surface. */
function createFineNoise(args: TerrainFieldArgs): (x: number, z: number) => number {
  return new FbmNoiseBuilder()
    .octaves(args.octaves)
    .lacunarity(args.lacunarity)
    .gain(args.gain)
    .seed(args.seed)
    .offset(0)
    .amplitude(args.amplitude)
    .frequency(args.frequency)
    .build();
}

/**
 * Terrain height (evaluator units, before craters) at world positions that
 * are integer multiples of RELIEF_LATTICE_SPACING on both axes.
 *
 * The relief interpolant passes through its lattice nodes, so there it equals
 * its source and no node patch has to be precomputed. That makes sparse
 * sampling over tens of kilometres cheap (distant terrain) while agreeing
 * with createTerrainEvaluator at those points. Other positions are not valid.
 */
export function createLatticeTerrainEvaluator(
  args: TerrainFieldArgs
): (worldX: number, worldZ: number) => number {
  const fbm = createFineNoise(args);
  const { altitude } = args;
  const reliefParams = reliefParamsFromTerrainArgs(args);
  if (reliefParams.rollingAmplitude === 0 && reliefParams.massifHeight === 0) {
    return (worldX: number, worldZ: number) => fbm(worldX, worldZ) + altitude;
  }
  const source = createReliefSource(reliefParams);
  return (worldX: number, worldZ: number) =>
    fbm(worldX, worldZ) + altitude + source(worldX, worldZ);
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
  const geometry = new PlaneGeometry(args.width, args.depth, args.resolution, args.resolution);
  geometry.rotateX(-Math.PI / 2);

  const evaluateTerrain = createTerrainEvaluator(args);

  displaceY(
    geometry,
    evaluateTerrain,
    terrainDisplacementStrength(args.smoothLowerPlanes),
    computeNormals
  );

  return geometry;
}
