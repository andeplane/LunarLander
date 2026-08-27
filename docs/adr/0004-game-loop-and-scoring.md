# ADR-0004: Lander Game Loop, Landing Zones, and Scoring

- **Status**: Accepted (revised after adversarial review)
- **Date**: 2026-07-20
- **Deciders**: Anders Hafreager, Claude

## Context

Atari Lunar Lander's loop has survived 45+ years: short runs (60–120 s),
score per landing scaled by softness and site difficulty, fuel as the
run-limiting resource. Perilune adds procedural terrain seeds,
choose-your-own landing sites scored by site quality, and graded landings
("stresses you put on the spacecraft"). Modern remakes that ramp difficulty
without assists (Lunar Lander Beyond) get panned for it. Apollo's real
touchdown limits (≤ 3.05 m/s vertical, ≤ 1.5 m/s horizontal, ≤ 12° tilt/
slope) happen to be gameplay-perfect grading thresholds.

We have infinite procedural terrain (seeded, deterministic), no hand-authored
levels, and both desktop and mobile targets.

## Decision

### 1. Mission structure: seeded descents

A **mission** = spawn state + designated pad, derived deterministically from
a mission seed (`alea`, same PRNG family as terrain):

- **Spawn**: ~300 m AGL, 400–800 m horizontal offset from the pad, modest
  initial velocity roughly toward it (10–20 m/s horizontal). Mission 1 is
  the tutorial approach: aimed straight at the pad in a steady ~15 m/s
  descent. From mission 2 on the descent rate is drawn per mission from
  3–18 m/s and the velocity is skewed off the pad bearing (up to ~0.2 rad
  on mission 2, approaching 1 rad later) so every mission needs its own
  plan rather than "hold the line and brake". The player starts *in* the
  problem; descent-to-touchdown ≈ 60–120 s.
- **Designated pad**: flattest 20 m disc found by grid-sampling terrain
  heights around a candidate point (slope + height-spread thresholds),
  marked by a terrain-conformed ring + vertical light beacon (ADR-0003).
  The search **rejects discs containing rocks ≥ 1 m** (rock placement is
  deterministic per chunk) and **biases away from craters smaller than
  ~2 physics cells (~6 m)**, which the physics heightfield aliases badly.
  Slope checks sample at a 1–2 m baseline from the true evaluator — never
  from the res-32 `getHeightAt` mesh, which smooths crater walls flat.
- **Landing anywhere is allowed** (Perilune's model): touching down safely
  off-pad scores on *site quality* (local slope/roughness) instead of the
  pad's accuracy + multiplier bonuses. Finding your own flat spot is real
  gameplay, not failure.

Retry re-seeds identically — mastery through repetition. "Next mission"
advances the seed and the difficulty parameters (§4).

### 2. Phases (state machine)

`Briefing → Flying → Touchdown | Crashed → Debrief`

- **Briefing**: one screen — mission goal, control reminders, [Launch].
  Instantly skippable (Enter/tap). Terrain around pad + spawn prefetches
  during it.
- **Flying**: full control. Terrain streaming and physics colliders already
  follow the camera, hence the descent.
- **Touchdown detection**: by **polling `world.contactPairsWith()`** on the
  leg/body colliders each fixed step — not Rapier's EventQueue, which would
  require new plumbing through `PhysicsWorld.step()` for no benefit (the
  1 s stability rule is a polling pattern anyway). Sequence: first leg
  contact opens the **grading window**; when all legs are in contact and
  body speed < 0.2 m/s for 1 s → grade. **Grading uses the worst values
  (max v↓, drift, tilt) over every leg-contact instant in the window**, so
  a bounce that re-hits at 3.5 m/s grades as that 3.5 m/s hit. Body-vs-
  terrain contact at any point, or tipping past the point of no return →
  **Crashed** immediately.
- **Grading is not pass/fail** (Apollo limits, hard-landing tier):

  | Grade | Conditions at contact |
  |---|---|
  | **Perfect** | v↓ ≤ 1 m/s, drift ≤ 0.5 m/s, tilt ≤ 5° |
  | **Good** | v↓ ≤ 3 m/s, drift ≤ 1.5 m/s, tilt ≤ 12°, slope ≤ 12° |
  | **Hard landing** | ≤ 2× the Good limits — survivable: gear damaged, score penalty, mission still completes |
  | **Crash** | beyond 2×, body contact, or tip-over |

- **Crash presentation**: no instant explosion — camera detaches to an
  external aftermath shot and the physics plays the slow, watchable tip/
  tumble out. (Feeds a future replay system.)
- **Debrief**: per-factor report card (v-speed, drift, tilt, accuracy/site
  quality, fuel, assists used), score, best-score comparison, then
  [Retry same mission] [Next mission] [Missions]. R restarts instantly at
  any time — quick restart is an anti-frustration feature, not a debrief
  option.
- **Mission select** (added 2026-08): entering the mode opens a grid of
  missions with the best stars/score per mission from local storage;
  everything up to (highest completed + 1) is unlocked, so earlier missions
  can be replayed for a better score. Esc from a briefing/debrief returns
  here; Esc here returns to the main menu.

### 3. Scoring (per landing)

| Component | Points | Notes |
|---|---|---|
| Touchdown (Good+) | 500 | Hard landing: 200 |
| Softness | 0–300 | Linear from 3 m/s → 0 down to ≤ 0.5 m/s → 300 |
| Precision | 0–300 | On-pad: distance from center (20 m → 0). Off-pad: site-quality (slope/roughness) capped at 200 |
| Fuel remaining | 0–300 | Proportional |
| Pad multiplier | ×1–×3 | Grows with mission difficulty (smaller/rougher pads), shown on the pad beacon (Atari's flashing multiplier) |
| Hover-hold used | ×0.8 | Assists cost score, never survival |
| Instruments-only | +100 | Never switched to belly cam (ADR-0003) |

**Order of operations** (one formula, unit-tested):

```
base  = touchdownPoints + softness + precision + fuelBonus   // max 1400
score = round(base × padMultiplier × assistMultiplier) + instrumentsBonus
stars = f(base)   // ≥600 ★, ≥900 ★★, ≥1150 ★★★
```

Stars are computed on `base` alone — multipliers and the instruments bonus
never affect stars, so assist users can still earn ★★★ by flying well and
pad multipliers reward risk with score, not stars. ★★★ at 1150/1400 ≈ 82%
of a perfect run is deliberate: three stars mean mastery.
High scores + best stars per mission index persisted in `localStorage`.

### 4. Difficulty ramp (parameterized, never authored)

Continuous functions of mission index: spawn distance/height and initial
velocity error up; fuel margin down; pad diameter 20 m → 10 m; chosen zones
get rougher surroundings (more/steeper crater terrain near the pad — *not*
rock density, see Consequences); pad multiplier up accordingly. **Fuel
capacity is owned by this formula**: capacity = (fuel cost of a reference
perfect descent for the mission) × margin factor (2.2 → 1.4). ADR-0002's
"≈120 s of hover" is the mission-1 ballpark only; the target descent
envelope is ~45–90 s. **Never ramp by degrading controls or removing
assists** — the researched failure mode of modern remakes.

### 5. Out of scope for v1 (recorded follow-ups)

Replay system (Perilune's most-praised feature — record body transforms per
step, cheap; high-value follow-up), daily shared seed + leaderboard, Atari
"fuel persists across landings" campaign mode, lander damage model beyond
the hard-landing flag, audio.

## Alternatives considered

- **Pads only, off-pad = failure**: rejected — Perilune shows site-choice is
  gameplay; off-pad landings score lower via site quality, which is
  punishment enough.
- **Free-landing only, no pads**: loses the accuracy skill axis and Atari's
  multiplier tension.
- **Hand-authored missions**: nothing to author on infinite proc-gen terrain.
- **Oxygen/time limit**: fuel already is the clock; a second clock adds
  anxiety, not depth.
- **Binary success/crash**: research says the survivable "hard landing"
  middle tier plus per-factor report card is what converts failure into
  learning.

## Consequences

- Compound collider needs per-part contact identification (leg vs. body) —
  Rapier collider-handle → part map.
- **Shared terrain height sampler**: extract a
  `sampleTerrainHeightAt(worldX, worldZ)` module reusing the exact worker
  pipeline (`createTerrainEvaluator` + `terrainDisplacementStrength` +
  `generateCratersForRegion`/`getCraterHeightModAt`, honoring the
  chunk-local vs. world coordinate split) used by the pad search — with a
  spec asserting it matches built-mesh vertices bit-for-bit. Cost is fine:
  ~10k samples ≈ 10–20 ms inside the Briefing screen.
- **Physics terrain resolution at touchdown**: chunks in physics range must
  have a mesh at/above the physics resolution cap requested (small
  ChunkManager guarantee), so heightfields never fall back to res-32
  (12.5 m cells) where small craters don't exist in physics. The residual
  visual-vs-physics offset (~0.3–0.5 m near small craters, cm on plains)
  is **accepted** for v1 — pad placement biases away from exactly the
  terrain that maximizes it.
- **Rocks are visual-only in v1** (no colliders anywhere in the codebase).
  Decision: the pad search excludes rock-occupied discs (deterministic
  placement makes this exact), site-quality scoring penalizes rocky areas,
  and difficulty ramps crater roughness instead of rock density. Off-pad
  landings may visually clip a boulder; rock colliders within physics range
  are the recorded follow-up.
- **Slow-motion floor**: below ~12 FPS the fixed-step accumulator drops
  wall time (game runs slow rather than bursting catch-up steps — the
  right trade). All gameplay timers run on physics time; note this gameable
  property before ever shipping a shared-seed leaderboard.
- Mission state machine, grading, and scoring are pure functions —
  unit-tested against threshold edge cases.
- `localStorage` persistence is namespaced (`lander.highscores.v1`).
