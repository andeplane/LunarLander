/**
 * Engine-wide settings and constants.
 * 
 * This is the SINGLE SOURCE OF TRUTH for default values used across the engine.
 * Do not duplicate these values elsewhere - always import from this file.
 */

/**
 * Default planet radius in meters for curvature calculations.
 * This value is used by MoonMaterial, CelestialSystem, and Engine.
 */
export const DEFAULT_PLANET_RADIUS = 5000;

/**
 * Upper bound on the renderer's device pixel ratio.
 *
 * Fragment cost scales with the square of this value. A Retina display at
 * DPR 2 shades ~4x the pixels of DPR 1, and every one of those pixels runs
 * the procedural MoonMaterial plus the full-resolution bloom chain. Capping
 * at 1.25 keeps text/HUD crisp (DOM is unaffected) while cutting GPU work
 * ~2.5x versus DPR 2. Scene edges are anti-aliased by the composer's MSAA
 * render target instead (see COMPOSER_MSAA_SAMPLES).
 */
export const MAX_PIXEL_RATIO = 1.25;

/**
 * MSAA sample count for the post-processing composer's render target.
 *
 * The canvas-level `antialias` flag does nothing here: the scene is drawn
 * into the composer's offscreen target and only the final full-screen quad
 * hits the (multisampled) canvas, so geometry edges were never anti-aliased.
 * Multisampling the composer target fixes that at a fraction of the cost of
 * a higher pixel ratio.
 */
export const COMPOSER_MSAA_SAMPLES = 4;
