/**
 * Mobile device detection utilities
 */

/**
 * True when the device supports touch input at all.
 * Note: this includes hybrid devices (touchscreen laptops), so it must NOT
 * be used to disable keyboard/mouse input paths — use hasCoarsePrimaryPointer()
 * to detect devices where touch is the primary input.
 */
export function isTouchDevice(): boolean {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/**
 * True when the device's primary pointer is coarse (a finger) — phones/tablets.
 * Touchscreen laptops report a fine primary pointer (mouse/trackpad), so
 * pointer lock and mouse look remain available there.
 */
export function hasCoarsePrimaryPointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}
