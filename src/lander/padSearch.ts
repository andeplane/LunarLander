/**
 * Landing-pad search (ADR-0004 §1): find the flattest disc of a given
 * radius near a candidate point using the shared deterministic terrain
 * sampler — works on unbuilt terrain during the Briefing screen.
 *
 * Rejects discs containing rocks ≥ 1 m (rock positions are injected — they
 * come from the same deterministic placement the chunks use) and, via a
 * dense sample grid at small baselines, discs cut by small craters that the
 * physics heightfield aliases (slope check catches their walls).
 */
import type { TerrainHeightSampler } from '../terrain/heightSampler';

export interface RockNearby {
  x: number;
  z: number;
  diameter: number;
}

export interface PadSearchArgs {
  sampler: TerrainHeightSampler;
  /** Center of the search area (world) */
  centerX: number;
  centerZ: number;
  /** How far from the center to look for candidates */
  searchRadius: number;
  /** Pad disc radius */
  padRadius: number;
  /** Max slope anywhere in the disc (degrees) */
  maxSlopeDeg: number;
  /** Max height spread across the disc (meters) */
  maxHeightSpread: number;
  /** Rocks in the search area (world coords + diameter, meters) */
  rocks: RockNearby[];
  /** Only rocks at/above this diameter block a pad (ADR: 1 m) */
  blockingRockDiameter?: number;
  /** Seeded RNG for candidate jitter (deterministic missions) */
  rng: () => number;
}

export interface PadSearchResult {
  x: number;
  z: number;
  /** Terrain height at the pad center */
  y: number;
  /** Worst slope found in the disc (degrees) */
  maxSlopeDeg: number;
  /** Height spread across the disc (meters) */
  heightSpread: number;
  /** 0 (barely acceptable) .. 1 (perfectly flat) */
  quality: number;
}

/** Grid spacing between disc sample points (m) — dense enough that a 5 m
 * crater cannot hide between samples. */
const SAMPLE_SPACING = 2.0;
/** Slope sampling baseline (m) — small enough to see crater walls. */
const SLOPE_BASELINE = 1.5;

/**
 * Evaluate one disc: worst slope + height spread over a dense grid.
 * Exported for site-quality scoring of off-pad landings.
 */
export function evaluateDisc(
  sampler: TerrainHeightSampler,
  x: number,
  z: number,
  radius: number
): { maxSlopeDeg: number; heightSpread: number } {
  let maxSlope = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  const r2 = radius * radius;
  for (let dx = -radius; dx <= radius; dx += SAMPLE_SPACING) {
    for (let dz = -radius; dz <= radius; dz += SAMPLE_SPACING) {
      if (dx * dx + dz * dz > r2) continue;
      const px = x + dx;
      const pz = z + dz;
      const h = sampler.heightAt(px, pz);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
      const slope = sampler.slopeAt(px, pz, SLOPE_BASELINE);
      if (slope > maxSlope) maxSlope = slope;
    }
  }
  return { maxSlopeDeg: maxSlope, heightSpread: maxH - minH };
}

/**
 * Site quality 0..1 for an arbitrary landing point (off-pad scoring,
 * ADR-0004 §3). 1 = flat and smooth, 0 = at/beyond the tip-over limits.
 */
export function siteQualityAt(
  sampler: TerrainHeightSampler,
  x: number,
  z: number,
  radius: number = 4
): number {
  const { maxSlopeDeg, heightSpread } = evaluateDisc(sampler, x, z, radius);
  const slopeTerm = Math.min(maxSlopeDeg / 12, 1);
  const spreadTerm = Math.min(heightSpread / (radius * 0.5), 1);
  return Math.max(0, 1 - 0.6 * slopeTerm - 0.4 * spreadTerm);
}

function discContainsRock(
  x: number,
  z: number,
  padRadius: number,
  rocks: RockNearby[],
  blockingDiameter: number
): boolean {
  for (const rock of rocks) {
    if (rock.diameter < blockingDiameter) continue;
    const dx = rock.x - x;
    const dz = rock.z - z;
    const clearance = padRadius + rock.diameter / 2;
    if (dx * dx + dz * dz < clearance * clearance) {
      return true;
    }
  }
  return false;
}

/**
 * Search candidate centers on expanding rings around (centerX, centerZ) and
 * return the best acceptable disc, or null when the area offers none
 * (caller should widen the search or move the center).
 */
export function findLandingPad(args: PadSearchArgs): PadSearchResult | null {
  const blockingDiameter = args.blockingRockDiameter ?? 1.0;
  const ringStep = Math.max(args.padRadius, 12);
  let best: PadSearchResult | null = null;

  const tryCandidate = (x: number, z: number): void => {
    if (discContainsRock(x, z, args.padRadius, args.rocks, blockingDiameter)) {
      return;
    }
    const { maxSlopeDeg, heightSpread } = evaluateDisc(
      args.sampler,
      x,
      z,
      args.padRadius
    );
    if (maxSlopeDeg > args.maxSlopeDeg || heightSpread > args.maxHeightSpread) {
      return;
    }
    const quality =
      1 -
      0.6 * (maxSlopeDeg / args.maxSlopeDeg) -
      0.4 * (heightSpread / args.maxHeightSpread);
    if (!best || quality > best.quality) {
      best = {
        x,
        z,
        y: args.sampler.heightAt(x, z),
        maxSlopeDeg,
        heightSpread,
        quality,
      };
    }
  };

  tryCandidate(args.centerX, args.centerZ);
  for (let r = ringStep; r <= args.searchRadius; r += ringStep) {
    // Enough candidates per ring that gaps stay below the ring step
    const count = Math.max(6, Math.ceil((2 * Math.PI * r) / ringStep));
    const phase = args.rng() * 2 * Math.PI;
    for (let i = 0; i < count; i++) {
      const angle = phase + (i / count) * 2 * Math.PI;
      const jitter = (args.rng() - 0.5) * ringStep * 0.5;
      const radius = r + jitter;
      tryCandidate(
        args.centerX + Math.cos(angle) * radius,
        args.centerZ + Math.sin(angle) * radius
      );
    }
    // Early exit: a high-quality pad close to the center wins outright
    if (best !== null && (best as PadSearchResult).quality > 0.7) {
      break;
    }
  }
  return best;
}
