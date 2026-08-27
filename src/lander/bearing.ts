/**
 * Bearing helpers shared by the HUD (drift scope, pad bearing).
 *
 * World bearings are measured as atan2(x, -z): 0 = along -Z, +π/2 = along +X
 * (clockwise seen from above). A craft yawed by `heading` (three.js Y
 * rotation) points its local forward (0,0,-1) at world (-sin h, 0, -cos h),
 * whose bearing is -heading — so converting a world bearing to one relative
 * to the craft's nose means ADDING the heading, not subtracting it.
 */

/** Wrap an angle to (-π, π]. */
export function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

/** World bearing (radians) of a horizontal direction vector. */
export function worldBearing(x: number, z: number): number {
  return Math.atan2(x, -z);
}

/**
 * Bearing of a world direction relative to the craft's nose:
 * 0 = straight ahead, +π/2 = to the right, ±π = behind.
 */
export function bearingRelativeToHeading(x: number, z: number, heading: number): number {
  return normalizeAngle(worldBearing(x, z) + heading);
}
