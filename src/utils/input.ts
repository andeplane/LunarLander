/**
 * Pure input helpers (no DOM dependencies).
 */

/**
 * Resolve the movement amount for one direction from hybrid input sources.
 *
 * Keyboard is digital (full strength when pressed); touch/analog input has a
 * magnitude in [0, 1]. The two sources coexist on hybrid devices (touchscreen
 * laptops), so neither may mask the other: a pressed key always contributes
 * full strength even when the analog stick is centered, and the analog
 * magnitude is used when it is the stronger input.
 *
 * @param keyPressed - whether the keyboard key for this direction is held
 * @param analogMagnitude - analog input magnitude for this direction (0 when inactive)
 * @returns movement amount in [0, 1]
 */
export function movementAmount(keyPressed: boolean, analogMagnitude: number): number {
  const analog = Math.min(Math.max(analogMagnitude, 0), 1);
  return Math.max(keyPressed ? 1 : 0, analog);
}
