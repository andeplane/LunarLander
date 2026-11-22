/**
 * Three.js layer assignments shared across the renderer.
 *
 * Layer 0 is the default layer every camera renders. Layer 1 is used by the
 * celestial system for the sun disc.
 */

/**
 * Objects that should cast sun shadows enable this layer in addition to the
 * default one. The shadow cascades render only this layer, so sky objects,
 * helpers and UI meshes never end up in the shadow maps.
 */
export const SHADOW_CASTER_LAYER = 2;
