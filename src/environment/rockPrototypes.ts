/**
 * Shared, dependency-free description of the rock prototype library.
 *
 * Imported by the chunk worker (placement), the main thread (RockManager,
 * RockBuilder) and gameplay queries, so it must stay free of three.js and
 * of any state: everything here is a pure function of its arguments.
 *
 * Terminology
 * - shape: one procedural rock silhouette, identified by its shape id
 *   (0..librarySize-1). The same shape can be meshed at any detail tier.
 * - size tier: the tier a rock gets from its diameter alone (LOD 0).
 * - mesh tier: the tier actually rendered = size tier dropped by chunk LOD.
 *   Tier 0 is the finest mesh, the last tier the cheapest.
 * - detail ladder: every icosphere detail a prototype is built at. Rocks
 *   close to the camera are redrawn from finer ladder details than their
 *   mesh tier (RockManager.updateNearDetail), chosen by projected size.
 */

/** One mesh detail tier of the prototype library. */
export interface RockTier {
  /** Icosphere subdivision frequency: the mesh has at most 20·(detail+1)² triangles. */
  readonly detail: number;
  /** Rocks at or above this diameter (meters) get this tier at LOD 0. */
  readonly minDiameter: number;
  /**
   * Number of distinct shapes rocks of this size tier use within one chunk.
   * Every (shape, mesh tier) pair in a chunk is one draw call, so this bounds
   * the draw calls of a chunk: the tiers sum to 45.
   */
  readonly maxShapes: number;
  /**
   * Whether chunks pick their `maxShapes` shapes from the whole library
   * (a different window per chunk) instead of always the first ones. Used
   * for the big boulders, which are few, individually recognisable and worth
   * the extra prototypes; the numerous small rocks share one fixed set.
   */
  readonly wholeLibrary: boolean;
}

/** Detail tiers, finest first. */
export const ROCK_TIERS: readonly RockTier[] = [
  { detail: 15, minDiameter: 6, maxShapes: 9, wholeLibrary: true },
  { detail: 7, minDiameter: 3, maxShapes: 10, wholeLibrary: true },
  { detail: 3, minDiameter: 1.2, maxShapes: 10, wholeLibrary: false },
  { detail: 2, minDiameter: 0.6, maxShapes: 8, wholeLibrary: false },
  { detail: 1, minDiameter: 0, maxShapes: 8, wholeLibrary: false },
];

/**
 * Per chunk LOD cap on the number of distinct shapes, so far chunks (a
 * handful of boulders each, but hundreds of chunks) need very few draw
 * calls. LODs beyond the table use its last entry.
 */
export const ROCK_LOD_SHAPE_LIMIT: readonly number[] = [
  Number.POSITIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  6,
  3,
  2,
  1,
];

/**
 * Icosphere details a rock can be meshed at, coarsest first: every
 * ROCK_TIERS detail plus the finer near-camera ("hero") meshes. Each step
 * roughly doubles the triangle count (80 … 46 080).
 */
export const ROCK_DETAIL_LADDER: readonly number[] = [1, 2, 3, 5, 7, 11, 15, 23, 31, 47];

/**
 * Near-camera refinement: a rock is drawn with the finest ladder detail
 * whose (detail + 1) segments across it are each at least this many pixels
 * on screen (CSS pixels of the viewport height), and never coarser than its
 * chunk's mesh tier. At 1080 px and a 70° view a 0.4 m rock 2 m away gets
 * detail 11 (2 880 triangles) and a rock 1000 px across detail 47 (46 080).
 */
export const ROCK_PIXELS_PER_SEGMENT = 10;

/**
 * Index into ROCK_DETAIL_LADDER for a rock covering `pixels` screen pixels
 * across, at least `minIndex` (the ladder index of its chunk mesh tier).
 */
export function ladderIndexForPixels(
  pixels: number,
  pixelsPerSegment: number,
  minIndex: number
): number {
  let index = minIndex;
  while (
    index + 1 < ROCK_DETAIL_LADDER.length &&
    (ROCK_DETAIL_LADDER[index + 1] + 1) * pixelsPerSegment <= pixels
  ) {
    index++;
  }
  return index;
}

/** Index of an icosphere detail in ROCK_DETAIL_LADDER (-1 when absent). */
export function ladderIndexOfDetail(detail: number): number {
  return ROCK_DETAIL_LADDER.indexOf(detail);
}

/** Upper bound of triangles in a prototype of the given icosphere detail. */
export function rockTriangleBudget(detail: number): number {
  return 20 * (detail + 1) ** 2;
}

/** Size tier (index into ROCK_TIERS) for a rock diameter in meters. */
export function sizeTierForDiameter(diameter: number): number {
  for (let tier = 0; tier < ROCK_TIERS.length - 1; tier++) {
    if (diameter >= ROCK_TIERS[tier].minDiameter) {
      return tier;
    }
  }
  return ROCK_TIERS.length - 1;
}

/** Mesh tier rendered for a size tier on a chunk LOD: one tier cheaper per LOD. */
export function meshTierForLod(sizeTier: number, lodLevel: number): number {
  return Math.min(ROCK_TIERS.length - 1, sizeTier + Math.max(0, lodLevel));
}

/** Number of distinct shapes rocks of a size tier use in one chunk at a chunk LOD. */
export function shapeCountFor(sizeTier: number, lodLevel: number, librarySize: number): number {
  const lodIndex = Math.min(Math.max(0, lodLevel), ROCK_LOD_SHAPE_LIMIT.length - 1);
  const limit = Math.min(
    librarySize,
    ROCK_TIERS[sizeTier].maxShapes,
    ROCK_LOD_SHAPE_LIMIT[lodIndex]
  );
  return Math.max(1, Math.floor(limit));
}

/**
 * Shape id for a rock.
 *
 * @param sizeTier - The rock's size tier
 * @param lodLevel - Chunk LOD the rock is placed for
 * @param librarySize - Number of shapes in the library
 * @param chunkHash - Any non-negative integer identifying the chunk
 * @param unit - The rock's own random number in [0, 1)
 */
export function rockShapeFor(
  sizeTier: number,
  lodLevel: number,
  librarySize: number,
  chunkHash: number,
  unit: number
): number {
  const count = shapeCountFor(sizeTier, lodLevel, librarySize);
  const pick = Math.min(count - 1, Math.floor(unit * count));
  const lodIndex = Math.min(Math.max(0, lodLevel), ROCK_LOD_SHAPE_LIMIT.length - 1);
  if (
    !ROCK_TIERS[sizeTier].wholeLibrary ||
    ROCK_LOD_SHAPE_LIMIT[lodIndex] < ROCK_TIERS[sizeTier].maxShapes
  ) {
    return pick;
  }
  return ((chunkHash % librarySize) + pick) % librarySize;
}

/** Overall silhouette family of a shape. */
export type RockArchetype = 'block' | 'slab' | 'wedge' | 'round';

/**
 * Archetype cycle. The first eight entries are what the small tiers use, so
 * they already cover every family, with blocky shapes the most common.
 */
const ARCHETYPE_CYCLE: readonly RockArchetype[] = [
  'block',
  'slab',
  'wedge',
  'block',
  'round',
  'slab',
  'block',
  'wedge',
];

/** [min, max] height / footprint-diameter ratio per archetype. */
const HEIGHT_RANGE: Readonly<Record<RockArchetype, readonly [number, number]>> = {
  block: [0.55, 0.8],
  slab: [0.26, 0.4],
  wedge: [0.6, 0.85],
  round: [0.6, 0.78],
};

/** Deterministic hash of an integer to [0, 1). */
export function hashToUnit(value: number): number {
  let h = Math.imul(value | 0, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Silhouette family of a shape id. */
export function rockArchetype(shapeId: number): RockArchetype {
  const index =
    ((Math.floor(shapeId) % ARCHETYPE_CYCLE.length) + ARCHETYPE_CYCLE.length) %
    ARCHETYPE_CYCLE.length;
  return ARCHETYPE_CYCLE[index];
}

/**
 * Height of a shape's prototype mesh. Prototypes are normalized to a unit
 * horizontal footprint (largest horizontal bounding-box extent = 1) resting
 * on y = 0, so this is also the rock's height / diameter ratio. The builder
 * enforces it exactly, which lets the placement code bury rocks by a
 * fraction of their height without ever seeing the geometry.
 */
export function rockHeightRatio(shapeId: number): number {
  const [min, max] = HEIGHT_RANGE[rockArchetype(shapeId)];
  return min + (max - min) * hashToUnit(Math.floor(shapeId) + 7919);
}
