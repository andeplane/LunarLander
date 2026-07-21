/**
 * Lander game tuning constants — single source of truth (ADR-0002..0004).
 * All units SI (meters, seconds, kilograms, radians unless suffixed Deg).
 */

export const LANDER_CONFIG = {
  /** Lunar gravity magnitude (must match PhysicsWorld) */
  gravity: 1.62,

  // --- Mass & engine (ADR-0002 §2/§3) ---
  /** Dry mass (structure + crew), kg */
  dryMass: 4000,
  /** Full fuel mass, kg (mission-1 ballpark; capacity scales per mission) */
  fuelMass: 2000,
  /** Max thrust sized for TWR ≈ 2.2 at full mass: m·g·2.2 */
  maxThrust: (4000 + 2000) * 1.62 * 2.2,
  /**
   * Fuel burn at full throttle, kg/s. Sized so hover (≈45% throttle) at
   * mean mass lasts ≈ 120 s: fuelMass / (0.45 × maxThrustBurn × 120)
   */
  maxBurnRate: 2000 / (0.45 * 120),
  /** Throttle lever step per keypress (5%) and slew rate per second held */
  throttleStep: 0.05,
  throttleSlewRate: 0.5,

  // --- Attitude control (ADR-0002 §1) ---
  /** Max commanded tilt from upright (radians), ~25° */
  maxTiltRad: (25 * Math.PI) / 180,
  /** Target-attitude slew rate limit (rad/s), ~60°/s */
  tiltSlewRate: (60 * Math.PI) / 180,
  /** Yaw rate command at full input (rad/s), ~60°/s */
  yawRate: (60 * Math.PI) / 180,
  /** PD natural frequency (rad/s): critically damped, ~0.6 s response */
  attitudeOmega: 6.0,
  /** PD damping ratio (1 = critical) */
  attitudeZeta: 1.0,

  // --- Geometry (placeholder primitives, ADR-0003 §2) ---
  /** Body box half-extents (x, y, z) */
  bodyHalfExtents: { x: 1.6, y: 1.1, z: 1.6 },
  /** Leg feet: distance from center (diagonal), foot radius, gear height */
  legRadialOffset: 2.6,
  legFootRadius: 0.25,
  /**
   * Vertical distance from body center to foot bottom. Must leave generous
   * belly clearance (gearHeight − bodyHalfExtents.y = 1.5 m) — rough
   * terrain under the hull box registers as body contact = instant crash,
   * and it must also clear the engine-bell visual (bottom ≈ −2.35).
   */
  gearHeight: 2.6,
  /**
   * Cockpit eye offset from body center — must stay INSIDE the hull box
   * (backface culling hides the hull from inside; the cockpit shell
   * provides the interior). An eye above the roof stares at the sunlit
   * hull top, which fills the frame with bloomed white.
   */
  eyeOffset: { x: 0, y: 0.55, z: -0.55 },
  /** Cockpit default downward view pitch (radians), ~20° */
  cockpitViewPitchRad: (20 * Math.PI) / 180,
  /** Lander-mode camera FOV (restored to 70 on exit) */
  cockpitFov: 75,

  // --- Touchdown grading thresholds (ADR-0004 §2, Apollo-derived) ---
  touchdown: {
    /** Good limits */
    goodVSpeed: 3.0,
    goodDrift: 1.5,
    goodTiltDeg: 12,
    goodSlopeDeg: 12,
    /** Perfect limits */
    perfectVSpeed: 1.0,
    perfectDrift: 0.5,
    perfectTiltDeg: 5,
    /** Hard-landing = up to hardFactor × the Good limits */
    hardFactor: 2.0,
    /** Body speed below this for stabilityTimeS ends the grading window */
    restSpeed: 0.2,
    stabilityTimeS: 1.0,
  },

  // --- Scoring (ADR-0004 §3) ---
  scoring: {
    touchdownGood: 500,
    touchdownHard: 200,
    softnessMax: 300,
    /** Softness ramps linearly from goodVSpeed (0 pts) to this (max pts) */
    softnessBestVSpeed: 0.5,
    precisionMaxOnPad: 300,
    precisionMaxOffPad: 200,
    fuelBonusMax: 300,
    instrumentsBonus: 100,
    hoverHoldMultiplier: 0.8,
    starThresholds: [600, 900, 1150] as const,
  },

  // --- HUD (ADR-0003 §4) ---
  hud: {
    /** Vertical-speed color bands (m/s down) */
    vspeedGreen: 2.0,
    vspeedAmber: 3.0,
    /** Readiness pips reveal below this AGL (m) */
    readinessRevealAGL: 15,
    /** Slow (10 Hz) update interval for non-critical readouts */
    slowUpdateIntervalS: 0.1,
  },

  /** localStorage namespace for high scores */
  storageKey: 'lander.highscores.v1',
} as const;

export type LanderConfig = typeof LANDER_CONFIG;
