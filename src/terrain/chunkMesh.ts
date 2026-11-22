/**
 * Chunk terrain mesh construction (positions + normals) on a regular grid.
 *
 * This is the mesh half of the shared height pipeline:
 *
 *   height = createTerrainEvaluator(args)(localX, localZ)
 *              * terrainDisplacementStrength(smoothLowerPlanes)
 *          + craters(worldX, worldZ)
 *
 * (the point-sampling halves are sampleHeightFromVertices in ChunkWorker.ts
 * and heightSampler.ts). It works directly on typed arrays instead of going
 * through a PlaneGeometry: heights are evaluated on the chunk grid extended
 * by a one-vertex skirt, craters are rasterized into that grid, and normals
 * are accumulated from the grid's triangles exactly like
 * BufferGeometry.computeVertexNormals does for a PlaneGeometry, then the
 * skirt is dropped.
 */

import { type Crater, rasterizeCraters } from './craters';
import { skirtVertexCount, writeSkirtVertices } from './chunkSkirt';
import { createTerrainEvaluator, type TerrainArgs, terrainDisplacementStrength } from './terrain';

export interface ChunkMesh {
  /**
   * Interior vertex positions (x, y, z) in chunk-local space, row-major,
   * followed by the hanging skirt's vertices when one was requested
   */
  positions: Float32Array;
  /** Unit vertex normals matching `positions` */
  normals: Float32Array;
}

/**
 * Local-space vertex coordinates of one axis of the skirted grid: index 0 and
 * `segments + 2` are the skirt, 1..segments + 1 the chunk itself. Values are
 * rounded to float32 because that is what the mesh stores, and every height
 * is evaluated at the stored coordinate.
 */
function skirtedAxis(size: number, segments: number): Float32Array {
  const step = size / segments;
  const axis = new Float32Array(segments + 3);
  for (let i = 0; i < axis.length; i++) {
    axis[i] = (i - 1) * step - size / 2;
  }
  return axis;
}

/**
 * Build the terrain mesh of one chunk.
 *
 * @param terrainArgs - Chunk terrain arguments (resolution = segments per axis)
 * @param craters - Craters affecting the chunk and its skirt, in world
 *   coordinates and canonical order (generateCratersForRegion with a margin
 *   of at least one vertex spacing)
 * @param hangingSkirtDepth - When positive, a wall this deep is hung from the
 *   chunk's perimeter (see chunkSkirt.ts); its vertices follow the grid's
 */
export function buildChunkMesh(
  terrainArgs: TerrainArgs,
  craters: readonly Crater[],
  hangingSkirtDepth: number = 0
): ChunkMesh {
  const { resolution, width, depth, posX, posZ } = terrainArgs;
  const columns = resolution + 3;
  const rows = resolution + 3;

  const localX = skirtedAxis(width, resolution);
  const localZ = skirtedAxis(depth, resolution);
  const worldX = new Float64Array(columns);
  const worldZ = new Float64Array(rows);
  for (let i = 0; i < columns; i++) worldX[i] = localX[i] + posX;
  for (let j = 0; j < rows; j++) worldZ[j] = localZ[j] + posZ;

  // Craters first, summed in float64 so the result does not depend on how
  // many craters overlap a vertex
  const craterHeights = new Float64Array(columns * rows);
  const vertexSpacing = Math.max(width, depth) / resolution;
  rasterizeCraters(craterHeights, worldX, worldZ, craters, vertexSpacing);

  // Base terrain + craters, stored as float32 like the mesh
  const evaluate = createTerrainEvaluator(terrainArgs);
  const strength = terrainDisplacementStrength(terrainArgs.smoothLowerPlanes);
  const heights = new Float32Array(columns * rows);
  for (let j = 0; j < rows; j++) {
    const z = localZ[j];
    const rowOffset = j * columns;
    for (let i = 0; i < columns; i++) {
      heights[rowOffset + i] = evaluate(localX[i], z) * strength + craterHeights[rowOffset + i];
    }
  }

  // Area-weighted normals. Each quad (a = top-left, b = bottom-left,
  // c = bottom-right, d = top-right) is split into triangles (a, b, d) and
  // (b, c, d) like PlaneGeometry; the unnormalized face normals are
  //   (a, b, d): (dz * (ha - hd), dx * dz, dx * (ha - hb))
  //   (b, c, d): (dz * (hb - hc), dx * dz, dx * (hd - hc))
  const accumulated = new Float32Array(columns * rows * 3);
  for (let j = 0; j < rows - 1; j++) {
    const dz = localZ[j + 1] - localZ[j];
    for (let i = 0; i < columns - 1; i++) {
      const dx = localX[i + 1] - localX[i];
      const a = j * columns + i;
      const b = a + columns;
      const c = b + 1;
      const d = a + 1;
      const ha = heights[a];
      const hb = heights[b];
      const hc = heights[c];
      const hd = heights[d];
      const ny = dx * dz;

      const n1x = dz * (ha - hd);
      const n1z = dx * (ha - hb);
      const n2x = dz * (hb - hc);
      const n2z = dx * (hd - hc);

      const a3 = a * 3;
      const b3 = b * 3;
      const c3 = c * 3;
      const d3 = d * 3;
      accumulated[a3] += n1x;
      accumulated[a3 + 1] += ny;
      accumulated[a3 + 2] += n1z;
      accumulated[b3] += n1x + n2x;
      accumulated[b3 + 1] += ny + ny;
      accumulated[b3 + 2] += n1z + n2z;
      accumulated[c3] += n2x;
      accumulated[c3 + 1] += ny;
      accumulated[c3 + 2] += n2z;
      accumulated[d3] += n1x + n2x;
      accumulated[d3 + 1] += ny + ny;
      accumulated[d3 + 2] += n1z + n2z;
    }
  }

  // Drop the skirt and normalize
  const side = resolution + 1;
  const vertexCount = side * side + (hangingSkirtDepth > 0 ? skirtVertexCount(resolution) : 0);
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  let out = 0;
  for (let j = 1; j <= side; j++) {
    const z = localZ[j];
    for (let i = 1; i <= side; i++) {
      const source = j * columns + i;
      positions[out] = localX[i];
      positions[out + 1] = heights[source];
      positions[out + 2] = z;

      const nx = accumulated[source * 3];
      const ny = accumulated[source * 3 + 1];
      const nz = accumulated[source * 3 + 2];
      const inverseLength = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      normals[out] = nx * inverseLength;
      normals[out + 1] = ny * inverseLength;
      normals[out + 2] = nz * inverseLength;
      out += 3;
    }
  }

  if (hangingSkirtDepth > 0) {
    writeSkirtVertices(positions, normals, resolution, hangingSkirtDepth);
  }

  return { positions, normals };
}
