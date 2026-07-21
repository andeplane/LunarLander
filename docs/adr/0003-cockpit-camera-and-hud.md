# ADR-0003: Cockpit Camera and HUD Instruments

- **Status**: Accepted (revised after adversarial review)
- **Date**: 2026-07-20
- **Deciders**: Anders Hafreager, Claude

## Context

The game is played from **inside** the lander. Cockpit view is atmospheric
but has a hard, historically real problem: in the final ~30 m the ground
below is invisible — Apollo crews landed blind on instrument callouts
(altitude + rate read aloud continuously). Research verdict: **do not
replicate authentic cockpit visibility** — it was only fun for actual
astronauts. Games solve it with instruments (drift indicator), in-world
markers (the LM's window-etched Landing Point Designator, gamified), and
alternate camera views.

A second, subtler problem: against a barren gray surface, players can't
perceive their own tilt without a fixed visual frame — cockpit struts are
load-bearing game design, not decoration.

## Decision

### 1. Camera rig

- **The camera is never scene-graph-parented to the lander** (ADR-0001 §2:
  every Engine consumer reads `camera.position` as local space). Each frame
  LanderMode computes the cockpit eye's world transform from the
  **render-interpolated** lander rig (the alpha-interpolated transform the
  physics listener produces — deriving it from the raw physics state
  instead would stutter on >60 Hz displays) and copies it into the
  scene-root camera. The eye offset sits near the top-front of the hull.
- Default view: forward, pitched **down ~20°** — horizon in the upper third,
  terrain filling most of the frame.
- FOV **75** (wider than realistic on purpose; research guidance 70–80°),
  set on `enter()` with `updateProjectionMatrix()` and restored to 70 on
  `exit()`. FOV feeds ChunkManager LOD selection, so this is a deliberate
  lander-mode LOD baseline, not just cosmetics.
- The camera inherits the body's full rotation — tilt is *felt*. Max
  commanded tilt is 25° (ADR-0002), so the view never disorients.
- **C cycles cameras: cockpit → belly cam.** The belly cam is the *same*
  camera moved under the hull looking straight down with the drift vector
  and pad overlay — a transform swap, **not** a second render pass (no perf
  cost, mobile-safe). Landing "instruments only" (never leaving the cockpit)
  earns a small score bonus (ADR-0004).
- **Glance control**: hold V to smoothly pitch the view further down toward
  the landing area; eases back on release. No free mouse-look in v1 — every
  input channel competes with flying during terminal descent.

### 2. Cockpit geometry (placeholder, but load-bearing)

Simple primitives forming:

- A **window frame**: struts around the screen edges + a horizontal sill —
  the fixed reference frame that makes tilt readable. Near-black interior
  with subtle panel glow so it reads in shadow (kept below bloom threshold).
- Exterior **legs visible in the lower corners** when glancing down — they
  double as touchdown depth cues.
- Exterior surfaces use `CurvedStandardMaterial` (same as balls) so the hull
  matches world curvature. A proper GLTF model swaps in later without
  touching the rig (model is a child of the physics-synced group).

### 3. In-world markers (the LPD, gamified)

Rendered in the 3D scene, not the DOM:

- **Landing-zone marker**: ring on the terrain at the pad + a vertical light
  beacon visible from spawn distance.
- **Velocity-impact marker**: a reticle projected on the terrain where the
  lander would touch down at current velocity — the in-world twin of the
  drift meter. KSP's retrograde marker and Lunar Flight's velocity camera
  both exist to answer exactly this question ("where am I actually going?").
- **All in-world markers use curvature-aware materials**
  (`CurvedStandardMaterial` or equivalent shader), positioned in flat world
  coordinates — the shader applies the same distance² / 2R drop as terrain.
  This is not optional: at the 800 m spawn offset the terrain is visually
  **64 m below** its flat-world height (R = 5000 m); a plain-material pad
  ring would float in the sky as the first thing every player sees. The
  beacon's height and emissive brightness budget must account for the drop
  and the 0.85 bloom threshold.

### 4. HUD (DOM overlay)

HTML/CSS overlay, hand-rolled like the rest of the UI. Priority order (first
five are non-negotiable):

1. **Vertical speed** — large, color-coded against touchdown limits
   (green < 2 m/s, amber < 3, red beyond). The number the game is about.
2. **Altitude AGL** — large numeric beside it, measured by a **Rapier
   downward ray cast** (`world.castRay`) against the physics colliders,
   minus gear height. Not `chunkManager.getHeightAt`: that raycasts the
   res-32 collision mesh (12.5 m cells, >1 m error near craters, and a
   pathological full-resolution fallback when the collision LOD isn't
   built) and would let the altimeter disagree with the surface the legs
   actually hit. The physics ray is O(1), always consistent with
   touchdown, and free of mesh dependencies. `getHeightAt` remains fine
   for coarse uses (pad-arrow distance).
3. **Drift indicator** — small circle with a dot showing lateral velocity
   direction/magnitude *relative to heading*, safe-radius ring at 1.5 m/s.
   The instrument that makes 3D landing learnable.
4. **Fuel** — bar + burn-time estimate at current throttle.
5. **Attitude indicator** — minimal artificial horizon; mostly confirmation
   (auto-level exists) but essential for feel and future expert mode.
6. **Throttle tape** — vertical bar with lever position + hover-thrust tick
   (drifts as mass falls) so players learn where "neutral" lives.
7. **Pad designator** — when the pad is off-screen, an edge arrow with
   distance readout points to it.
8. **Touchdown readiness strip** — three pips (V-speed / drift / tilt) that
   turn green when within limits below 15 m AGL. Passively teaches the
   success conditions; echoes Apollo's callout cadence.
9. **Slope warning** — flashes when terrain under the lander exceeds the
   tip-over slope (12°) during final descent.

HUD text updates are throttled to ~10 Hz except vertical speed/altitude
(every frame). Engine's stats/debug overlay is hidden in Lander mode.

### 5. Audio: out of scope for v1

No audio infrastructure exists in the repo. Noted as the highest-value polish
follow-up (throttle-scaled engine rumble; the Moon's silence otherwise).

## Alternatives considered

- **Chase/external camera as a gameplay view**: the brief demands cockpit
  play; belly cam covers the visibility problem. A free external camera
  appears only in the crash/landed aftermath (ADR-0004) and future replays.
- **Picture-in-picture belly camera inset**: a second render pass per frame —
  real cost on mobile. Full-frame camera swap gives the same information.
- **Full free mouse-look**: rejected for v1; glance key covers the need with
  zero input-channel cost.
- **In-scene 3D instrument panel**: more immersive, far more work, unreadable
  on small screens; DOM HUD ships first and can be re-skinned later.
- **Log-scale altitude tape**: nice, deferred — numeric + readiness pips
  cover v1.

## Consequences

- Camera modes are a small state machine inside LanderMode (cockpit / belly /
  glance blend / aftermath); Engine stays camera-agnostic.
- In-world markers need terrain height sampling per frame (Rapier ray for
  the impact reticle; `getHeightAt` acceptable for the distant pad ring)
  and must update before the render, after physics sync.
- **LanderMode calls `requestRender()` every frame while Flying and in the
  aftermath**: the beacon pulse, gimbal wobble, and marker animations move
  without camera/physics motion, and this engine renders on demand only.
  Do not "optimize" this away.
- Cockpit struts are **rigid** (no rotation lag): they are the fixed tilt
  reference — easing them against the horizon would blur exactly the
  signal they exist to provide.
- "Instruments-only" bonus requires tracking whether belly cam was used per
  attempt (trivial flag, read by ADR-0004 scoring).
