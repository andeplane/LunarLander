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

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * A rigid-body transform snapshot (position + rotation) captured around a
 * fixed physics step, used for render interpolation between steps.
 */
export interface TransformSnapshot {
  position: Vec3Like;
  rotation: QuatLike;
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

/**
 * Linearly interpolate between two positions. alpha=0 returns a, alpha=1
 * returns b.
 */
export function lerpVec3(a: Vec3Like, b: Vec3Like, alpha: number): Vec3Like {
  return {
    x: a.x + (b.x - a.x) * alpha,
    y: a.y + (b.y - a.y) * alpha,
    z: a.z + (b.z - a.z) * alpha,
  };
}

/**
 * Spherically interpolate between two unit quaternions (shortest path).
 * alpha=0 returns a, alpha=1 returns b (up to sign — q and -q represent the
 * same rotation). Falls back to normalized lerp for nearly parallel inputs
 * where the slerp denominator becomes numerically unstable. The result is
 * always normalized.
 */
export function slerpQuat(a: QuatLike, b: QuatLike, alpha: number): QuatLike {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;

  // Take the shortest path: q and -q are the same rotation, so flip b's
  // sign when the quaternions are on opposite hemispheres
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  let scaleA: number;
  let scaleB: number;
  if (dot > 0.9995) {
    // Nearly parallel: sin(theta) ~ 0, use normalized lerp instead
    scaleA = 1 - alpha;
    scaleB = alpha;
  } else {
    const theta = Math.acos(Math.min(dot, 1));
    const sinTheta = Math.sin(theta);
    scaleA = Math.sin((1 - alpha) * theta) / sinTheta;
    scaleB = Math.sin(alpha * theta) / sinTheta;
  }

  const x = scaleA * a.x + scaleB * bx;
  const y = scaleA * a.y + scaleB * by;
  const z = scaleA * a.z + scaleB * bz;
  const w = scaleA * a.w + scaleB * bw;

  const length = Math.hypot(x, y, z, w);
  if (length === 0) {
    // Degenerate input (e.g. zero quaternions): return identity rotation
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

/**
 * Interpolate between two transform snapshots for render interpolation:
 * linear interpolation for position, slerp for rotation. alpha is clamped
 * to [0, 1] so an out-of-range accumulator fraction can never extrapolate.
 */
export function interpolateTransform(
  prev: TransformSnapshot,
  curr: TransformSnapshot,
  alpha: number
): TransformSnapshot {
  const t = Math.min(Math.max(alpha, 0), 1);
  return {
    position: lerpVec3(prev.position, curr.position, t),
    rotation: slerpQuat(prev.rotation, curr.rotation, t),
  };
}
