/**
 * HeightfieldUtils - Pure helpers for building Rapier heightfield data
 * from terrain mesh geometry.
 *
 * Kept free of Rapier/Three imports so the sampling and resolution logic
 * can be unit tested without initializing WASM or WebGL.
 */

/**
 * Maximum number of heightfield cells per axis for physics colliders.
 * Rapier can't handle 1M+ heights, so high-res visual meshes are downsampled.
 */
export const PHYSICS_RESOLUTION_CAP = 128;

/**
 * The effective physics resolution (in cells) for a given visual mesh
 * resolution. Because the collider downsamples the same world grid points,
 * any mesh resolution at or above the cap produces an identical heightfield —
 * rebuilds are only needed when this value changes.
 */
export function effectivePhysicsResolution(
  meshResolution: number,
  cap: number = PHYSICS_RESOLUTION_CAP
): number {
  return Math.min(meshResolution, cap);
}

/**
 * Choose which built LOD level a chunk's physics collider should be sampled
 * from.
 *
 * Every mesh at or above the physics cap produces a bit-identical downsampled
 * heightfield (they all sample the same world grid points), so the coarsest
 * such built level is preferred: neighboring chunks then agree exactly along
 * shared edges even when their visual LODs differ, eliminating collider seams
 * (balls catching or slipping through at chunk borders). Previously the
 * collider tracked each chunk's *displayed* LOD, so a chunk showing a
 * below-cap mesh got a coarser collider than its neighbor.
 *
 * When no built level meets the cap, the finest built level is the least-bad
 * fallback (only reachable at high altitude where every retained LOD is
 * coarse).
 *
 * @param builtLevels - LOD indices that currently have a built mesh
 * @param lodResolutions - resolution (cells per axis) per LOD index, finest first
 * @param cap - physics resolution cap (cells per axis)
 * @returns the LOD index to sample from, or null when nothing is built
 */
export function selectPhysicsSourceLod(
  builtLevels: Iterable<number>,
  lodResolutions: readonly number[],
  cap: number = PHYSICS_RESOLUTION_CAP
): number | null {
  let coarsestAtOrAboveCap: number | null = null;
  let finest: number | null = null;

  for (const lod of builtLevels) {
    const resolution = lodResolutions[lod];
    if (resolution === undefined) {
      continue;
    }
    if (finest === null || lod < finest) {
      finest = lod;
    }
    if (resolution >= cap && (coarsestAtOrAboveCap === null || lod > coarsestAtOrAboveCap)) {
      coarsestAtOrAboveCap = lod;
    }
  }

  return coarsestAtOrAboveCap ?? finest;
}

/**
 * Result of sampling a mesh into a Rapier heightfield.
 */
export interface HeightfieldSample {
  /** X-major heights: index = xCol * numVertices + zRow, length = numVertices^2 */
  heights: Float32Array;
  /** Number of cells per axis */
  numCells: number;
  /** Number of vertices per axis (numCells + 1) */
  numVertices: number;
  minHeight: number;
  maxHeight: number;
}

/**
 * Sample heights from a grid mesh into Rapier's X-major heightfield layout.
 *
 * The source mesh is assumed to be a (meshResolution+1)^2 vertex grid laid out
 * row-major with col = X and row = Z (Three.js PlaneGeometry order). When the
 * mesh is higher resolution than numCells, vertices are sampled at regular
 * intervals so the same world grid points are used regardless of mesh LOD.
 *
 * Returns null if any sampled height is non-finite (NaN/Infinity).
 *
 * @param getY - accessor returning the Y (height) of a mesh vertex index
 * @param meshResolution - cells per axis in the source mesh
 * @param numCells - cells per axis in the output heightfield
 */
export function sampleHeightfield(
  getY: (vertexIndex: number) => number,
  meshResolution: number,
  numCells: number
): HeightfieldSample | null {
  const meshVertexCount = meshResolution + 1;
  const numVertices = numCells + 1;
  const heights = new Float32Array(numVertices * numVertices);

  // Sampling step when mesh is higher res than physics (e.g. 1024/128 = 8)
  const sampleStep = meshResolution / numCells;
  let minHeight = Infinity;
  let maxHeight = -Infinity;

  // PlaneGeometry: col = X, row = Z (vertex index = row * meshVertexCount + col)
  // Rapier heightfield: index = X * stride + Z = col * numVertices + row
  for (let row = 0; row < numVertices; row++) {
    for (let col = 0; col < numVertices; col++) {
      const meshRow = Math.min(Math.round(row * sampleStep), meshVertexCount - 1);
      const meshCol = Math.min(Math.round(col * sampleStep), meshVertexCount - 1);
      const meshVertexIndex = meshRow * meshVertexCount + meshCol;

      const y = getY(meshVertexIndex);
      if (!Number.isFinite(y)) {
        return null;
      }

      heights[col * numVertices + row] = y;
      minHeight = Math.min(minHeight, y);
      maxHeight = Math.max(maxHeight, y);
    }
  }

  return { heights, numCells, numVertices, minHeight, maxHeight };
}
