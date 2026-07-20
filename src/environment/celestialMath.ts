import * as THREE from 'three';

/**
 * Pure math helpers for the celestial system (sky curvature and sun direction).
 * Kept free of scene/WebGL dependencies so they can be unit-tested in Node.
 */

// Scratch objects reused across calls to avoid per-frame allocations
const _axis = new THREE.Vector3();
const _step = new THREE.Quaternion();

/**
 * Apply one incremental parallel-transport curvature step to a sky rotation.
 *
 * As the observer moves (dx, dz) in the horizontal plane, the sky rotates by
 * dTheta = stepDistance / planetRadius around the horizontal axis perpendicular
 * to the direction of travel. Accumulating these steps (parallel transport)
 * keeps the sky rotation smooth for ANY path — unlike deriving the rotation
 * from the current position relative to the world origin, which is only valid
 * for radial travel and causes the sky to slew during tangential flight and
 * snap when crossing near the origin.
 *
 * Travelling a straight line of length 2*PI*R rotates the sky a full turn,
 * matching the "walk around the planet" intuition.
 *
 * The step rotation is expressed in world space, so it pre-multiplies the
 * accumulated rotation. The quaternion is renormalized to avoid drift.
 *
 * @param rotation Accumulated sky rotation (mutated in place)
 * @param dx Observer movement along world X since last step (meters)
 * @param dz Observer movement along world Z since last step (meters)
 * @param planetRadius Virtual planet radius (meters)
 * @returns The mutated rotation quaternion
 */
export function applyCurvatureStep(
  rotation: THREE.Quaternion,
  dx: number,
  dz: number,
  planetRadius: number
): THREE.Quaternion {
  const stepDistance = Math.sqrt(dx * dx + dz * dz);
  if (stepDistance < 1e-9 || planetRadius <= 0) {
    return rotation;
  }

  const dTheta = stepDistance / planetRadius;

  // Travel direction is (dx, dz) / stepDistance; the rotation axis is the
  // horizontal axis perpendicular to it: (-sin(phi), 0, cos(phi)) with
  // phi = atan2(dz, dx). Written without trig:
  _axis.set(-dz / stepDistance, 0, dx / stepDistance);
  _step.setFromAxisAngle(_axis, dTheta);

  return rotation.premultiply(_step).normalize();
}

/**
 * Direction from an observer to a target, both in world space.
 *
 * Used for the sun direction on terrain: the celestial container follows the
 * camera, so the sun's world position is cameraPos + sunOffset. Normalizing
 * the raw world position would mix the camera position into the direction
 * (several degrees of lighting error a few km from the origin). Subtracting
 * the observer position first yields the pure direction.
 *
 * @param targetWorldPos Target position in world space
 * @param observerPos Observer position in world space
 * @param out Optional vector to write the result into
 * @returns Normalized direction from observer to target
 */
export function directionFromObserver(
  targetWorldPos: THREE.Vector3,
  observerPos: THREE.Vector3,
  out: THREE.Vector3 = new THREE.Vector3()
): THREE.Vector3 {
  return out.copy(targetWorldPos).sub(observerPos).normalize();
}
