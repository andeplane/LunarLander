import RAPIER from '@dimforge/rapier3d-compat';
import { type PerspectiveCamera, type Scene, Vector3 } from 'three';
import type { InputManager } from '../core/InputManager';
import { findLandingPad } from '../lander/padSearch';
import { rocksInArea } from '../lander/rockQuery';
import type { SunShadows } from '../rendering/SunShadows';
import { castEnvironmentRay, type RoverBody } from '../rover/RoverBody';
import type { RoverHUD } from '../rover/RoverHUD';
import type { RoverModel } from '../rover/RoverModel';
import type { ChunkManager } from '../terrain/ChunkManager';
import { createHeightSampler } from '../terrain/heightSampler';
import type { RockGenerationConfig } from '../types';
import {
  cargoCapacity,
  distance,
  Expedition,
  minerals,
  survey,
  uncoverStrokes,
} from './Expedition';
import { FieldModels } from './FieldModels';
import { HuntHUD } from './HuntHUD';

interface HuntOptions {
  chunks: ChunkManager;
  shadows: SunShadows;
  input: InputManager;
  scene: Scene;
  camera: PerspectiveCamera;
}

export class TreasureHunt {
  private readonly mission: Expedition;
  private readonly field: FieldModels;
  private readonly hud: HuntHUD;
  private readonly home: Vector3;
  private readonly ground = new Float32Array(4);
  private readonly look = new Vector3();
  private readonly goal = new Vector3();
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
  private readonly stationColliders: RAPIER.Collider[] = [];
  private readonly sampler;
  private readonly rocks;
  private stride = 0;
  private swing = 0;
  private yaw = 0;
  private refresh = 0;

  constructor(
    private readonly o: HuntOptions,
    private readonly rover: RoverBody,
    private readonly model: RoverModel,
    private readonly dashboard: RoverHUD,
    private readonly world: RAPIER.World,
    config: RockGenerationConfig
  ) {
    this.home = rover.position.clone();
    const args = o.chunks.getBaseTerrainArgs();
    this.sampler = createHeightSampler(args);
    const { x, z } = this.home;
    this.rocks = rocksInArea(args, config, 0, x - 130, x + 130, z - 130, z + 130);
    this.mission = new Expedition({ x, z }, survey(this.home, this.findSite));
    this.field = new FieldModels(x, z, this.surface);
    this.field.setSites(this.mission, this.surface);
    o.scene.add(this.field.root);
    for (const [position, radius, halfHeight] of [
      [this.field.habitat.position, 2.5, 1.4],
      [this.field.lander.group.position, 2.3, 1.8],
    ] as const) {
      const y = this.surface(position.x, position.z) + halfHeight;
      this.stationColliders.push(
        world.createCollider(
          RAPIER.ColliderDesc.cylinder(halfHeight, radius).setTranslation(position.x, y, position.z)
        )
      );
    }
    this.hud = new HuntHUD(this.sampler.heightAt);
    dashboard.root.classList.add('hunt-rover');
    this.enterBase();
  }

  private surface = (x: number, z: number) =>
    this.o.chunks.sampleVisibleGround(x, z, this.ground, 0)
      ? this.ground[3]
      : this.sampler.heightAt(x, z);

  private findSite = (x: number, z: number) => {
    const pad = findLandingPad({
      sampler: this.sampler,
      centerX: x,
      centerZ: z,
      searchRadius: 12,
      padRadius: 2,
      maxSlopeDeg: 25,
      maxHeightSpread: 1.4,
      rocks: this.rocks,
      blockingRockDiameter: 0.5,
      rng: Math.random,
    });
    return pad ?? { x, z };
  };

  get driving() {
    return this.mission.phase === 'drive';
  }
  get surfacePosition() {
    return this.mission.phase === 'eva' ? this.field.boots.position : this.rover.position;
  }

  private park(locked: boolean) {
    this.rover.throttle = this.rover.steer = 0;
    this.rover.brake = true;
    this.rover.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.rover.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.rover.chassis.lockTranslations(locked, true);
    this.rover.chassis.lockRotations(locked, true);
  }
  private enterBase() {
    this.park(true);
    this.field.boots.visible = false;
    this.model.setOccupied(false);
    this.dashboard.root.classList.remove('hunt-eva');
    this.dashboard.root.classList.add('hunt-base');
    this.field.showVault(this.mission);
    this.o.shadows.setMovingCaster(null);
    this.hud.showBase(this.mission);
    this.field.syncSamples(this.mission, this.model.root);
  }
  private board() {
    this.mission.launch();
    this.field.showVault(this.mission);
    this.park(false);
    this.field.boots.visible = false;
    this.model.setOccupied(true);
    this.o.shadows.setMovingCaster(this.model.root);
    this.dashboard.root.classList.remove('hunt-base', 'hunt-eva');
    this.dashboard.setWalking(false);
    this.hud.showField();
  }
  private leaveRover(bearing: number) {
    const p = this.rover.position;
    const boots = this.field.boots;
    this.yaw = bearing;
    const x = p.x - 2 * Math.cos(bearing),
      z = p.z - 2 * Math.sin(bearing);
    boots.position.set(x, this.surface(x, z), z);
    boots.rotation.y = -bearing;
    boots.visible = true;
    this.model.setOccupied(false);
    this.park(true);
    this.mission.phase = 'eva';
    this.dashboard.root.classList.add('hunt-eva');
    this.dashboard.setWalking(true);
    this.o.shadows.setMovingCaster(this.field.boots);
  }

  private walk(dt: number, turn: number, forward: number) {
    const boots = this.field.boots;
    this.yaw -= turn * 2.2 * dt;
    boots.rotation.y = -this.yaw;
    this.swing = Math.max(0, this.swing - dt / 0.55);
    if (forward && !this.swing) {
      const step = Math.min(dt, 0.12) * forward * 2.35;
      const dx = Math.sin(this.yaw),
        dz = -Math.cos(this.yaw);
      const x = boots.position.x + dx * step,
        z = boots.position.z + dz * step;
      this.ray.origin = { x: boots.position.x, y: boots.position.y + 0.65, z: boots.position.z };
      this.ray.dir = { x: dx * Math.sign(step), y: 0, z: dz * Math.sign(step) };
      const clear = !castEnvironmentRay(this.world, this.ray, Math.abs(step) + 0.22, this.rover);
      if (
        clear &&
        distance({ x, z }, this.rover.position) > 1.45 &&
        this.o.chunks.sampleVisibleGround(x, z, this.ground, 0)
      ) {
        boots.position.set(x, this.ground[3], z);
        this.stride += 8 * dt;
      }
    }
    boots.position.y = this.surface(boots.position.x, boots.position.z);
    this.field.animate(this.stride, !!forward, this.swing);
  }

  update(dt: number, bearing: number, forward: number, turn: number) {
    const { mission, rover, hud } = this;
    const used = this.o.input.isKeyJustPressed('e') || hud.requested;
    hud.requested = false;
    if (mission.tick(dt)) {
      rover.reset(this.home);
      this.enterBase();
      return;
    }
    if (mission.phase === 'base') {
      if (
        used &&
        this.o.chunks.sampleVisibleGround(rover.position.x, rover.position.z, this.ground, 0)
      ) {
        if (mission.sites.every((site) => site.location === 'base')) {
          this.clearPits();
          mission.sites = survey(this.home, this.findSite, Math.random() * 2 * Math.PI);
          this.field.setSites(mission, this.surface);
          this.field.syncSamples(mission, this.model.root);
        }
        this.board();
      }
      return;
    }
    if (this.o.input.isKeyJustPressed('m')) hud.toggleMap();
    const walking = mission.phase === 'eva';
    if (walking) this.walk(dt, turn, forward);
    this.refresh -= dt;
    if (this.refresh <= 0 || used) {
      this.refresh = 0.1;
      const outputs = this.interaction(used, bearing);
      const player = walking ? this.field.boots.position : rover.position;
      hud.update(mission, outputs.guidance, outputs.action);
      hud.map.draw(mission, player, rover.position, walking ? this.yaw : bearing);
    }
  }

  private interaction(used: boolean, bearing: number) {
    const { mission, rover } = this;
    const car = rover.position,
      boots = this.field.boots.position;
    const atCar = distance(car, boots) <= 3.6;
    let action = '',
      guidance = '';
    if (mission.phase === 'drive') {
      const homeDistance = distance(car, mission.base);
      const sites = mission.sites.filter((site) => site.location === 'ground');
      const nearest = sites.sort((a, b) => distance(car, a) - distance(car, b))[0];
      const goHome = !nearest || mission.cargo.length >= cargoCapacity || mission.oxygen < 45;
      if (goHome) guidance = `Return to base B · ${Math.round(homeDistance)} m`;
      else
        guidance = `Signal ${mission.sites.indexOf(nearest) + 1} · ${Math.round(distance(car, nearest))} m. Park nearby to dig.`;
      if (Math.abs(rover.speed) > 0.65 || rover.grounded < 2)
        return { action, guidance: `${guidance} Brake to stop.` };
      if (homeDistance <= 9) {
        action = 'Enter base';
        if (used) {
          mission.dock(car);
          this.enterBase();
        }
      } else {
        action = 'Step out';
        if (used) this.leaveRover(bearing);
      }
    } else {
      const site = mission.nearbySite(boots);
      if (mission.hand) {
        guidance = `Carry ${minerals[mission.hand.mineral].name} to the rover · ${Math.round(distance(car, boots))} m`;
        if (atCar) {
          action = 'Load sample';
          if (used) mission.load(car, boots);
        }
      } else if (site && mission.cargo.length < cargoCapacity && distance(car, site) <= 14) {
        const exposed = site.strokes >= uncoverStrokes;
        guidance = exposed
          ? `${minerals[site.mineral].name} exposed`
          : `Excavating signal ${mission.sites.indexOf(site) + 1} · ${site.strokes}/${uncoverStrokes}`;
        action = exposed ? 'Pick up sample' : 'Dig';
        if (used && !this.swing) {
          this.yaw = Math.atan2(site.x - boots.x, boots.z - site.z);
          this.field.boots.rotation.y = -this.yaw;
          const cut = mission.workSite(boots, car);
          if (cut) {
            if (cut.strokes === 1)
              this.field.burySample(mission.sites.indexOf(cut), this.surface(cut.x, cut.z));
            this.o.chunks.setExcavationDepth(cut, cut.strokes * 0.32);
            this.swing = 1;
          }
        }
      } else {
        guidance =
          mission.cargo.length >= cargoCapacity
            ? 'Cargo full. Drive back to base B.'
            : site
              ? 'Park the rover within 14 m of this signal.'
              : 'Walk to a numbered survey stake. W/S walk · A/D turn.';
        if (atCar) {
          action = 'Board rover';
          if (used) this.board();
        }
      }
      if (used) this.field.syncSamples(mission, this.model.root);
    }
    return { action, guidance };
  }

  updateCamera(dt: number) {
    const cam = this.o.camera;
    if (this.mission.phase === 'base') {
      const { x, y, z } = this.field.habitat.position;
      cam.position.set(x + 0.05, y + 1.58, z + 1.45);
      cam.lookAt(x + 0.05, y + 1.45, z - 1.3);
    } else {
      this.look.copy(this.field.boots.position);
      this.look.y += 1;
      this.goal.copy(this.look);
      this.goal.x -= Math.sin(this.yaw) * 3.7;
      this.goal.z += Math.cos(this.yaw) * 3.7;
      this.goal.y += 1.55;
      cam.position.lerp(this.goal, 1 - Math.exp(-9 * dt));
      cam.position.y = Math.max(cam.position.y, this.surface(cam.position.x, cam.position.z) + 0.3);
      cam.lookAt(this.look);
    }
  }
  private clearPits() {
    for (const site of this.mission.sites)
      if (site.strokes) this.o.chunks.setExcavationDepth(site, 0);
  }
  dispose() {
    this.clearPits();
    this.hud.dispose();
    this.field.dispose();
    for (const c of this.stationColliders) this.world.removeCollider(c, true);
  }
}
