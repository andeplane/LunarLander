# Ideas & Improvement Backlog

A curated backlog for Lunar Explorer, produced from a code audit on 2026-08-27
(HEAD `90baef7`). Each item says what exists today (with `file:line`
pointers), what to change, and a rough effort: **S** ≈ hours, **M** ≈ 1–3
days, **L** ≈ a week+. Items are ordered by impact ÷ effort inside each
section.

Sections:

1. [Performance](#1-performance) — why the Mac runs hot, and what to do
2. [Visuals](#2-visuals) — shading, lighting, effects, models, HUD look
3. [Lander gameplay](#3-lander-gameplay) — mechanics, missions, feel
4. [Explore mode](#4-explore-mode)
5. [Platform, UX & infrastructure](#5-platform-ux--infrastructure)
6. [Suggested order of attack](#6-suggested-order-of-attack)

## Status (2026-08-27)

Shipped from this backlog, one PR each (all merged to `main`):

| Item | PR |
|---|---|
| P1 + P2 (+ V5) pixel ratio 1.25, MSAA on the composer target | #62 |
| P3 rocks drawn only from the active LOD level | #64 |
| P5 / V3 camera point light + flashlight off by default | #65 |
| P4 (frame cap half) 60 tick/s loop cap | #66 |
| P6 per-frame tight terrain bounding spheres | #67 |
| V1 micro-detail normals into the lighting (+ retuned strength/frequency) | #68 |
| P12 + P13 single texture path, const hex inverse, unrolled FBM | #69 |
| P8 finer-LOD prefetch limited to the 9 nearest chunks | #70 |
| P17 static chunk matrices | #71 |
| G4 fuel burn-time from effective throttle | #72 |
| G2 crash cause on debrief + live ASSIST ×0.8 tag | #73 |
| G1 touch parity: BURN, pause, glance | #75 |
| G3 pad multiplier on the beacon | #76 |
| V19 cockpit vibration / touchdown jolt / FOV kick | #77 |
| G7 mission select, orbit camera, LM model (parallel work) | #63 |
| G11 lander audio (parallel work) | #74 |

Still open from the P0/P1 tiers: P7 (sub-tile LOD0/1), P9 (rock draw
calls / `BatchedMesh`), P10–P11, P14–P16, P18–P23, V2, V4, V6–V11.

---

---

## 1. Performance

### Why the Mac runs hot — the short version

Three things compound: **(a)** the GPU shades ~7.7 M fragments per frame
(Retina pixel ratio 2 → full-res HalfFloat composer → bloom) with a heavy
per-pixel procedural shader lit by four lights; **(b)** the scene submits
2–5× more triangles than are visible (rocks from every built LOD level drawn
at once, frustum culling defeated by 1.3 km bounding spheres, 2 M-triangle
chunks); **(c)** 7–8 worker threads continuously rebuild 1-million-vertex
LOD0 chunks that are prefetched but never shown. On a 120 Hz panel all of
this runs at 120 fps — even on the menu screen.

Numbers below are derived from the configured constants (`renderDistance
10`, 400 m chunks, LOD grid `[1024…4]`, 4 px LOD threshold, 30 rock
prototypes): 317 loaded chunks; LOD0 = 1,050,625 verts / 2.1 M tris / ~50 MB
per chunk; ~164 rocks per near chunk at 5,120 tris each.

### P0 — one-liners with the biggest thermal payoff

| # | Idea | Where | Expected |
|---|------|-------|----------|
| P1 | **Cap `setPixelRatio` at 1.0–1.25** (or dynamic: 1.0 while the build queue is non-empty / while moving). | `Engine.ts:75-79` | 2.5–4× less fragment work + RT bandwidth. Likely the single biggest heat source on Retina. |
| P2 | **`antialias: false`.** The scene renders into the composer's non-MSAA target; the MSAA canvas only receives the final quad, so you pay the 4× allocation + resolve for nothing. Add `SMAAPass` or `renderTarget.samples=4` instead (see V5). | `Engine.ts:75` | Frees ~250 MB, removes a per-frame resolve. |
| P3 | **Hide rocks of non-active LOD levels.** `Chunk.setLodLevel()` toggles `visible` only on terrain meshes; rock `InstancedMesh`es from every retained level (≈5 per near chunk) stay visible, so the same rock is drawn 2–5×. Set `rockMesh.visible = (level === current)`. | `Chunk.ts:160-175`, `ChunkManager.ts:671-715` | Rock triangles and draw calls ÷2–5, no visual change. |
| P4 | **Frame cap.** Unthrottled rAF → 120 updates + renders/s on ProMotion; Menu and Lander call `requestRender()` every frame by design. Skip ticks to hold 60 (30 while idle/menu); skip `chunkManager.update` when `hasCameraChanged()` is false. | `Engine.ts:348-363, 371-490` | Halves everything on 120 Hz displays; menu idle → near zero. |
| P5 | **Remove the camera point light and flashlight** (4 lights → 2). `MeshStandardMaterial` evaluates full GGX per light per fragment; the 5 cd point and 10 cd spot are invisible against a 5-intensity sun anyway. | `CelestialSystem.ts:306-370` | ~40 % of lighting ALU; smaller program. (Same change as V3.) |

### P1 — culling and geometry

| # | Idea | Where | Expected |
|---|------|-------|----------|
| P6 | **Tight per-frame terrain bounding spheres.** Each chunk's sphere is inflated once at creation for the worst-case curvature drop (~2 km) → ~1.3 km radius, so the 2 M-tri chunk *behind* you is never culled. Rocks already do this right (`RockManager.updateCullingBounds`); do the same for terrain from `curvatureDropRange`, 317 sphere rewrites/frame. | `TerrainGenerator.ts:61-82`, `curvatureBounds.ts:64-71` | 30–50 % fewer terrain tris when looking horizontally. |
| P7 | **Sub-tile LOD0/LOD1.** 400 m monoliths can't be culled while you stand on them. Split the two finest levels into 4×4 index groups (`geometry.groups`) or sub-meshes sharing the position buffer. | `TerrainGenerator.ts`, `ChunkWorker.ts:764-782` | 60–75 % of the chunk under the camera becomes cullable. |
| P8 | **Drop the `desired−1` prefetch** (or gate it at 1.3× the LOD0 distance). It builds LOD0 (1 M verts, 1–3 s of worker CPU, 50 MB) for every chunk within 135 m although LOD0 is only shown within 67 m, then evicts it. Also consider `LodDetailLevel.Performance` (8 px) as the default on laptops/mobile. | `ChunkManager.ts:575-593, 758-792` | Worker CPU several× lower; bounds retained LOD0 count (memory). |
| P9 | **Rock draw calls and tessellation.** One `InstancedMesh` per prototype × chunk × level → ~1,500–2,500 meshes, 1,000+ draw calls mostly of 1–2 instances; the screen-size test uses the whole-chunk sphere so a lone 4.5 m rock 3 km away (≈1 px) is still drawn; 0.75 m rocks get 5,120 tris. Use `THREE.BatchedMesh` per chunk-level (all prototypes in one draw call, `perObjectFrustumCulled`), pass per-placement max diameter from the worker for the size test, and drop detail 15→7, 10→5, 7→3. | `RockManager.ts:110-127, 351`, `ChunkManager.ts:707-711` | Draw calls ÷10–30, rock triangles ÷5–7. |

### P2 — shader cost (`MoonMaterial`, on most screen pixels)

| # | Idea | Where |
|---|------|-------|
| P10 | `simplexNoise(terrainPos*0.005)` — a ~200 m-wavelength signal evaluated per pixel. Move to the vertex shader (varying) or a lookup texture. | `MoonMaterial.ts:371` |
| P11 | `snoise3D(vWorldPosition*2.0)` — a full 3D simplex per fragment for ±0.15 brightness jitter. Replace with a channel of the detail texture. | `MoonMaterial.ts:413`, `glsl_common.ts:45-107` |
| P12 | Micro-normal FBM: 4 octaves × `noised2D` with a *uniform* loop bound (`for(i<8){if(i>=octaves)break;}`) → no unrolling. Make octaves a `#define`, drop to 2–3, or bake to a normal map (pairs with V9). | `MoonMaterial.ts:389-407`, `glsl_common.ts:159-202` |
| P13 | Hex tiling always runs **both** the plain sample and the 3-tap hex path + `meanColor` + `dFdx/dFdy` + a per-fragment `inverse(M0)` of a constant, then `mix`es by a camera-height uniform. Make it a uniform branch (1 tap < 5 m, 4 taps > 10 m), `const` the inverse, anisotropy 16 → 8. | `MoonMaterial.ts:425-445`, `glsl_common.ts:230-288`, `main.ts:302` |
| P14 | Custom Fresnel + Blinn specular duplicate the PBR specular already computed; fold into one term (or replace with V12's regolith lobe). | `MoonMaterial.ts:521-582` |
| P15 | If bloom stays, feed it a half-res copy (its only intended sources are the sun and the pad beacon); or drop the composer and use a sprite glow on the sun. | `Engine.ts:94-115` |

### P3 — main-thread churn, hitches, memory

| # | Idea | Where |
|---|------|-------|
| P16 | `ChunkManager.update()` per frame: 317 `{key,distance}` objects + strings + sort, `new Set`s, `cameraPosition.clone()`; `getLodLevelForChunkOptimized` called 3× per chunk with `parseGridKey` (`split(',').map(Number)`) each time → ~950 array allocs/frame; `evictStaleLodLevels` allocates per chunk. Cache `[gridX,gridZ]` on the `Chunk`, compute desired LOD once, keep `nearbyKeys` until the camera changes grid cell. | `ChunkManager.ts:474-492, 542-598, 652, 758-792`, `LodUtils.ts:117-120` |
| P17 | `matrixAutoUpdate = false` on `Chunk.lod` and its meshes; `updateCullingBounds` should read `lod.position` instead of `updateWorldMatrix(true,false)` on ~2 k meshes/frame; `scene.updateMatrixWorld()` recomposes ~5 k static objects per frame. | `RockManager.ts:444-467`, `Chunk.ts` |
| P18 | `getHeightAt` fallback picks the **finest** built mesh → a JS raycast over up to 2 M triangles when the collision LOD isn't ready. Prefer the coarsest built level (or a BVH). | `ChunkManager.ts:848-871`, `TerrainGenerator.ts:216-235` |
| P19 | Chunk-arrival hitches: `computeBoundingSphere()` on 1 M verts on the main thread, then a 50 MB `bufferData` upload + up to 30 `InstancedMesh` builds in one frame. Compute the sphere in the worker; stagger heavy uploads one per frame. | `TerrainGenerator.ts:58`, `ChunkManager.ts:215-270` |
| P20 | Worker allocation waste: `PlaneGeometry` allocates uv + index that are discarded (~59 MB per LOD0); `displaceY` goes through `BufferAttribute` accessors for 3 M calls; crater array copied per build; craters aren't culled per row. Write directly into `Float32Array`s, precompute `maxInfluence²`, add a generation token so stale builds early-exit. | `terrain.ts:134-139`, `displacements.ts:15-23`, `ChunkWorker.ts:695-817` |
| P21 | `ChunkRequestQueue.sort` re-prioritises every queued request (with string splits) whenever the camera moves ≥1 mm. Throttle to grid-cell changes. | `ChunkRequestQueue.ts:213-254` |
| P22 | GPU memory: 8k×4k skybox ≈ 179 MB RGBA + mips (use 4k, `generateMipmaps=false`, or KTX2); Earth 45 MB; composer RTs ~120 MB; MSAA canvas ~250 MB; 4–9 retained LOD0 chunks ≈ 200–450 MB plus CPU copies. | `CelestialSystem.ts:267-303` |
| P23 | Small GC items: `new THREE.Euler()` ~3×/frame in `LanderBody`/`LanderMode`, `RAPIER.Ray` per frame in `raycastAltitudeAGL`; `powerPreference: 'low-power'` for dual-GPU Intel Macs. | `LanderBody.ts`, `LanderMode.ts:572`, `Engine.ts:75` |

### Already good — don't redo

Render-on-demand works in Explore (idle ≈ 2 fps); worker transfer uses
transferables both ways; `ChunkRequestQueue` dedupes and lazily sorts; rock
culling bounds are tightened per frame; edge stitching is cached and a no-op
when unchanged; physics uses a fixed timestep with catch-up cap and only 25
heightfields; `MoonMaterial` never recompiles; hot loops in
`FlightController`/`CelestialSystem`/`RockManager` use scratch vectors; the
HUD writes DOM only on quantised change.

### Add a quality preset

Expose `{pixelRatio, lodDetail, rockDetail, bloom, antialias}` as
Low/Medium/High in the settings screen (section 5) and auto-pick from
`devicePixelRatio`, `hardwareConcurrency` and a 2-second startup frame-time
probe. Mobile should default to Low.

---

## 2. Visuals

### What renders today

- Renderer: `WebGLRenderer({antialias:true})`, pixel ratio ≤ 2, ACES tone
  mapping, `RenderPass → UnrealBloomPass(0.5, 0.4, 0.85) → OutputPass`
  (`src/core/Engine.ts:76-114`). Bloom is full-screen (the
  `sunMesh.layers.enable(1)` at `CelestialSystem.ts:205` is vestigial). No
  shadows, fog, SSAO, grain, vignette, lens flare or camera shake anywhere.
- Lights: sun `DirectionalLight` 5.0 (`CelestialSystem.ts:328`), earthshine
  0.75 (`:340`), **plus an always-on point light glued to the camera**
  (`:347-355`) **and an always-on spotlight "flashlight"** (`:358-370`) —
  even inside the cockpit. Camera-attached lights flatten all relief.
- Terrain: `MeshStandardMaterial` (roughness 0.9, metalness 0.1) with a
  planar-XZ-projected albedo texture + Neyret hex tiling
  (`src/shaders/MoonMaterial.ts:353-486`). The procedural mare/highlands and
  crater-floor tinting is computed and then **thrown away** when the texture
  is present (`:425-445`). Derivative-FBM micro-normals are computed but
  **never fed into Three's lighting** (`:488-493`) — only into the custom
  rim/spec terms.
- Craters: bowl + bell rim only (`src/terrain/craters.ts:294-334`); no
  ejecta, rays, terraces or albedo change. LOD swaps are instant
  (`ChunkManager.ts:660`) → pops.
- Rocks: 30 icosphere prototypes, all `scale [1,1,0.7]` pebbles
  (`RockBuilder.ts:240`), sharing the terrain material, hard 4 px visibility
  cut (`ChunkManager.ts:669-717`).
- Sky: 8k Milky Way on a 90 km sphere through ACES+bloom (JPEG noise floor
  shows as gray). Sun: limb-darkened disc + corona, no flare/glare/occlusion.
  Earth: day/night/clouds/specular shader, flat orange twilight, no limb halo.
- Lander (`src/lander/LanderVisuals.ts`): box hull, skirt, 4 struts, bell;
  cockpit is 9 unlit black planes + a blue "panel glow" plane. No plume, no
  dust, no shadow, no footprints.
- HUD: modern glass panels, CSS attitude ball (`LanderHUD.css`).

### Ideas

#### P0 — unlock what's already coded (all **S**)

| # | Idea | Where |
|---|------|-------|
| V1 | **Feed micro-detail normals into real lighting.** Override `#include <normal_fragment_begin>` so `normal = normalize((viewMatrix * vec4(worldNorm,0)).xyz)`. Flat plains become visible regolith for free. | `MoonMaterial.ts:389-407, 488-493` |
| V2 | **Stop the texture from erasing procedural albedo.** Use the texture as a luminance-detail layer: `final = procedural * (texLum / meanLum)` instead of `mix(nonHex, hex, f)`. Restores mare/highlands + crater-floor darkening; prerequisite for ejecta/dust-apron albedo. | `MoonMaterial.ts:425-445` |
| V3 | **Kill the camera point light + flashlight by default** (keep as debug toggles). Sun + earthshine alone give the high-contrast Apollo look. Also part of the perf fix (two fewer lights in every fragment). | `CelestialSystem.ts:347-370` |
| V4 | **Sky black level + bloom isolation.** `skybox.toneMapped=false`, darken the star texture floor, raise bloom threshold to ~1.0 and give the Sun material headroom (3 → 8); optionally render layer 1 selectively. | `CelestialSystem.ts:247-314`, `Engine.ts:96-114`, `SunMaterial.ts` |
| V5 | **Anti-aliasing after the composer.** `composer.renderTarget1/2.samples = 4` or add `SMAAPass`. Crater rims and struts currently crawl. | `Engine.ts:96-114` |

#### P1 — big wins

| # | Idea | Effort |
|---|------|--------|
| V6 | **Lander shadow.** `renderer.shadowMap.enabled`, sun `castShadow` with a ±15 m ortho frustum following the rig, lander meshes cast, only nearby chunks receive. Gives ground contact and an altitude cue. Blob-shadow decal fallback for mobile. | M |
| V7 | **Engine plume + bell glow + under-lander light.** Additive cone shader scaled by effective throttle; `emissive` on the bell; `PointLight` under the bell (range ~25 m) so the ground lights up on descent — the thing the player sees from the cockpit. | M |
| V8 | **Dust kick-up.** GPU `Points` (2–4 k) spawned at plume/terrain intersection below ~15 m AGL; straight ballistic arcs (no atmosphere), sharp cutoff, burst on touchdown. Plus a cheap radial "dust sheet" sprite whose opacity ∝ thrust / AGL². | M |
| V9 | **Triplanar detail + real normal map.** Add a regolith normal (+roughness) texture; triplanar by `abs(worldNorm)^4`; hex-tile only the Y projection. Fixes stretched streaks on rock sides and crater walls. | M |
| V10 | **Crater ejecta, rays, rim boulders.** Ejecta blanket `h ∝ rimH·(R/r)^3` to ~3R; per-vertex `ejecta` attribute → brighter albedo + radial ray streaks for the freshest ~10 %; bias rock density by `1+4·ejecta` so boulders cluster on rims. | M |
| V11 | **Horizon relief.** A gated ridged-noise mountain octave (freq ~4e-4, 80–200 m) plus a far "massif" silhouette impostor ring in the celestial container so the skyline is never a flat line. | M |

#### P2 — polish

| # | Idea | Effort |
|---|------|--------|
| V12 | **Regolith BRDF.** Replace fresnel rim + Blinn spec with a Lommel-Seeliger/Hapke-lite lobe incl. opposition surge (the bright halo around the antisolar point in every Apollo photo). `metalness 0`, `roughness 1`, drop `brightnessBoost`. | M |
| V13 | **Sun lens flare + veiling glare** (`three/addons/objects/Lensflare`), occluded by terrain via depth test; anamorphic streak when the sun is in the window. | S/M |
| V14 | **Earth polish.** Separate rotating cloud shell with shadowing, fresnel atmosphere limb (blue → orange at the terminator), gamma on city lights, scale earthshine intensity by illuminated fraction. | S/M |
| V15 | **LOD pop mitigation.** 0.3 s dithered crossfade between old/new chunk LOD meshes; distance-based dithered fade for rocks instead of the 4 px cut. | M |
| V16 | **Ambient occlusion.** Cheap: per-vertex horizon AO baked in `ChunkWorker` into an attribute, multiplied into `diffuseColor`. Craters get depth. (Or `GTAOPass`, costlier.) | S / M |
| V17 | **Cockpit fidelity.** Extruded window bezels, instrument boxes with emissive `CanvasTexture` faces mirroring the HUD, glass pane (`MeshPhysicalMaterial` transmission + scratch alphaMap), lit `MeshStandardMaterial` panels so sunlight sweeps in as you tilt, warm panel `PointLight`. | M |
| V18 | **HUD retro skin.** Seven-segment/monospace font, phosphor green/amber, faint scan lines + vignette, inset bezels, real 8-ball with pitch ladder, "1202 PROGRAM ALARM" style flash on hard states. | S/M |
| V19 | **Camera feel.** Perlin rotational jitter ∝ throttle (0.1–0.3°), FOV +1–2° at full throttle, vertical jolt on leg contact. | S |
| V20 | **Touchdown decals.** Scorch ring under the bell + 4 pad prints (`CurvedStandardMaterial`, polygonOffset). | S |
| V21 | **Rock variety.** Angular / rounded / slab families, per-instance aspect 0.7–1.4, rare fractured boulder, burial fillet darkening near ground plane. | S/M |
| V22 | **Film grain, hot pixels, vignette** post pass (Lander mode only, must `requestRender` per frame). | S |
| V23 | **Menu & loading presentation.** Frame Earth low on the horizon with the sun off-screen, slow dolly, letterbox; starfield loading screen. | S |

Implementation cautions: render-on-demand means every animated effect must
call `requestRender()` (`Engine.ts:476-481`); anything near the lander must
use curvature-aware materials or it floats ~64 m at 800 m offset; the shadow
depth pass uses `MeshDepthMaterial` (uncurved), so keep shadow frusta small.

---

## 3. Lander gameplay

### What exists today

- Endless mission ramp: `missionParamsForIndex(i)` (`src/lander/mission.ts:64-99`)
  asymptotically ramps spawn distance 500→800 m, altitude 300→400 m, h-speed
  12→20 m/s, pad radius 10→5 m, multiplier ×1→×3, fuel margin 2.2→1.4. Fuel =
  analytic perfect-descent Δv × margin, cap 2000 kg.
- Pad search rejects rocks ≥1 m, slope >6°, height spread >2.5 m
  (`padSearch.ts:128-181`). Rocks have **no colliders**.
- Phases `briefing → flying → landed|crashed → debrief`; hull contact or
  tilt >60° = crash; grade Perfect/Good/Hard/Crash on v↓ / drift / tilt
  (`scoring.ts:43-65`); score = touchdown + softness + precision + fuel, ×pad
  multiplier, ×0.8 if hover-hold was ever touched, +100 instruments-only.
- Highscores: `localStorage['lander.highscores.v1']` best score/stars per
  mission. `enter()` always jumps to `highestCompleted+1`
  (`LanderMode.ts:165`) — no mission select, no replay of earlier missions.
- Flight model: TWR 2.2, 25° tilt clamp with auto-level, yaw 60°/s, PD ω=6,
  hover-hold is a P-only controller (`engineModel.ts:43-52`).
- Cameras: cockpit (FOV 75, 20° down), V glance, C belly cam, fixed crash
  aftermath shot. HUD: v-speed, radar alt, drift scope, attitude ball,
  throttle/fuel tapes, pad diamond, readiness pips, slope warning; in-world pad
  ring + beacon + ballistic impact reticle.
- **No audio, no haptics, no gamepad, no settings, no tutorial beyond a
  controls table.**

### Half-done / inconsistent (cheap fixes, all **S**)

| # | Issue | Where |
|---|-------|-------|
| G1 | Touch has **no full-thrust button** (`setFullThrust` exists but is never wired), **no pause**, **no glance**. Pause hint says "Esc" on phones. | `LanderTouchControls.ts`, `types.ts:137-138`, `LanderScreens.ts:147` |
| G2 | Crash reason only `console.log`'d; debrief just says CRASHED. Hover-hold ×0.8 penalty is silent and sticky after one accidental tap. | `LanderMode.ts:516`, `engineModel.ts:65-68`, `LanderScreens.ts:253-330` |
| G3 | Pad multiplier promised "on the beacon" (ADR-0004 §3) is only on the briefing. | `MissionMarkers.ts:90-94` |
| G4 | Fuel burn-time readout uses the lever, not effective throttle → wrong under hover-hold / Space. | `LanderMode.ts:622-625` |
| G5 | Impact reticle ignores thrust; HUD doesn't say it's "engine-out impact point". | `MissionMarkers.ts:117-156` |
| G6 | `R` restart double-wired in controls and screens. | `LanderControls.ts:82`, `LanderScreens.ts:243-246` |

### Ideas

#### Tier 1 — structure & feedback

| # | Idea | Effort |
|---|------|--------|
| G7 | **Mission select + progression map.** List missions 0..highest+1 with best score/stars; unlock N+1 at ≥1★ on N; persist `lastPlayedMission`. | S/M |
| G8 | **Descent-rate guidance (P66-style).** Show a target-rate band on the v-speed readout (`h>100: −10, 50: −5, 15: −2, 5: −1`), plus a **rate-of-descent hold** assist (↑/↓ nudge target v_y) as a middle step between hover-hold (×0.8) and manual (×1.0) — score ×0.9. Altitude callouts as HUD text ("100… 50… 30… contact"). | M |
| G9 | **Landing radar / site scan.** Below 40 m, evaluate a 3×3 grid of `siteQualityAt` around the impact point at 10 Hz; tint the reticle green/amber/red; show "SITE 78 %". | M |
| G10 | **Crash replay + ghost of your best run.** 60 Hz ring buffer of (t, pos, quat, throttle) in `LanderBody.beforePhysicsStep`; "Watch replay" with an orbit camera; store best run at 10 Hz and render it as a translucent second `LanderVisuals` next attempt. | M (+M ghosts) |
| G11 | **Audio.** WebAudio filtered-noise engine rumble following effective throttle, RCS ticks on PD torque spikes, touchdown thud on first leg contact, pip beeps, altitude callouts. Unlock on the LAUNCH click. | M |

#### Tier 2 — difficulty & hazards

| # | Idea | Effort |
|---|------|--------|
| G12 | **Difficulty tiers / expert mode.** `DifficultyProfile {assist:'angle'|'rate', hoverHoldAllowed, fuelMarginScale, night, boulderField}`; rate mode = no auto-level, no 25° clamp; expert ×1.5 score. Stored per `"index:profile"`. | M |
| G13 | **Low-sun / night landings.** Sun elevation is hard-coded at 63° (`CelestialSystem.ts:84`). Per-mission seeded sun angle: long shadows make terrain readable *and* put pads in crater shadow; night tier = earthshine only + a lander-mounted landing light. | M |
| G14 | **Rock colliders near the lander + boulder-field tier.** Static Rapier colliders for rocks ≥0.5 m within ~150 m (rebuild on >75 m moves); hull-vs-rock = crash via the existing contact path; boulder tier lets 1–2 m rocks inside the pad. | M/L |
| G15 | **Damage model.** Hard landing marks 1–2 legs damaged (remove foot collider, tilt the strut); persists into hop missions. | S/M |
| G16 | **Orbital start / braking burn + abort-to-orbit.** Optional high-gate phase from 2–3 km / 50–80 m/s; abort = new phase with partial credit. Mostly larger `RAMPS` values. | M |

#### Tier 3 — replayability

| # | Idea | Effort |
|---|------|--------|
| G17 | **Hop missions / multi-leg campaign.** After a Good+ landing: "40 % fuel left — fly 600 m to pad B"; fuel persists, scores sum. | M |
| G18 | **Daily seed + shareable seeds** (`missionParamsForIndex` already takes a seed) and, later, a server leaderboard (Cloudflare KV / Supabase; reject runs whose physics/wall-clock ratio is off — see ADR-0004 §6). | M / L |
| G19 | **Landed → EVA.** "Step outside" hands off to `ExploreMode` with a walk preset (2 m/s, 1.7 m eye height, 1.62 m/s² hop); keep the lander rig in the scene; sample collection by raycast-tapping rocks. | M (+M samples) |
| G20 | **Tutorial mission 0.** Spawn 60 m over a 20 m pad at rest with hover-hold on and no penalty; state-driven prompts ("press ↓ until v-speed reads −2"). | M |
| G21 | **Photo mode** from the pause menu: orbit camera, hide HUD, `toBlob()` save. | S/M |
| G22 | **Profile & stats.** attempts, crashes, fuel burned, best softness, last 20 breakdowns; `.v2` key with migration. | S |
| G23 | **Log-scale altitude tape** (deferred in ADR-0003). | S |

---

## 4. Explore mode

- **Speed-aware feel.** Radial speed-line vignette or faint streak particles
  above ~half max speed; subtle FOV widening with speed. **S**
- **Points of interest.** Seed a few named landmarks (a large crater with a
  central peak, a boulder field, a rille) and a compass/waypoint HUD to fly
  to them; "discover" them for a checklist. **M**
- **Walk mode.** Same walk preset as G19, toggled from the Explore panel —
  standing on the surface is a different experience from flying at 50 m/s. **S/M**
- **Replace red physics balls** with something lunar — throw rocks, or a
  "sample probe" — and give them dust puffs on impact. **S**
- **Time-of-day slider** in the lil-gui panel (once G13's `setSunAngles`
  exists) — the fastest way to see how much shading the terrain has. **S**
- **Photo mode / screenshot key** shared with G21. **S**

---

## 5. Platform, UX & infrastructure

- **Settings screen** (audio, sensitivity, HUD scale, invert tilt,
  colour-blind pips with ✓/✗ glyphs, reduced motion, quality preset). Persist
  in `localStorage['settings.v1']`; menu gains a "Settings" button. **S/M**
- **Gamepad support.** Poll `navigator.getGamepads()` in `InputManager.update`;
  left stick tilt, right stick X yaw, right trigger absolute throttle, A
  hover-hold, B cut; Explore maps to `FlightController`. Analog tilt is a real
  skill upgrade over WASD. **M**
- **Haptics** (`navigator.vibrate`) on leg contact ∝ impact speed, hull
  contact, all-green pips, hover-hold toggle (Android only). **S**
- **Device-tilt steering** option behind settings (ADR-0002 §4). **S/M**
- **Quality presets / auto-scaling** — see section 1; tie to the settings
  screen. **S**
- **Visual regression harness.** A headed `agent-browser` (or Playwright)
  script that boots, enters each mode and screenshots at a fixed seed +
  camera; diff against baselines in CI. This audit had to hand-roll it. **M**
- **PWA / offline** (manifest + service worker caching the 8 MB of
  textures) so the mobile version installs and loads instantly. **S**
- **Bundle hygiene.** Lazy-load `lil-gui` and the benchmark entry; check
  `three/addons` tree-shaking. **S**

---

## 6. Suggested order of attack

1. **Performance first** (section 1, P0 items) — nothing else matters if the
   laptop throttles and mobile dies.
2. **V1–V5** — half a day, transforms the look using code that already exists.
3. **G1–G6** — cheap parity/consistency fixes, mostly mobile.
4. **G7 + G8 + G9** — progression and the "learnable landing" pair.
5. **V6 + V7 + V8** — shadow, plume, dust: the lander finally *looks* like
   it's flying.
6. **G11 audio, G13 low-sun, G12 expert tier, G14 rock colliders.**
7. **G10 replay/ghosts, G17 hops, G19 EVA.**
8. Settings, gamepad, daily seed, leaderboard.
