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
