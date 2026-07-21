# ADR-0002: Lander Flight Model and Control Scheme

- **Status**: Accepted (revised after adversarial review)
- **Date**: 2026-07-20
- **Deciders**: Anders Hafreager, Claude

## Context

The Lander mode must *feel fantastic* and avoid the classic failure of 3D
landers: players tumble, over-correct, and spin out of control. Research
across the genre (see Evidence) shows this failure mode killed Psygnosis
*Lander* (1999, "days to master", panned), is the documented entry barrier of
*Lunar Flight* ("quite challenging to keep the Lander stable", no assists),
and is why 6DOF games converged on auto-leveling. Meanwhile KSP players —
even hardcore sim players — essentially all land with SAS (rotation damping +
attitude hold) enabled, and FPV drones solved the same problem with "angle
mode" (stick = tilt angle, release = auto-level).

The game runs in a browser with keyboard on desktop and touch on mobile, on
top of the existing Rapier physics world (fixed 60 Hz timestep, lunar gravity
−1.62 m/s², heightfield terrain colliders).

## Decision

### 1. Real rigid-body physics, assisted attitude control ("angle mode")

The lander is a Rapier **dynamic rigid body** (compound collider: body box +
four legs) under real lunar gravity. All motion comes from forces/torques —
no kinematic cheating — so touchdown, bounces, and tip-overs are emergent.

But the *player never commands raw torque*:

- Input commands a **target tilt angle** (pitch/roll relative to local
  vertical), clamped to **25°** max tilt (drones cap ~45°; a lander wants
  tighter — at 25° you still get ~42% of thrust as lateral authority).
- A PD attitude controller (critically damped, commanded tilt reached in
  ~0.6 s — "snappy but not instant, feels like a machine, never a fight")
  applies torques each physics step to track the target.
- **Releasing input auto-levels to upright.** Hands-off = stable attitude,
  always. Tumbling is impossible in normal play.
- **Yaw is fully decoupled**, rate-commanded and rate-limited (~60°/s). Yaw
  never couples into pitch/roll; the horizon always behaves predictably —
  this kills the Descent-style disorientation trap.

Horizontal translation comes from tilting (tilt-to-translate, like a camera
drone) — an interaction model hundreds of millions of people already know.

### 2. Main engine: persistent throttle, TWR ≈ 2.2

- Single main engine thrusting along the lander's **local up** axis.
- **Throttle is a persistent lever (0–100%), never a momentary button.**
  Lunar Flight reviews: "precise thrust control is very difficult using the
  keyboard" — its one assist (thrust lock) generalized. Keys nudge the
  setting in 5% steps, holding slews it continuously.
- **Max thrust-to-weight ≈ 2.2 at full mass** (real LM ≈ 2.1). Hover sits
  near ~45% throttle — generous margin to arrest a botched descent without
  feeling twitchy. A tick mark on the throttle tape shows the current
  hover point (it drifts down as fuel burns).
- **Space** = full-throttle punch while held (returns to lever on release).
  **X** = cut to zero. Both act on the same lever model — one consistent
  input semantic everywhere (Eagle Lander 3D's mobile port was panned for
  mixing burst and continuous thrusters).
- **Hover-hold assist (H, toggle)**: auto-throttle that drives vertical
  speed to zero. The player descends by toggling it off (or nudging the
  throttle, which disengages the hold). It separates "learn to translate" from "learn to manage descent rate" —
  the single biggest beginner anti-frustration feature. Using it applies a
  score multiplier penalty (ADR-0004), so mastery is expressed through
  score, not survival.

### 3. Fuel

- Main engine burns fuel linearly with throttle. **Capacity is owned by
  ADR-0004's mission formula** (perfect-descent cost × margin); "≈ 120 s of
  hover" is only the mission-1 ballpark. Attitude RCS is free — charging
  fuel for the assist layer punishes the wrong thing.
- **Lander mass decreases as fuel burns**, modeled as a dedicated tank
  collider whose mass is lowered via `collider.setMass()` (Rapier recomputes
  body mass properties automatically). `setAdditionalMass` is explicitly
  ruled out — it contributes no angular inertia, which would silently void
  the "handling gets crisper as fuel burns" dynamic.
- Empty tank = engine out; attitude control keeps working.

### 4. Input mapping

Desktop keyboard — two-handed layout: left hand steers, right hand manages
power. **No modifier keys as primary controls**: in a browser, held-W +
Ctrl = Ctrl+W closes the tab (not preventable), Ctrl+S opens the save
dialog, and Ctrl+R collides with restart.

| Key | Action |
|---|---|
| W / S | Tilt target forward / backward (translate; release → auto-level) |
| A / D | Tilt target left / right |
| Q / E | Yaw left / right (rate, decoupled) |
| ↑ / ↓ | Throttle up / down (persistent lever, 5% steps, hold to slew) |
| ← / → | Yaw left / right (right-hand alternative) |
| Space | Full thrust while held |
| X | Cut throttle |
| H | Toggle hover-hold |
| C | Cycle camera: cockpit → belly cam (ADR-0003) |
| R | Restart mission |
| Esc | Pause menu |

Mouse is optional and **not required** (no pointer lock in Lander mode);
keyboard-only must be fully playable.

Touch (mobile browser) — **two virtual sticks, not device tilt** (HCI
research: touch sticks beat accelerometer on accuracy and preference; tilt
also fights holding the phone still to read instruments):

- **Right stick**: tilt target, angle-mode, release → auto-level.
- **Left vertical slider**: throttle lever — **custom sticky DOM slider,
  not a nipplejs joystick** (nipplejs sticks spring back on release, which
  is exactly wrong for a persistent throttle) — with a hover tick mark.
  The left thumb also owns the yaw paddles; leaving the throttle to yaw is
  acceptable *because* the lever is sticky.
- **Yaw paddles** (⟲ ⟳) above the throttle; large thumb-reachable
  **hover-hold button**; camera + restart buttons top corners.
- This is a separate `LanderTouchControls` component; the Explore
  `TouchControls` (movement joystick, look zone, speed presets) is
  hardwired to Explore semantics and is hidden in Lander mode, never
  reused.
- Device-tilt steering may come later as an *option* (rates high on
  engagement), never the default.

### 5. Expert mode (post-v1, decided now)

"ASSIST OFF" raw rate control with a score multiplier — Lunar Flight/KSP
prove the audience exists. Architecturally: the assist layer is a pure
function from (input state, body state) → (target attitude | raw rates), so
expert mode is a swap of that function, not a new controller. Not in v1.

### 6. Tuning & implementation notes

- All control math runs on the fixed 60 Hz timestep via the
  `PhysicsStepListener` hook (ADR-0001) — identical behavior across display
  refresh rates. Known limit: below ~12 FPS the fixed-step accumulator
  clamp drops wall time and the game runs in slow motion (the right trade —
  catch-up bursts would be worse). All gameplay timers (stability window,
  fuel) run on physics time so grading stays internally consistent; a
  future shared-seed leaderboard must account for this.
- **Forces are applied as per-step impulses** — `applyImpulse(F·dt)` /
  `applyTorqueImpulse(τ·dt)` in `beforePhysicsStep`. Rapier's
  `addForce`/`addTorque` are *persistent accumulators* that survive across
  steps; using them per-step double-integrates the controller's own output
  and produces exactly the spin-out this ADR exists to prevent.
- PD gains expressed as natural frequency / damping ratio (ζ = 1, ω sized
  for the ~0.6 s response) and converted to torques via the body's
  **effective angular inertia, re-read from Rapier each step** (cheap), so
  the ζ = 1 tuning tracks the fuel burn and reshaping the lander doesn't
  break the feel.
- Target-attitude changes are rate-limited (~60°/s) so the lander visibly
  *leans into* maneuvers instead of snapping.
- **CCD enabled** on the lander body (`enableCcd(true)`): crash-speed
  impacts (15–30 m/s ≈ 0.25–0.5 m per step) with small leg colliders
  against a thin heightfield can tunnel without it.
- No Rapier angular damping beyond the controller — the PD loop is the
  damping. 1–2° of simulated engine-gimbal wobble at high throttle for feel.

## Evidence (research summary)

- **Perilune**: procedural terrain, choose-your-own landing site, scoring by
  landing stress + site quality, replay system (its most-praised feature).
- **Lunar Flight** (Steam, Very Positive): cockpit sim, thrust lock is its
  only assist; documented frustration wall for newcomers.
- **Psygnosis Lander (1999)**: raw 3-axis manual attitude default → "days to
  master" → critical failure. The cautionary tale.
- **KSP SAS**: rotation damping + attitude hold is how everyone lands.
- **FPV drones**: angle mode (tilt-command, auto-level, tilt clamp) is the
  universal beginner default; acro (rate) is opt-in for experts.
- **6DOF genre**: "most 6DOF games feature auto-leveling"; modern entries
  auto-rotate to gravity when idle.
- **Apollo LM**: TWR ≈ 2.1, touchdown limits 3 m/s vertical / 1.5 m/s
  horizontal / 12° tilt — adopted as grading thresholds in ADR-0004.

## Alternatives considered

- **Raw rate/torque control as default**: rejected — the documented
  genre-killer. Returns later as expert mode.
- **Direct velocity control (arcade kinematics)**: rejected — kills the
  physicality (bounces, tipping, leg contacts) that makes landing
  satisfying; honest physics is cheap since Rapier is already integrated.
- **Yaw-and-thrust-only (helicopter) model**: less intuitive than
  tilt-to-translate and blocks the drift-killing skill axis.
- **Charging fuel for RCS**: punishes use of the assist layer that makes the
  game playable.
- **Device-tilt steering on mobile as default**: research says touch sticks
  win on accuracy and preference; tilt is a future option.

## Consequences

- Needs the `PhysicsStepListener` hook from ADR-0001.
- Attitude controller and throttle/fuel model are pure math — unit-tested
  (converges without overshoot, clamps at max tilt, auto-levels, hover-hold
  reaches zero vertical speed, fuel/mass bookkeeping).
- The assist layer defines the game's identity: approachable by default,
  mastery expressed through score multipliers rather than survival.
