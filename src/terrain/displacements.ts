import type * as THREE from 'three';
import type { BufferGeometry } from 'three';

/**
 * Displace the Y coordinate of every vertex using a height function.
 *
 * @param geometry - Geometry whose position attribute is displaced in place
 * @param yFunction - Height function in local chunk space
 * @param strength - Height multiplier applied to every sample
 * @param computeNormals - Recompute vertex normals after displacement
 *   (default true). Callers that modify heights again afterwards (e.g. the
 *   chunk worker applying craters) should pass false and compute normals
 *   once at the end, since the first pass would be thrown away.
 */
export function displaceY(
  geometry: BufferGeometry,
  yFunction: (x: number, z: number) => number,
  strength: number,
  computeNormals: boolean = true,
) {
  const position = geometry.attributes.position as THREE.BufferAttribute;

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const z = position.getZ(i);
    position.setY(i, yFunction(x, z) * strength);
  }

  position.needsUpdate = true;
  if (computeNormals) {
    geometry.computeVertexNormals();
  }
}
