# ADR-0001: Game Mode Architecture and Main Menu

- **Status**: Accepted (revised after adversarial review)
- **Date**: 2026-07-20
- **Deciders**: Anders Hafreager, Claude

## Context

Lunar Explorer is currently a single-experience app: `main.ts` wires the Engine,
FlightController (free-flight camera), terrain streaming, celestial system, and
physics, and the user is immediately dropped into free flight. We want two
experiences behind a menu:

1. **Explore** — the current free-flight experience, unchanged.
2. **Lander** — a 3D lunar-lander game played from inside a lander cockpit,
   with real physics (Rapier), fuel, and landing objectives.

Constraints from the existing code:

- `Engine.update()` drives everything per frame; chunk streaming, terrain
  colliders, celestial updates, stats, and render-on-demand all read the raw
  `camera.position` / `camera.quaternion` properties — i.e. **local** space.
- Physics runs on a fixed 60 Hz timestep inside `PhysicsWorld.step()` with
  render interpolation and a subtle zero-step re-interpolation branch (see
  §3); forces must be applied per physics step, not per render frame.
- Rendering is on-demand (`needsRender` + camera-change detection + "physics
  objects moving" signal).
- World generation is expensive and identical in both modes.

## Decision

### 1. Three `GameMode`s, one shared world, always exactly one active

```ts
interface GameMode {
  enter(): void;   // install controllers, UI, spawn entities
  exit(): void;    // tear down mode-specific entities/UI, release input
  update(deltaTime: number): void; // per-frame logic (called by Engine)
}
```

- **`MenuMode`** — owns the main-menu DOM overlay *and* the slow idle camera
  drift behind it (the drift is what keeps render-on-demand alive in the
  menu). Being a mode makes the ModeManager invariant trivial: **there is
  always exactly one active mode**, from the first frame.
- **`ExploreMode`** — thin wrapper around the existing `FlightController` +
  TouchControls + pointer-lock behavior.
- **`LanderMode`** — owns the lander entity (physics body + meshes + cockpit
  camera rig), lander HUD, touch UI, and game-loop state (ADR-0004).

`ModeManager.switchTo(mode)` = `exit()` old → **full input reset** (held
keys, mouse/scroll deltas, *and* touch axes — `InputManager` gains a
`resetAll()` that also zeroes `touchMoveDirection`/`verticalInput`, which
`clearTransientState()` today does not) → `enter()` new. The Engine calls
`modeManager.update(dt)` in the slot where it currently calls
`flightController.update(dt)`.

**The world is shared and persistent**: scene, ChunkManager, RockManager,
CelestialSystem, PhysicsWorld, and TerrainColliderManager are created once in
`main.ts` and passed to the modes. Switching modes never rebuilds terrain.

### 2. The camera is never parented — modes copy world transforms into it

All streaming/collider/celestial/render-on-demand code keeps reading
`camera.position` directly, which is only correct if the camera stays at
scene root. Therefore:

- **The camera must never be `.add()`-ed to another object.**
- In Explore, FlightController writes the camera directly (unchanged).
- In Lander, `LanderMode.update()` computes the cockpit eye's interpolated
  world transform from the physics rig and **copies** it into
  `camera.position`/`camera.quaternion` every frame.

This also keeps `Engine.hasCameraChanged()` (which compares those same local
properties) working for free in all modes.

**Frame order**: `mode.update()` runs pre-physics (the current
FlightController slot). For the lander this means streaming/colliders see the
camera one frame behind the body, and the HUD reads post-step state on the
next frame. Both lags are accepted (≪ 1 m at gameplay speeds vs. ±800 m of
collider coverage) — do **not** reorder the Engine loop to "fix" this;
Explore's streaming-before-render contract depends on the current order.
After physics has stepped, `LanderMode`'s physics listener (§3) re-syncs the
camera to the freshly interpolated rig transform before rendering.

### 3. Physics gains a pre-step listener registry

`PhysicsWorld` currently hardcodes `ballManager`. It gains:

```ts
interface PhysicsStepListener {
  beforePhysicsStep(dtFixed: number): void; // apply forces, snapshot prev transform
  afterPhysicsSync(alpha: number): boolean; // sync meshes, return "still moving"
}
addPhysicsStepListener(l: PhysicsStepListener): void
removePhysicsStepListener(l: PhysicsStepListener): void
```

Contract (preserving `PhysicsWorld.step()`'s existing subtleties exactly):

- `beforePhysicsStep(dtFixed)` is called once per **fixed step**, before
  `world.step()`. (BallManager's zero-arg method gains the parameter.)
- `afterPhysicsSync(alpha)` is called on every frame where at least one fixed
  step ran, **and** on zero-step frames for every listener whose cached
  moving flag is set (the existing 120 Hz re-interpolation path). The moving
  flag is **per-listener** — a resting lander must not suppress
  re-interpolation of moving balls, nor vice versa. `PhysicsWorld.step()`
  returns the OR of the per-listener flags.
- `LanderMode.exit()` must `removePhysicsStepListener` and remove its rigid
  body; `enter()` re-registers. BallManager stays registered for app
  lifetime.

### 4. Menu and mode UI are plain DOM overlays

- **Main menu**: full-screen DOM overlay owned by MenuMode, shown when
  loading completes. `LoadingManager` gains an **`onComplete` callback** (it
  has none today; only polling exists) which `main.ts` uses to activate
  MenuMode. The 20 s watchdog can force-complete with no terrain ready —
  LanderMode independently guards against that (§6).
- **Pause**: `Esc` in LanderMode opens a pause overlay (Resume / Restart /
  Back to Menu). **Pause semantics**: ModeManager exposes `paused`; while
  paused, Engine skips `physicsWorld.step()` and `mode.update()` (rendering
  and stats continue), and on resume calls `FixedTimestep.reset()` so no
  catch-up burst fires. Explore gets a small on-screen "Menu" button instead
  (Esc already releases pointer lock there).

### 5. Input and UI ownership moves into modes

- **Pointer lock**: the canvas-click → `requestPointerLock()` handler and
  the "Press ESC to release mouse" hint move from `main.ts` into
  `ExploreMode.enter()`/`exit()`; `exit()` also calls
  `document.exitPointerLock()`. Known constraint: browsers impose a ~1 s
  cooldown on re-acquiring lock after Esc — acceptable.
- **TouchControls** (Explore joystick UI): stays a persistent instance owned
  by `main.ts`, gains `setVisible(bool)`; ExploreMode toggles it in
  `enter()`/`exit()`. LanderMode brings its **own** touch UI (ADR-0002) —
  the two are never visible together. Hiding UI mid-touch can swallow
  `touchend`, which is why `switchTo` always runs the full input reset (§1).
- **Space-to-shoot stays an advertised Explore feature** (not debug-flagged);
  it moves from `Engine.update()` into `ExploreMode.update()`. Because
  physics wiring arrives asynchronously (Rapier init), ExploreMode accepts a
  late `setBallManager` injection, same as Engine does today. LanderMode's
  `enter()` calls `ballManager.removeAllBalls()` so stray balls can't
  collide with the lander.
- Debug keys (O, I, C) remain Engine-level but are ignored while LanderMode
  is active; the `window.debug`/`setCameraPosition` console helpers are
  no-ops (warning) in Lander mode, since writes to `camera.position` would
  be overwritten by the rig sync anyway.
- **Explore camera pose is preserved**: `ExploreMode.exit()` saves camera
  position + pitch/yaw; `enter()` restores them and re-seeds
  FlightController (which caches pitch/yaw at construction and would
  otherwise snap the view back to a stale orientation).
- **Stats overlay**: Engine gains `setStatsVisible(bool)`. ModeManager shows
  it in Explore, hides it in Menu and Lander (HUD replaces it). The lil-gui
  shader panel (`ShaderUIController`) is likewise hidden outside Explore.

### 6. Lander spawn safety (collider readiness)

`TerrainColliderManager` silently skips chunks whose meshes aren't built;
balls tolerate this via kill-Y despawn, but a lander falling through terrain
is game-breaking. `LanderMode` therefore starts each mission with the body
**kinematic and frozen** during the Briefing screen (ADR-0004) and only
switches it to dynamic once terrain colliders exist under the spawn column
and the pad area (poll ChunkManager/collider presence). This also covers the
loading-watchdog degraded path: the Briefing simply waits, showing a
"preparing terrain" note.

## Alternatives considered

- **Separate pages/bundles per mode**: rejected — doubles load time,
  duplicates world bootstrapping, lets shared-world code drift.
- **Full ECS / scene-graph refactor**: over-engineering; three modes with a
  shared world need one small interface, not a framework.
- **Tearing down and rebuilding the world per mode**: rejected — terrain
  generation takes seconds; instant switching is a better experience.
- **True camera parenting with world-space reads everywhere**: rejected —
  touches five call sites plus render-on-demand semantics for zero benefit
  over copying the transform.

## Consequences

- `main.ts` shrinks to world bootstrapping + mode wiring; mode logic lives in
  `src/modes/{MenuMode,ExploreMode,LanderMode}.ts` + `ModeManager.ts`.
- `Engine` becomes mode-agnostic (no FlightController knowledge); gains
  `setStatsVisible`, pause-aware update, and drops the Space-to-shoot key.
- `PhysicsWorld` gains the listener registry; `BallManager` adopts the
  interface (existing interpolation/despawn behavior must remain
  bit-identical — covered by existing specs plus new listener-contract
  specs).
- Explore behavior stays functionally identical (camera pose save/restore
  included); existing FlightController tests keep passing.
- The physics listener hook is a prerequisite for ADR-0002.
