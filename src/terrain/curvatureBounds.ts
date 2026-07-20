import type { Sphere, Vector3 } from 'three';

/**
 * Pure helpers for bounding-sphere expansion under the planetary curvature
 * vertex shader (MoonMaterial). The shader drops every vertex by
 * `d^2 / (2 * planetRadius)` where `d` is the horizontal (XZ) distance from
 * the camera to the vertex. Frustum culling runs against static bounding
 * spheres, so those spheres must be expanded to contain the dropped
 * geometry - but no more than necessary, or culling stops rejecting anything.
 *
 * Shared by TerrainGenerator (terrain chunk geometry) and RockManager
 * (per-chunk rock InstancedMesh) so both use the same, chunk-local bound
 * instead of a global worst case.
 */

/**
 * Inclusive range of curvature drops for a set of points.
 */
export interface CurvatureDropRange {
  dropMin: number;
  dropMax: number;
}

/**
 * Curvature drop applied by the vertex shader at a given horizontal
 * (XZ-plane) distance from the camera.
 */
export function curvatureDrop(horizontalDistance: number, planetRadius: number): number {
  return (horizontalDistance * horizontalDistance) / (2 * planetRadius);
}

/**
 * Range of curvature drops for all points within `radius` of a center that is
 * `centerDistance` away from the camera in the XZ plane.
 */
export function curvatureDropRange(
  centerDistance: number,
  radius: number,
  planetRadius: number
): CurvatureDropRange {
  const dMin = Math.max(0, centerDistance - radius);
  const dMax = centerDistance + radius;
  return {
    dropMin: curvatureDrop(dMin, planetRadius),
    dropMax: curvatureDrop(dMax, planetRadius),
  };
}

/**
 * Maximum possible horizontal distance from the camera to any point inside a
 * chunk while that chunk is still loaded.
 *
 * Chunks are pruned once their center is more than `renderDistance` grid
 * units from the camera (Euclidean distance in grid space, see
 * ChunkManager.getNearbyChunkPositionKeys), so the camera-to-center distance
 * is bounded by `renderDistance * max(chunkWidth, chunkDepth)`. Any point in
 * the chunk is at most half the chunk diagonal beyond the center.
 *
 * This is a per-chunk-lifetime bound: much tighter than the old global
 * worst case of `(renderDistance + 1) * sqrt(chunkWidth^2 + chunkDepth^2)`
 * (opposite corners of the whole loaded grid), which inflated every bounding
 * sphere so much that frustum culling never rejected anything.
 */
export function maxLoadedChunkDistance(
  renderDistance: number,
  chunkWidth: number,
  chunkDepth: number
): number {
  const maxCenterDistance = renderDistance * Math.max(chunkWidth, chunkDepth);
  const halfDiagonal = Math.sqrt(chunkWidth * chunkWidth + chunkDepth * chunkDepth) / 2;
  return maxCenterDistance + halfDiagonal;
}

/**
 * Rewrite `sphere` so it contains a base sphere (`baseCenter`, `baseRadius`)
 * whose points are dropped by any amount within `range`.
 *
 * A point p inside the base sphere maps to p - (0, drop, 0) with
 * drop in [dropMin, dropMax]. Shifting the center down by the mid drop and
 * growing the radius by half the drop span contains every such point.
 */
export function applyCurvatureDropToSphere(
  sphere: Sphere,
  baseCenter: Vector3,
  baseRadius: number,
  range: CurvatureDropRange
): void {
  sphere.center.copy(baseCenter);
  sphere.center.y -= (range.dropMin + range.dropMax) / 2;
  sphere.radius = baseRadius + (range.dropMax - range.dropMin) / 2;
}
