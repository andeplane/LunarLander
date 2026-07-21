/**
 * Shared types for the Lander game mode (ADR-0002..0004).
 */

/** Mission phase state machine (ADR-0004 §2). */
export type LanderPhase = 'briefing' | 'flying' | 'landed' | 'crashed' | 'debrief';

/** Landing grade tiers (ADR-0004 §2, Apollo-derived thresholds). */
export type LandingGrade = 'perfect' | 'good' | 'hard' | 'crash';

/**
 * Worst-case touchdown metrics accumulated over the grading window
 * (first leg contact → 1 s stability), plus flags needed for scoring.
 */
export interface TouchdownStats {
  /** Max downward speed at any leg-contact instant (m/s, positive down) */
  maxVerticalSpeed: number;
  /** Max horizontal speed at any leg-contact instant (m/s) */
  maxDriftSpeed: number;
  /** Max tilt from local upright at any leg-contact instant (degrees) */
  maxTiltDeg: number;
  /** Terrain slope at the touchdown point (degrees) */
  slopeDeg: number;
  /** Horizontal distance from pad center at rest (meters) */
  distanceToPadCenter: number;
  /** Rested within the pad radius */
  onPad: boolean;
  /** Local site quality for off-pad landings, 0 (rough) .. 1 (flat) */
  siteQuality: number;
  /** Fuel remaining, 0..1 */
  fuelFraction: number;
  /** Hover-hold assist was engaged at any point (score ×0.8) */
  usedHoverHold: boolean;
  /** Belly camera was used at any point (blocks instruments-only bonus) */
  usedBellyCam: boolean;
  /** Lander body (not legs) touched terrain */
  bodyContact: boolean;
  /** Tipped past the point of no return */
  tippedOver: boolean;
}

/** Per-factor score breakdown (ADR-0004 §3 formula, unit-tested). */
export interface ScoreBreakdown {
  grade: LandingGrade;
  touchdownPoints: number; // 500 good+, 200 hard, 0 crash
  softness: number;        // 0..300
  precision: number;       // 0..300 on-pad, 0..200 site-quality off-pad
  fuelBonus: number;       // 0..300
  /** base = touchdownPoints + softness + precision + fuelBonus (max 1400) */
  base: number;
  padMultiplier: number;   // ×1..×3, only applies on-pad
  assistMultiplier: number; // 0.8 if hover-hold used, else 1
  instrumentsBonus: number; // +100 if never used belly cam (good+ only)
  /** round(base × padMultiplier × assistMultiplier) + instrumentsBonus */
  total: number;
  /** Stars from base alone: >=600 ★, >=900 ★★, >=1150 ★★★ */
  stars: 0 | 1 | 2 | 3;
}

/** Deterministic per-mission parameters (ADR-0004 §1/§4). */
export interface MissionParams {
  /** Mission index (0-based); drives all difficulty scaling */
  index: number;
  /** Seed for this mission's PRNG streams */
  seed: number;
  /** Horizontal distance from spawn to pad (m) */
  spawnDistance: number;
  /** Spawn altitude above ground level (m) */
  spawnAltitudeAGL: number;
  /** Initial horizontal speed toward the pad (m/s) */
  spawnHorizontalSpeed: number;
  /** Initial descent rate (m/s, positive down) */
  spawnDescentRate: number;
  /** Bearing error of the initial velocity vs. the pad direction (radians) */
  spawnBearingError: number;
  /** Pad radius (m); shrinks with difficulty */
  padRadius: number;
  /** Score multiplier for landing on the pad */
  padMultiplier: number;
  /** Fuel capacity = perfectDescentCost × this margin factor */
  fuelMarginFactor: number;
}

/** Data the instruments HUD renders every frame (ADR-0003 §4). */
export interface LanderHudData {
  phase: LanderPhase;
  /** Radar altitude above terrain minus gear height (m); null = no return */
  altitudeAGL: number | null;
  /** Vertical speed (m/s, negative = descending) */
  verticalSpeed: number;
  /** Horizontal speed (m/s) */
  driftSpeed: number;
  /**
   * Direction of horizontal drift relative to the lander's heading, in
   * radians; 0 = drifting toward lander-forward, +π/2 = drifting right.
   */
  driftDirection: number;
  /** Throttle lever position 0..1 */
  throttle: number;
  /** Throttle needed to hover at current mass (tick mark), 0..1 */
  hoverThrottle: number;
  /** Hover-hold assist engaged */
  hoverHold: boolean;
  /** Fuel remaining 0..1 */
  fuelFraction: number;
  /** Burn time remaining at current throttle (s); null when throttle is 0 */
  fuelBurnTimeS: number | null;
  /** Attitude relative to upright (degrees) */
  pitchDeg: number;
  rollDeg: number;
  /** Distance to pad center (m) */
  padDistance: number;
  /**
   * Pad position in normalized screen coords (x,y in [-1,1], three.js NDC);
   * null when behind the camera. onScreen is true when inside the viewport.
   */
  padScreen: { x: number; y: number; onScreen: boolean } | null;
  /** Bearing to pad relative to lander heading (radians, for the edge arrow) */
  padBearing: number;
  /** Touchdown readiness pips; null above the 15 m AGL reveal altitude */
  readiness: { vspeed: boolean; drift: boolean; tilt: boolean } | null;
  /** Terrain under lander exceeds tip-over slope during final descent */
  slopeWarning: boolean;
}

/**
 * Input sink the keyboard controller and LanderTouchControls both feed.
 * Level inputs (tilt/yaw) are set every frame; edge inputs are one-shot.
 */
export interface LanderInputSink {
  /** Tilt target input, each -1..1 (x = right roll, y = forward pitch) */
  setTiltInput(x: number, y: number): void;
  /** Yaw rate input -1..1 (positive = turn left/CCW) */
  setYawInput(v: number): void;
  /** Absolute throttle lever 0..1 (touch slider) */
  setThrottleLever(v: number): void;
  /** Momentary full-thrust (Space / touch punch button) */
  setFullThrust(active: boolean): void;
  /** One-shot: cut throttle to zero */
  cutThrottle(): void;
  /** One-shot: toggle hover-hold assist */
  toggleHoverHold(): void;
  /** One-shot: cycle camera cockpit → belly */
  cycleCamera(): void;
  /** One-shot: restart mission */
  restart(): void;
}

/** Result summary shown on the debrief screen. */
export interface DebriefData {
  score: ScoreBreakdown;
  stats: TouchdownStats;
  missionIndex: number;
  bestScore: number | null;
  bestStars: 0 | 1 | 2 | 3 | null;
  isNewBest: boolean;
}
