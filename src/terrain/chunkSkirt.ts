/**
 * Hanging skirt around a chunk mesh.
 *
 * Neighbouring chunks at different LODs do not agree on the height of their
 * shared edge: craters fade out with vertex spacing (see craterLodWeight), so
 * the finer chunk carves craters the coarser one leaves out. Edge stitching
 * only lines the vertices up horizontally, which leaves vertical slits that
 * show the sky. The skirt is a wall hanging down from the chunk's perimeter
 * that closes them.
 *
 * Layout: the skirt's top edge reuses the grid's perimeter vertices; its
 * bottom vertices are appended after the (resolution + 1)² grid vertices, one
 * per perimeter vertex, walking the perimeter so that the wall faces outward:
 * row 0 towards +X, the last column towards +Z, the last row towards -X and
 * column 0 towards -Z.
 */

/** Number of vertices the skirt appends to a chunk mesh. */
export function skirtVertexCount(resolution: number): number {
  return 4 * resolution;
}

/** Number of indices the skirt appends to a chunk's index buffer. */
export function skirtIndexCount(resolution: number): number {
  return 4 * resolution * 6;
}

/**
 * How far the skirt hangs below the surface. The height mismatch between two
 * LODs grows with the size of the craters the coarser one leaves out, which
 * is proportional to its vertex spacing.
 */
export function chunkSkirtDepth(vertexSpacing: number): number {
  return 1.5 * vertexSpacing + 1;
}

/** Grid vertex index of the k-th perimeter vertex (k in [0, 4 * resolution)). */
export function skirtRingVertex(k: number, resolution: number): number {
  const side = resolution + 1;
  if (k < resolution) return k;
  if (k < 2 * resolution) return (k - resolution) * side + resolution;
  if (k < 3 * resolution) return resolution * side + (3 * resolution - k);
  return (4 * resolution - k) * side;
}

/**
 * Fill in the skirt's bottom vertices. `positions` and `normals` must have
 * room for skirtVertexCount(resolution) vertices after the grid.
 */
export function writeSkirtVertices(
  positions: Float32Array,
  normals: Float32Array,
  resolution: number,
  depth: number
): void {
  const side = resolution + 1;
  const ring = skirtVertexCount(resolution);
  let out = side * side * 3;
  for (let k = 0; k < ring; k++) {
    const source = skirtRingVertex(k, resolution) * 3;
    positions[out] = positions[source];
    positions[out + 1] = positions[source + 1] - depth;
    positions[out + 2] = positions[source + 2];
    // Shaded like the edge it hangs from, so a visible sliver blends in
    normals[out] = normals[source];
    normals[out + 1] = normals[source + 1];
    normals[out + 2] = normals[source + 2];
    out += 3;
  }
}

/**
 * Write the skirt's triangles into `indices` starting at `offset` and return
 * the offset after them.
 */
export function writeSkirtIndices(
  indices: Uint32Array,
  offset: number,
  resolution: number
): number {
  const side = resolution + 1;
  const ring = skirtVertexCount(resolution);
  const base = side * side;
  let cursor = offset;
  for (let k = 0; k < ring; k++) {
    const next = (k + 1) % ring;
    const top0 = skirtRingVertex(k, resolution);
    const top1 = skirtRingVertex(next, resolution);
    const bottom0 = base + k;
    const bottom1 = base + next;
    indices[cursor++] = top0;
    indices[cursor++] = top1;
    indices[cursor++] = bottom0;
    indices[cursor++] = top1;
    indices[cursor++] = bottom1;
    indices[cursor++] = bottom0;
  }
  return cursor;
}

/** A copy of a grid index buffer with the skirt's triangles appended. */
export function appendSkirtIndices(gridIndices: Uint32Array, resolution: number): Uint32Array {
  const indices = new Uint32Array(gridIndices.length + skirtIndexCount(resolution));
  indices.set(gridIndices);
  writeSkirtIndices(indices, gridIndices.length, resolution);
  return indices;
}

/** Whether a mesh with this many vertices carries a skirt for the given resolution. */
export function hasSkirtVertices(vertexCount: number, resolution: number): boolean {
  const side = resolution + 1;
  return vertexCount === side * side + skirtVertexCount(resolution);
}
