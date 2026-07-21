/**
 * The Lunar Lander game mode (ADR-0001..0004).
 *
 * Orchestrates: mission generation (seeded pad search on deterministic
 * terrain), the physics lander (angle-mode assisted control), cockpit/belly
 * cameras, in-world markers, HUD + screens, touchdown grading and scoring.
 */
import * as THREE from 'three';
import type { GameMode } from './ModeManager';
import type { InputManager } from '../core/InputManager';
import type { ChunkManager } from '../terrain/ChunkManager';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { BallManager } from '../physics/BallManager';
import type { RockGenerationConfig } from '../types';
import { createHeightSampler, type TerrainHeightSampler } from '../terrain/heightSampler';
import { LanderBody, type LanderStepSample } from '../lander/LanderBody';
import { LanderControls } from '../lander/LanderControls';
import { LanderVisuals } from '../lander/LanderVisuals';
import { MissionMarkers } from '../lander/MissionMarkers';
import { LanderHUD } from '../lander/LanderHUD';
import { LanderScreens } from '../lander/LanderScreens';
import { LanderTouchControls } from '../lander/LanderTouchControls';
import { findLandingPad, siteQualityAt, type PadSearchResult } from '../lander/padSearch';
import { rocksInArea } from '../lander/rockQuery';
import { missionParamsForIndex, fuelCapacityForMission } from '../lander/mission';
import { gradeLanding, scoreLanding } from '../lander/scoring';
import { getMissionBest, recordMissionResult, highestCompletedMission } from '../lander/highscores';
import { LANDER_CONFIG } from '../lander/config';
import type { LanderHudData, LanderPhase, MissionParams, TouchdownStats } from '../lander/types';
import { isTouchDevice } from '../utils/mobile';
import alea from 'alea';

const TIP_OVER_DEG = 60;
const AFTERMATH_SECONDS = 3.5;
const EXPLORE_FOV = 70;

export class LanderMode implements GameMode {
  private camera: THREE.PerspectiveCamera;
  private scene: THREE.Scene;
  private inputManager: InputManager;
  private chunkManager: ChunkManager;
  private requestRender: () => void;
  private onExitToMenu: () => void;
  private setPaused: (paused: boolean) => void;
  private rockConfig: RockGenerationConfig;
  private rockLibrarySize: number;

  private physicsWorld: PhysicsWorld | null = null;
  private ballManager: BallManager | null = null;

  // Lazily created on first enter (physics/terrain config must exist)
  private controls: LanderControls;
  private body: LanderBody | null = null;
  private visuals: LanderVisuals | null = null;
  private markers: MissionMarkers | null = null;
  private hud: LanderHUD | null = null;
  private screens: LanderScreens | null = null;
  private touchControls: LanderTouchControls | null = null;
  private sampler: TerrainHeightSampler | null = null;

  private active = false;
  private phase: LanderPhase = 'briefing';
  private missionIndex = 0;
  private mission: MissionParams | null = null;
  private pad: PadSearchResult | null = null;
  private elapsed = 0;
  private terrainReady = false;

  // Camera state
  private bellyCam = false;
  private usedBellyCam = false;
  private glanceBlend = 0; // 0..1, V key eases toward 1

  // Touchdown grading window (ADR-0004 §2)
  private ignoreEscapeOnce = false;
  private windowOpen = false;
  private worstVSpeed = 0;
  private worstDrift = 0;
  private worstTilt = 0;
  private restTime = 0;
  private aftermathTime = 0;
  private aftermathCamPos = new THREE.Vector3();

  // Scratch
  private readonly vec = new THREE.Vector3();
  private readonly vec2 = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly eyeQuatOffset = new THREE.Quaternion();
  private readonly hudData: LanderHudData = {
    phase: 'briefing',
    altitudeAGL: null,
    verticalSpeed: 0,
    driftSpeed: 0,
    driftDirection: 0,
    throttle: 0,
    hoverThrottle: 0.45,
    hoverHold: false,
    fuelFraction: 1,
    fuelBurnTimeS: null,
    pitchDeg: 0,
    rollDeg: 0,
    padDistance: 0,
    padScreen: null,
    padBearing: 0,
    readiness: null,
    slopeWarning: false,
  };
  private readonly pitchRoll = { pitch: 0, roll: 0 };

  private readonly onPauseKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.resumeFromPause();
    }
  };

  constructor(args: {
    camera: THREE.PerspectiveCamera;
    scene: THREE.Scene;
    inputManager: InputManager;
    chunkManager: ChunkManager;
    rockConfig: RockGenerationConfig;
    rockLibrarySize: number;
    requestRender: () => void;
    onExitToMenu: () => void;
    setPaused: (paused: boolean) => void;
  }) {
    this.camera = args.camera;
    this.scene = args.scene;
    this.inputManager = args.inputManager;
    this.chunkManager = args.chunkManager;
    this.rockConfig = args.rockConfig;
    this.rockLibrarySize = args.rockLibrarySize;
    this.requestRender = args.requestRender;
    this.onExitToMenu = args.onExitToMenu;
    this.setPaused = args.setPaused;
    this.controls = new LanderControls(args.inputManager);
  }

  /** Late injection: physics arrives after async Rapier init. */
  setPhysics(physicsWorld: PhysicsWorld, ballManager: BallManager): void {
    this.physicsWorld = physicsWorld;
    this.ballManager = ballManager;
  }

  // ---- GameMode ----

  enter(): void {
    this.active = true;
    this.ensureComponents();

    // Stray Explore balls must not collide with the lander
    this.ballManager?.removeAllBalls();

    this.camera.fov = LANDER_CONFIG.cockpitFov;
    this.camera.updateProjectionMatrix();

    if (this.body && this.physicsWorld) {
      this.physicsWorld.addPhysicsStepListener(this.body);
    }

    this.hud?.show();
    this.touchControls?.setVisible(true);

    // Continue from the player's progression
    this.missionIndex = highestCompletedMission() + 1;
    this.startMission(this.missionIndex);
  }

  exit(): void {
    this.active = false;
    this.setPaused(false);
    window.removeEventListener('keydown', this.onPauseKeydown);

    if (this.body && this.physicsWorld) {
      this.physicsWorld.removePhysicsStepListener(this.body);
    }
    this.body?.despawn();
    if (this.body) {
      this.scene.remove(this.body.rig);
    }
    this.markers?.hidePad();
    this.markers?.hideImpactReticle();
    this.hud?.hide();
    this.screens?.hideAll();
    this.touchControls?.setVisible(false);
    this.controls.reset();

    this.camera.fov = EXPLORE_FOV;
    this.camera.updateProjectionMatrix();
  }

  update(deltaTime: number): void {
    if (!this.active) return;

    // Render-on-demand: markers pulse and physics interpolates every frame
    this.requestRender();
    this.elapsed += deltaTime;

    this.controls.captureFrameInput();

    // Esc opens the pause overlay (flying) or exits (briefing/debrief).
    // The Escape that RESUMED from pause is still "just pressed" on the
    // first unpaused frame — it must not immediately re-pause.
    if (this.ignoreEscapeOnce) {
      this.ignoreEscapeOnce = false;
    } else if (this.inputManager.isKeyJustPressed('escape')) {
      if (this.phase === 'flying') {
        this.pauseGame();
        return;
      }
      this.onExitToMenu();
      return;
    }

    if (this.controls.consumeRestart()) {
      this.startMission(this.missionIndex);
      return;
    }
    if (this.controls.consumeCameraCycle() && this.phase === 'flying') {
      this.bellyCam = !this.bellyCam;
      if (this.bellyCam) this.usedBellyCam = true;
    }

    // Glance (V): ease extra down-pitch in and out
    const glanceTarget = this.inputManager.isKeyPressed('v') ? 1 : 0;
    const glanceRate = 4 * deltaTime;
    this.glanceBlend += Math.sign(glanceTarget - this.glanceBlend) *
      Math.min(Math.abs(glanceTarget - this.glanceBlend), glanceRate);

    if (this.phase === 'briefing') {
      this.updateBriefing();
    } else if (this.phase === 'crashed') {
      this.aftermathTime += deltaTime;
      if (this.aftermathTime >= AFTERMATH_SECONDS) {
        this.finishCrash();
      }
    }

    // Markers + HUD track the live state every frame
    this.markers?.updateBeacon(this.elapsed);
    this.updateMarkersAndHud();

    // Physics may be idle (frozen body) — camera still needs syncing when
    // something else (glance/camera cycle) changed
    this.syncCamera();
  }

  // ---- Mission flow ----

  private ensureComponents(): void {
    if (!this.sampler) {
      this.sampler = createHeightSampler(this.chunkManager.getBaseTerrainArgs());
    }
    if (!this.markers) {
      this.markers = new MissionMarkers(this.scene);
    }
    if (!this.hud) {
      this.hud = new LanderHUD();
    }
    if (!this.screens) {
      this.screens = new LanderScreens({
        onLaunch: () => this.launch(),
        onResume: () => this.resumeFromPause(),
        onRestart: () => {
          this.resumeFromPause();
          this.startMission(this.missionIndex);
        },
        onBackToMenu: () => this.onExitToMenu(),
        onRetry: () => this.startMission(this.missionIndex),
        onNextMission: () => this.startMission(this.missionIndex + 1),
        onDebriefMenu: () => this.onExitToMenu(),
      });
    }
    if (!this.touchControls && isTouchDevice()) {
      this.touchControls = new LanderTouchControls(this.controls);
    }
    if (!this.body && this.physicsWorld?.isReady()) {
      this.body = new LanderBody(this.physicsWorld.getWorld(), this.controls);
      this.visuals = new LanderVisuals();
      this.body.rig.add(this.visuals.group);
      this.body.setOnStep((sample) => this.onPhysicsStepSample(sample));
      this.body.setOnSync(() => this.syncCamera());
    }
  }

  private startMission(index: number): void {
    if (!this.sampler || !this.markers || !this.screens) return;
    // Physics not ready yet: stay in a briefing-like limbo; enter() retries
    // via updateBriefing() polling ensureComponents()
    this.ensureComponents();

    this.missionIndex = index;
    this.mission = missionParamsForIndex(index);
    this.phase = 'briefing';
    this.terrainReady = false;
    this.bellyCam = false;
    this.usedBellyCam = false;
    this.glanceBlend = 0;
    this.windowOpen = false;
    this.worstVSpeed = 0;
    this.worstDrift = 0;
    this.worstTilt = 0;
    this.restTime = 0;
    this.aftermathTime = 0;
    this.elapsed = 0;
    this.controls.reset();
    this.screens.hideAll();
    this.markers.hideImpactReticle();

    // Mission area: deterministic location per index, away from the origin
    const rng = alea('lander-area', this.mission.seed);
    const areaAngle = rng() * Math.PI * 2;
    const areaDist = 3000 + index * 900;
    const centerX = Math.cos(areaAngle) * areaDist;
    const centerZ = Math.sin(areaAngle) * areaDist;

    // Pad search with rock exclusion (ADR-0004 §1); progressively relax
    // constraints — infinite terrain always offers something landable
    const rocks = rocksInArea(
      this.chunkManager.getBaseTerrainArgs(),
      this.rockConfig,
      this.rockLibrarySize,
      centerX - 400,
      centerX + 400,
      centerZ - 400,
      centerZ + 400
    );
    let pad: PadSearchResult | null = null;
    for (const relax of [1, 1.5, 2.5]) {
      pad = findLandingPad({
        sampler: this.sampler,
        centerX,
        centerZ,
        searchRadius: 350,
        padRadius: this.mission.padRadius,
        maxSlopeDeg: 6 * relax,
        maxHeightSpread: 2.5 * relax,
        rocks,
        rng: alea('lander-pad', this.mission.seed),
      });
      if (pad) break;
    }
    if (!pad) {
      // Degenerate terrain config — land-anywhere fallback at the center
      pad = {
        x: centerX,
        z: centerZ,
        y: this.sampler.heightAt(centerX, centerZ),
        maxSlopeDeg: 0,
        heightSpread: 0,
        quality: 0,
      };
    }
    this.pad = pad;
    this.markers.setPad(pad.x, pad.y, pad.z, this.mission.padRadius);

    // Spawn upwind of the pad with the mission's approach state
    const approach = rng() * Math.PI * 2;
    const spawnX = pad.x + Math.cos(approach) * this.mission.spawnDistance;
    const spawnZ = pad.z + Math.sin(approach) * this.mission.spawnDistance;
    const spawnY = pad.y + this.mission.spawnAltitudeAGL;
    // Velocity roughly toward the pad, rotated by the bearing error
    const toPad = approach + Math.PI + this.mission.spawnBearingError;
    const velocity = new THREE.Vector3(
      Math.cos(toPad) * this.mission.spawnHorizontalSpeed,
      -this.mission.spawnDescentRate,
      Math.sin(toPad) * this.mission.spawnHorizontalSpeed
    );
    // Face the direction of travel: local forward after yaw ψ is
    // (-sin ψ, 0, -cos ψ), so ψ = atan2(-vx, -vz) aligns forward with v
    const yawHeading = Math.atan2(-velocity.x, -velocity.z);

    const fuelKg = this.mission ? fuelCapacityForMission(this.mission) : LANDER_CONFIG.fuelMass;

    if (this.body) {
      this.body.spawn({
        position: new THREE.Vector3(spawnX, spawnY, spawnZ),
        yawHeading,
        velocity,
        fuelCapacityKg: fuelKg,
      });
      if (!this.body.rig.parent) {
        this.scene.add(this.body.rig);
      }
    }

    // Teleport the camera to the cockpit now — streaming and terrain
    // colliders build around the spawn during the briefing screen
    this.syncCamera();

    this.screens.showBriefing(index, {
      preparingTerrain: true,
      fuelKg: Math.round(fuelKg),
      padDistanceM: Math.round(this.mission.spawnDistance),
      padMultiplier: this.mission.padMultiplier,
    });
  }

  /** Briefing phase: wait until physics + a collider under the spawn exist. */
  private updateBriefing(): void {
    if (!this.body) {
      // Rapier finished initializing after enter()
      this.ensureComponents();
      if (this.body && this.physicsWorld) {
        this.physicsWorld.addPhysicsStepListener(this.body);
        this.startMission(this.missionIndex);
      }
      return;
    }
    if (!this.terrainReady) {
      const agl = this.body.raycastAltitudeAGL();
      if (agl !== null && agl > 0) {
        this.terrainReady = true;
        this.screens?.updateBriefing({ preparingTerrain: false });
      }
    }
  }

  private launch(): void {
    if (!this.terrainReady || !this.body || this.phase !== 'briefing') return;
    this.screens?.hideAll();
    this.phase = 'flying';
    this.body.launch();
  }

  private pauseGame(): void {
    this.setPaused(true);
    this.screens?.showPause();
    window.addEventListener('keydown', this.onPauseKeydown);
  }

  private resumeFromPause(): void {
    window.removeEventListener('keydown', this.onPauseKeydown);
    this.screens?.hideAll();
    this.ignoreEscapeOnce = true;
    this.setPaused(false);
  }

  // ---- Touchdown grading (runs on the fixed physics step) ----

  private onPhysicsStepSample(sample: LanderStepSample): void {
    if (this.phase !== 'flying') return;

    // Immediate crash conditions
    if (sample.bodyContact || sample.tiltDeg > TIP_OVER_DEG) {
      this.beginCrash(
        sample.bodyContact
          ? `hull contact (impact v↓ ${sample.impactVerticalSpeed.toFixed(1)} m/s)`
          : `tipped over (${sample.tiltDeg.toFixed(0)}°)`
      );
      return;
    }

    if (sample.legContactCount > 0) {
      this.windowOpen = true;
      this.worstVSpeed = Math.max(this.worstVSpeed, sample.impactVerticalSpeed);
      this.worstDrift = Math.max(this.worstDrift, sample.impactDriftSpeed);
    }
    if (this.windowOpen) {
      this.worstTilt = Math.max(this.worstTilt, sample.tiltDeg);

      // Rest detection: any leg down + a full second of near-zero speed.
      // (On rough heightfield terrain the craft legitimately rests on 2–3
      // feet; requiring more would leave landed craft waiting forever.
      // A perched/wedged rest still grades — tilt exposes it.)
      if (sample.legContactCount >= 1 && sample.speed < LANDER_CONFIG.touchdown.restSpeed) {
        this.restTime += sample.dt;
        if (this.restTime >= LANDER_CONFIG.touchdown.stabilityTimeS) {
          this.evaluateLanding();
        }
      } else {
        this.restTime = 0;
      }
    }
  }

  private buildStats(bodyContact: boolean, tippedOver: boolean): TouchdownStats {
    const body = this.body;
    const sampler = this.sampler;
    const pad = this.pad;
    const x = body ? body.rig.position.x : 0;
    const z = body ? body.rig.position.z : 0;
    const padDist = pad ? Math.hypot(x - pad.x, z - pad.z) : Infinity;
    const onPad = this.mission !== null && padDist <= this.mission.padRadius;
    return {
      maxVerticalSpeed: this.worstVSpeed,
      maxDriftSpeed: this.worstDrift,
      maxTiltDeg: this.worstTilt,
      slopeDeg: sampler ? sampler.slopeAt(x, z) : 0,
      distanceToPadCenter: padDist,
      onPad,
      siteQuality: sampler ? siteQualityAt(sampler, x, z) : 0,
      fuelFraction: body ? body.getEngine().getFuelFraction() : 0,
      usedHoverHold: body ? body.getEngine().wasHoverHoldUsed() : false,
      usedBellyCam: this.usedBellyCam,
      bodyContact,
      tippedOver,
    };
  }

  private evaluateLanding(): void {
    if (!this.mission) return;
    const stats = this.buildStats(false, false);
    const grade = gradeLanding(stats);
    if (grade === 'crash') {
      this.beginCrash(
        `impact beyond limits (v↓ ${stats.maxVerticalSpeed.toFixed(1)}, drift ${stats.maxDriftSpeed.toFixed(1)}, tilt ${stats.maxTiltDeg.toFixed(0)}°)`
      );
      return;
    }
    this.phase = 'landed';
    this.showDebrief(stats);
  }

  private beginCrash(reason: string): void {
    console.log(`[Lander] Crash: ${reason}`);
    this.phase = 'crashed';
    this.aftermathTime = 0;
    // Detach the camera: aftermath shot from slightly above/behind the
    // current cockpit position, watching the physics play out
    this.aftermathCamPos.copy(this.camera.position);
    this.aftermathCamPos.y += 6;
    if (this.body) {
      this.vec.copy(this.body.rig.position).sub(this.camera.position).normalize();
      this.aftermathCamPos.addScaledVector(this.vec, -10);
    }
  }

  private finishCrash(): void {
    if (this.phase !== 'crashed' || !this.mission) return;
    const stats = this.buildStats(true, this.worstTilt > TIP_OVER_DEG);
    this.phase = 'debrief';
    this.showDebrief(stats);
  }

  private showDebrief(stats: TouchdownStats): void {
    if (!this.mission || !this.screens) return;
    const score = scoreLanding(stats, this.mission);
    const best = getMissionBest(this.missionIndex);
    const isNewBest =
      score.grade !== 'crash' &&
      recordMissionResult(this.missionIndex, score.total, score.stars);
    this.phase = 'debrief';
    this.screens.showDebrief({
      score,
      stats,
      missionIndex: this.missionIndex,
      bestScore: best?.score ?? null,
      bestStars: best?.stars ?? null,
      isNewBest,
    });
  }

  // ---- Camera & HUD ----

  /** Copy the interpolated rig transform into the scene-root camera. */
  private syncCamera(): void {
    if (!this.active || !this.body) return;

    if (this.phase === 'crashed' || (this.phase === 'debrief' && this.aftermathTime > 0)) {
      // Aftermath: fixed external shot watching the wreck
      this.camera.position.copy(this.aftermathCamPos);
      this.camera.lookAt(this.body.rig.position);
      return;
    }

    const rig = this.body.rig;
    if (this.bellyCam) {
      // Under the hull, looking straight down, heading-aligned
      this.vec.set(0, -LANDER_CONFIG.bodyHalfExtents.y - 0.25, 0).applyQuaternion(rig.quaternion);
      this.camera.position.copy(rig.position).add(this.vec);
      this.quat.setFromEuler(new THREE.Euler(-Math.PI / 2, this.body.getHeading(), 0, 'YXZ'));
      this.camera.quaternion.copy(this.quat);
    } else {
      const eye = LANDER_CONFIG.eyeOffset;
      this.vec.set(eye.x, eye.y, eye.z).applyQuaternion(rig.quaternion);
      this.camera.position.copy(rig.position).add(this.vec);
      const pitch = -LANDER_CONFIG.cockpitViewPitchRad - this.glanceBlend * 0.85;
      this.eyeQuatOffset.setFromAxisAngle(AXIS_X, pitch);
      this.camera.quaternion.copy(rig.quaternion).multiply(this.eyeQuatOffset);
    }
  }

  private updateMarkersAndHud(): void {
    if (!this.body || !this.hud || !this.mission || !this.pad) return;

    const body = this.body;
    const engine = body.getEngine();
    body.getVelocity(this.vec2);
    const velocity = this.vec2;

    // Impact reticle (flying only, when meaningful descent exists)
    if (this.phase === 'flying' && this.sampler && velocity.y < -0.5) {
      const sampler = this.sampler;
      this.markers?.updateImpactReticle(body.rig.position, velocity, (x, z) =>
        sampler.heightAt(x, z)
      );
    } else {
      this.markers?.hideImpactReticle();
    }

    // Touch UI live state
    this.touchControls?.setHoverThrottle(body.getHoverThrottle());
    this.touchControls?.setHoverHoldActive(engine.isHoverHold());

    // --- HUD data ---
    const data = this.hudData;
    data.phase = this.phase;
    data.altitudeAGL = body.raycastAltitudeAGL();
    data.verticalSpeed = velocity.y;
    data.driftSpeed = Math.hypot(velocity.x, velocity.z);

    const heading = body.getHeading();
    // Drift direction relative to heading: 0 = toward lander-forward
    const worldDriftDir = Math.atan2(velocity.x, -velocity.z);
    data.driftDirection = normalizeAngle(worldDriftDir - heading);

    data.throttle = engine.getLever();
    data.hoverThrottle = body.getHoverThrottle();
    data.hoverHold = engine.isHoverHold();
    data.fuelFraction = engine.getFuelFraction();
    data.fuelBurnTimeS =
      engine.getLever() > 0.01
        ? engine.getFuelKg() / (engine.getLever() * LANDER_CONFIG.maxBurnRate)
        : null;

    body.getPitchRollDeg(this.pitchRoll);
    data.pitchDeg = this.pitchRoll.pitch;
    data.rollDeg = this.pitchRoll.roll;

    // Pad projection: use the visually-curved position (terrain drops by
    // d²/2R relative to the camera — ADR-0003 §3)
    const dx = this.pad.x - this.camera.position.x;
    const dz = this.pad.z - this.camera.position.z;
    const distSq = dx * dx + dz * dz;
    const curvatureDrop = distSq / (2 * 5000);
    this.vec.set(this.pad.x, this.pad.y - curvatureDrop, this.pad.z);
    data.padDistance = Math.sqrt(distSq);
    this.vec.project(this.camera);
    if (this.vec.z < 1) {
      data.padScreen = {
        x: this.vec.x,
        y: this.vec.y,
        onScreen: Math.abs(this.vec.x) <= 1 && Math.abs(this.vec.y) <= 1,
      };
    } else {
      data.padScreen = null;
    }
    data.padBearing = normalizeAngle(Math.atan2(dx, -dz) - heading);

    // Readiness pips below the reveal altitude
    const cfg = LANDER_CONFIG.touchdown;
    if (
      data.altitudeAGL !== null &&
      data.altitudeAGL < LANDER_CONFIG.hud.readinessRevealAGL &&
      this.phase === 'flying'
    ) {
      data.readiness = {
        vspeed: -velocity.y <= cfg.goodVSpeed,
        drift: data.driftSpeed <= cfg.goodDrift,
        tilt: body.getTiltDeg() <= cfg.goodTiltDeg,
      };
      data.slopeWarning =
        this.sampler !== null &&
        this.sampler.slopeAt(body.rig.position.x, body.rig.position.z) > cfg.goodSlopeDeg;
    } else {
      data.readiness = null;
      data.slopeWarning = false;
    }

    this.hud.update(data);
  }

  dispose(): void {
    this.body?.dispose();
    this.visuals?.dispose();
    this.markers?.dispose();
    this.hud?.dispose();
    this.screens?.dispose();
    this.touchControls?.dispose();
  }
}

const AXIS_X = new THREE.Vector3(1, 0, 0);

/** Wrap an angle to (-π, π]. */
function normalizeAngle(a: number): number {
  let angle = a % (2 * Math.PI);
  if (angle > Math.PI) angle -= 2 * Math.PI;
  if (angle <= -Math.PI) angle += 2 * Math.PI;
  return angle;
}
