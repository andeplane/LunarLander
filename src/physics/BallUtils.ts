/**
 * BallUtils - Pure helper functions for ball lifecycle decisions.
 *
 * Kept free of Rapier/Three.js dependencies so they can be unit tested
 * without initializing the physics WASM module or a WebGL context.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Minimum linear speed (m/s) for a ball to count as "moving". */
export const LINEAR_SPEED_THRESHOLD = 0.01;

/** Minimum angular speed (rad/s) for a ball to count as "moving". */
export const ANGULAR_SPEED_THRESHOLD = 0.01;

/**
 * Determine whether a ball should be considered moving, based on both its
 * linear and angular velocity. A ball spinning in place still needs
 * rendering, so angular velocity must be part of the check.
 */
export function isBallMoving(
  linvel: Vec3Like,
  angvel: Vec3Like,
  linearThreshold: number = LINEAR_SPEED_THRESHOLD,
  angularThreshold: number = ANGULAR_SPEED_THRESHOLD
): boolean {
  const linSq = linvel.x * linvel.x + linvel.y * linvel.y + linvel.z * linvel.z;
  if (linSq > linearThreshold * linearThreshold) {
    return true;
  }
  const angSq = angvel.x * angvel.x + angvel.y * angvel.y + angvel.z * angvel.z;
  return angSq > angularThreshold * angularThreshold;
}

/**
 * Determine whether a ball has fallen below the kill altitude and should be
 * despawned. Balls that leave the terrain-collider window have nothing
 * beneath them and would otherwise fall forever, keeping the physics loop
 * "moving" and permanently defeating render-on-demand.
 */
export function shouldDespawnBall(position: Vec3Like, killY: number): boolean {
  return position.y < killY;
}

/**
 * Clamp a spawn height so the ball never starts beneath the terrain surface
 * (a ball spawned below the thin heightfield falls through it forever).
 *
 * @param desiredY - The requested spawn height
 * @param terrainHeight - Terrain height at the spawn (x, z), or null if unknown
 * @param ballRadius - Radius of the ball
 * @returns The clamped spawn height (at least terrainHeight + ballRadius)
 */
export function clampSpawnY(
  desiredY: number,
  terrainHeight: number | null,
  ballRadius: number
): number {
  if (terrainHeight === null) {
    return desiredY;
  }
  return Math.max(desiredY, terrainHeight + ballRadius);
}
