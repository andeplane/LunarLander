import RAPIER from '@dimforge/rapier3d-compat';
import { MathUtils, type PerspectiveCamera, Quaternion, type Scene, Vector2, Vector3 } from 'three';
import type { PlayerSettings } from '../core/PlayerSettings';
import type { InputManager } from '../core/InputManager';
import type { RockManager } from '../environment/RockManager';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { SunShadows } from '../rendering/SunShadows';
import { castEnvironmentRay, RoverBody, WHEELS } from '../rover/RoverBody';
import { RoverHUD } from '../rover/RoverHUD';
import { RoverModel } from '../rover/RoverModel';
import { RoverRocks } from '../rover/RoverRocks';
import { RoverTrail } from '../rover/RoverTrail';
import type { ChunkManager } from '../terrain/ChunkManager';
import { TreasureHunt } from '../hunt/TreasureHunt';
import type { RockGenerationConfig } from '../types';
import type { GameMode } from './ModeManager';

const CAB_LOOK_LIMIT = MathUtils.degToRad(15);
const CAB_REST_PITCH = Math.atan2(-1.38, 8.08);

interface RoverOptions {
  camera: PerspectiveCamera;
  canvas: HTMLCanvasElement;
  shadows: SunShadows;
  scene: Scene;
  input: InputManager;
  chunks: ChunkManager;
  rocks: RockManager;
  onPause: () => void;
  settings: PlayerSettings;
  requestRender: () => void;
}

export class RoverMode implements GameMode {
  private physics?: PhysicsWorld;
  private physicsFailed = false;
  private body?: RoverBody;
  private model?: RoverModel;
  private trail?: RoverTrail;
  private obstacles?: RoverRocks;
  private hud?: RoverHUD;
  private savedPosition = new Vector3();
  private savedRotation = new Quaternion();
  private spawn = new Vector3();
  private readonly cameraGoal = new Vector3();
  private readonly cameraTarget = new Vector3();
  private readonly forward = new Vector3();
  private readonly sample = new Float32Array(4);
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private cab = false;
  private readonly lookAngles = new Vector2();
  private readonly lookTarget = new Vector2();
  private cameraSnap = true;
  private azimuth = 2.2;
  private elevation = 0.22;
  private drag?: { id: number; x: number; y: number };
  private touchedOrbit = false;
  private hudTime = 0;
  private hunt?: TreasureHunt;
  constructor(
    private readonly o: RoverOptions,
    private readonly surveyRocks?: RockGenerationConfig
  ) {}

  setPhysics(physics: PhysicsWorld) {
    this.physics = physics;
  }
  reportPhysicsFailure() {
    this.physicsFailed = true;
    if (this.hud) this.hud.status.textContent = 'Driving physics could not start. Reload to retry.';
  }

  enter() {
    const { camera, canvas, input } = this.o;
    this.savedPosition.copy(camera.position);
    this.savedRotation.copy(camera.quaternion);
    this.spawn.copy(camera.position);
    this.hud = new RoverHUD(
      this.toggleCamera,
      this.recover,
      this.o.onPause,
      input.getIsTouchDevice()
    );
    this.hud.status.textContent = this.physicsFailed
      ? 'Driving physics could not start. Reload to retry.'
      : 'Preparing rover…';
    this.cab = false;
    this.cameraSnap = true;
    this.touchedOrbit = false;
    this.azimuth = 2.2;
    this.elevation = 0.22;
    this.hudTime = 0;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerleave', this.centerLook);
    window.addEventListener('blur', this.centerLook);
    canvas.addEventListener('lostpointercapture', this.onUp);
  }

  private onDown = (e: PointerEvent) => {
    if (this.cab || this.drag || e.button !== 0) return;
    this.o.canvas.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  private onMove = (e: PointerEvent) => {
    if (this.cab) {
      if (!this.o.settings.cockpitLook || e.pointerType !== 'mouse') return;
      const { left, top, width, height } = this.o.canvas.getBoundingClientRect();
      if (width && height) {
        this.lookTarget.set(
          MathUtils.clamp((2 * (e.clientX - left)) / width - 1, -1, 1) * CAB_LOOK_LIMIT,
          MathUtils.clamp(1 - (2 * (e.clientY - top)) / height, -1, 1) * CAB_LOOK_LIMIT
        );
      }
      return;
    }
    if (this.drag?.id !== e.pointerId || !this.drag) return;
    this.azimuth -= (e.clientX - this.drag.x) * 0.008;
    this.elevation = MathUtils.clamp(
      this.elevation + (e.clientY - this.drag.y) * 0.005,
      0.03,
      0.98
    );
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.touchedOrbit = true;
  };
  private onUp = () => {
    this.drag = undefined;
  };
  private centerLook = () => {
    this.lookTarget.set(0, 0);
  };
  private toggleCamera = () => {
    if (this.hunt && !this.hunt.driving) return;
    this.cab = !this.cab;
    this.centerLook();
    this.lookAngles.set(0, 0);
    this.cameraSnap = true;
    this.azimuth = 0.38;
    this.elevation = 0.22;
    this.touchedOrbit = false;
    this.refreshCameraHint();
    this.model?.setDriverView(this.cab);
  };

  refreshCameraHint(): void {
    this.hud?.setCamera(this.cab, this.o.settings.cockpitLook);
  }

  private ground(x: number, z: number) {
    return this.o.chunks.sampleVisibleGround(x, z, this.sample, 0) ? this.sample[3] : null;
  }

  // Check the streamed collision surface before creating or recovering a body.
  // Also reject boulders and prefer a gentle patch directly around the driver.
  private findParking(x: number, z: number) {
    if (!this.physics) return null;
    const world = this.physics.getWorld();
    world.updateSceneQueries();
    this.ray.dir = { x: 0, y: -1, z: 0 };
    let best: Vector3 | null = null,
      bestScore = Infinity;
    for (const [ox, oz] of [
      [0, 0],
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
      [4, 4],
      [-4, -4],
      [-4, 4],
      [4, -4],
      [12, 0],
      [-12, 0],
      [0, 12],
      [0, -12],
    ]) {
      const px = x + ox,
        pz = z + oz;
      let low = Infinity,
        high = -Infinity,
        supports = 0;
      for (const [dx, dz] of [[0, 0], ...WHEELS.map(({ x, z }) => [x, z])]) {
        const h = this.ground(px + dx, pz + dz);
        if (h === null) break;
        this.ray.origin = { x: px + dx, y: h + 15, z: pz + dz };
        const hit = castEnvironmentRay(world, this.ray, 30, this.body);
        if (!hit || Math.abs(15 - hit.toi) > 0.5) break;
        const y = h + 15 - hit.toi;
        low = Math.min(low, y);
        high = Math.max(high, y);
        supports++;
      }
      const score = high - low + 0.025 * Math.hypot(ox, oz);
      if (supports === 5 && score < bestScore) {
        best = new Vector3(px, high + 0.67, pz);
        bestScore = score;
      }
    }
    return best;
  }
  private recover = () => {
    if (!this.body || (this.hunt && !this.hunt.driving)) return;
    const p = this.body.position;
    const parking =
      this.findParking(p.x, p.z) ??
      (this.hunt ? null : this.findParking(this.spawn.x, this.spawn.z));
    if (!parking) return;
    this.forward.set(0, 0, -1).applyQuaternion(this.body.rotation);
    this.body.reset(parking, Math.atan2(-this.forward.x, -this.forward.z));
    this.spawn.copy(parking);
    this.cameraSnap = true;
  };

  update(dt: number) {
    const { input, scene, chunks } = this.o;
    const hud = this.hud;
    if (!hud || !this.physics) return;
    if (!this.body) {
      this.obstacles ??= new RoverRocks(this.physics.getWorld(), chunks, this.o.rocks);
      this.obstacles.update(this.spawn.x, this.spawn.z, dt);
      const park = this.findParking(this.spawn.x, this.spawn.z);
      if (!park) return;
      this.spawn.copy(park);
      this.body = new RoverBody(this.physics.getWorld(), park);
      this.physics.addPhysicsStepListener(this.body);
      this.model = new RoverModel(this.o.shadows);
      this.trail = new RoverTrail(chunks.sampleVisibleGround);
      scene.add(this.model.root, this.trail.root);
      if (this.surveyRocks) {
        this.hunt = new TreasureHunt(
          this.o,
          this.body,
          this.model,
          hud,
          this.physics.getWorld(),
          this.surveyRocks
        );
      } else this.o.shadows.setMovingCaster(this.model.root);
      hud.status.textContent = '';
    }
    const b = this.body;
    const surfacePosition = this.hunt?.surfacePosition ?? b.position;
    this.obstacles?.update(surfacePosition.x, surfacePosition.z, dt);
    if (input.isKeyJustPressed('c')) this.toggleCamera();
    if (input.isKeyJustPressed('r')) this.recover();
    const held = (action: string, ...keys: string[]) =>
      hud.held(action) || keys.some((k) => input.isKeyPressed(k));
    const throttle =
      Number(held('drive', 'w', 'arrowup')) - Number(held('reverse', 's', 'arrowdown'));
    const steer = Number(held('left', 'a', 'arrowleft')) - Number(held('right', 'd', 'arrowright'));
    this.forward.set(0, 0, -1).applyQuaternion(b.rotation);
    const bearing = Math.atan2(this.forward.x, -this.forward.z);
    this.hunt?.update(dt, bearing, throttle, steer);
    const driving = !this.hunt || this.hunt.driving;
    b.throttle = driving ? throttle : 0;
    b.steer = driving ? steer : 0;
    b.brake = !driving || held('brake', ' ');
    const ground = this.ground(b.position.x, b.position.z);
    if (ground !== null && b.position.y < ground - 2) this.recover();
    this.model?.sync(b);
    this.trail?.update(b);
    if (this.hunt && !driving) {
      this.hunt.updateCamera(dt);
      this.cameraSnap = true;
    } else this.updateCamera(b, bearing, dt, this.physics.getWorld());
    this.hudTime -= dt;
    if (this.hudTime <= 0) {
      hud.update(b.speed, b.distance, MathUtils.radToDeg(bearing));
      this.model?.panel.update(b.speed, MathUtils.radToDeg(bearing), b.distance);
      this.hudTime = 0.1;
    }
    this.o.requestRender();
  }

  private updateCamera(b: RoverBody, bearing: number, dt: number, world: RAPIER.World) {
    const cam = this.o.camera;
    if (this.cab) {
      this.cameraGoal.set(-0.33, 1.12, 0.08).applyQuaternion(b.rotation).add(b.position);
      if (!this.o.settings.cockpitLook) this.centerLook();
      this.lookAngles.lerp(this.lookTarget, 1 - Math.exp(-10 * dt));
      const yaw = this.lookAngles.x;
      const pitch = CAB_REST_PITCH + this.lookAngles.y;
      this.cameraTarget
        .set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
        .applyQuaternion(b.rotation)
        .add(this.cameraGoal);
    } else {
      if (!this.drag && !this.touchedOrbit && Math.abs(b.speed) > 0.35)
        this.azimuth = MathUtils.damp(this.azimuth, 0.21, 1.25, dt);
      const distance = 4.15 * Math.max(1, 0.95 / cam.aspect);
      const az = this.azimuth - bearing;
      this.cameraTarget.copy(b.position);
      this.cameraTarget.y += 0.46;
      this.cameraGoal
        .set(
          Math.sin(az) * Math.cos(this.elevation),
          Math.sin(this.elevation),
          Math.cos(az) * Math.cos(this.elevation)
        )
        .multiplyScalar(distance)
        .add(this.cameraTarget);
      // Shorten the boom at hills or boulders instead of putting the camera inside them.
      const dir = this.forward.copy(this.cameraGoal).sub(this.cameraTarget).normalize();
      this.ray.origin = this.cameraTarget;
      this.ray.dir = dir;
      const hit = castEnvironmentRay(world, this.ray, distance, b);
      if (hit)
        this.cameraGoal
          .copy(this.cameraTarget)
          .addScaledVector(dir, Math.max(0.35, hit.toi - 0.22));
    }
    cam.position.lerp(this.cameraGoal, this.cab || this.cameraSnap ? 1 : 1 - Math.exp(-7 * dt));
    const floor = this.ground(cam.position.x, cam.position.z);
    if (floor !== null) cam.position.y = Math.max(cam.position.y, floor + 0.2);
    cam.lookAt(this.cameraTarget);
    this.cameraSnap = false;
  }

  exit() {
    const { canvas, camera } = this.o;
    if (this.drag && canvas.hasPointerCapture(this.drag.id))
      canvas.releasePointerCapture(this.drag.id);
    this.drag = undefined;
    canvas.removeEventListener('pointerdown', this.onDown);
    canvas.removeEventListener('pointermove', this.onMove);
    canvas.removeEventListener('pointerleave', this.centerLook);
    window.removeEventListener('blur', this.centerLook);
    canvas.removeEventListener('lostpointercapture', this.onUp);
    canvas.style.removeProperty('touch-action');
    this.hunt?.dispose();
    this.hunt = undefined;
    if (this.body) {
      this.physics?.removePhysicsStepListener(this.body);
      this.body.dispose();
    }
    this.obstacles?.dispose();
    this.o.shadows.setMovingCaster(null);
    this.model?.dispose();
    this.trail?.dispose();
    this.trail = undefined;
    this.hud?.dispose();
    this.body = undefined;
    this.obstacles = undefined;
    this.model = undefined;
    this.hud = undefined;
    camera.position.copy(this.savedPosition);
    camera.quaternion.copy(this.savedRotation);
    this.o.requestRender();
  }
}
