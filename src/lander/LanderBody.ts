/**
 * LanderBody — the lander's Rapier rigid body, control loop, and
 * render-interpolated rig (ADR-0002).
 *
 * Compound collider: hull cuboid + 4 leg-foot balls + a fuel-tank cuboid
 * whose mass drains as fuel burns (collider.setMass → Rapier recomputes
 * mass properties, so angular inertia tracks the burn and handling gets
 * crisper late in the descent).
 *
 * All forces are applied as per-step impulses (applyImpulse /
 * applyTorqueImpulse) — Rapier's addForce/addTorque are persistent
 * accumulators and must not be used per-step (ADR-0002 §6).
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsStepListener } from '../physics/PhysicsWorld';
import { AttitudeController } from './attitudeControl';
import { EngineModel, hoverThrottle } from './engineModel';
import type { LanderControls } from './LanderControls';
import { LANDER_CONFIG } from './config';

/** Per-physics-step sample for game-loop grading (ADR-0004 §2). */
export interface LanderStepSample {
  /** Number of leg feet currently in contact (0–4) */
  legContactCount: number;
  /** Hull (non-leg) touched something */
  bodyContact: boolean;
  /**
   * Velocity going INTO the step that produced the current contacts
   * (impact speed, not post-resolution speed).
   */
  impactVerticalSpeed: number;
  impactDriftSpeed: number;
  /** Current tilt from upright (degrees) */
  tiltDeg: number;
  /** Current total speed (m/s, post previous step) */
  speed: number;
  dt: number;
}

const FEET_ANGLES = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];

export class LanderBody implements PhysicsStepListener {
  private world: RAPIER.World;
  private body: RAPIER.RigidBody | null = null;
  private hullCollider: RAPIER.Collider | null = null;
  private tankCollider: RAPIER.Collider | null = null;
  private legColliders: RAPIER.Collider[] = [];

  readonly attitude = new AttitudeController();
  private engine: EngineModel = new EngineModel(LANDER_CONFIG.fuelMass);
  private controls: LanderControls;

  /** While frozen (briefing), the body is kinematic and control is inert. */
  private frozen = true;

  /** Render-interpolated transform target; meshes parent to this. */
  readonly rig = new THREE.Group();

  private onStep: ((sample: LanderStepSample) => void) | null = null;
  private onSync: (() => void) | null = null;

  // Interpolation snapshots
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currPos = new THREE.Vector3();
  private readonly currQuat = new THREE.Quaternion();

  // Reusable scratch
  private readonly quat = new THREE.Quaternion();
  private readonly localUp = new THREE.Vector3();
  private readonly angVel = new THREE.Vector3();
  private readonly impulse = new THREE.Vector3();
  private readonly torque = new THREE.Vector3();
  /** Velocity captured at the previous beforePhysicsStep (impact velocity) */
  private readonly prevStepVel = new THREE.Vector3();
  private readonly sample: LanderStepSample = {
    legContactCount: 0,
    bodyContact: false,
    impactVerticalSpeed: 0,
    impactDriftSpeed: 0,
    tiltDeg: 0,
    speed: 0,
    dt: 0,
  };
  private lastEffectiveThrottle = 0;

  constructor(world: RAPIER.World, controls: LanderControls) {
    this.world = world;
    this.controls = controls;
  }

  /** Register the per-step grading callback. */
  setOnStep(cb: ((sample: LanderStepSample) => void) | null): void {
    this.onStep = cb;
  }

  /** Called after each afterPhysicsSync — LanderMode re-syncs the camera. */
  setOnSync(cb: (() => void) | null): void {
    this.onSync = cb;
  }

  /**
   * Create (or reset) the physics body at a spawn state. The body starts
   * FROZEN (kinematic) until launch() — terrain colliders may still be
   * building underneath (ADR-0001 §6).
   */
  spawn(args: {
    position: THREE.Vector3;
    yawHeading: number;
    velocity: THREE.Vector3;
    fuelCapacityKg: number;
  }): void {
    this.despawn();

    const cfg = LANDER_CONFIG;
    // Frozen = dynamic body with all axes locked. (A kinematic body that
    // has been stepped never starts moving after setBodyType(Dynamic) in
    // rapier3d-compat 0.12 — verified empirically — so locking is the
    // reliable freeze mechanism.)
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(args.position.x, args.position.y, args.position.z)
      .setCcdEnabled(true)
      .lockTranslations()
      .lockRotations();
    this.body = this.world.createRigidBody(bodyDesc);

    this.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), args.yawHeading);
    this.body.setRotation(
      { x: this.quat.x, y: this.quat.y, z: this.quat.z, w: this.quat.w },
      true
    );

    // Hull (dry structure mass minus legs)
    const legMass = 50;
    const hullDesc = RAPIER.ColliderDesc.cuboid(
      cfg.bodyHalfExtents.x,
      cfg.bodyHalfExtents.y,
      cfg.bodyHalfExtents.z
    )
      .setMass(cfg.dryMass - 4 * legMass)
      .setFriction(0.8);
    this.hullCollider = this.world.createCollider(hullDesc, this.body);

    // Fuel tank: a small internal cuboid carrying the fuel mass. Draining
    // it via setMass() keeps angular inertia honest as fuel burns.
    const tankDesc = RAPIER.ColliderDesc.cuboid(0.8, 0.6, 0.8)
      .setTranslation(0, -0.3, 0)
      .setMass(args.fuelCapacityKg);
    this.tankCollider = this.world.createCollider(tankDesc, this.body);

    // Four leg feet on the diagonals
    this.legColliders = [];
    for (const angle of FEET_ANGLES) {
      const legDesc = RAPIER.ColliderDesc.ball(cfg.legFootRadius)
        .setTranslation(
          Math.cos(angle) * cfg.legRadialOffset,
          -cfg.gearHeight + cfg.legFootRadius,
          Math.sin(angle) * cfg.legRadialOffset
        )
        .setMass(legMass)
        .setFriction(1.0)
        .setRestitution(0.05);
      this.legColliders.push(this.world.createCollider(legDesc, this.body));
    }

    // Reset control/engine state
    this.attitude.reset(args.yawHeading);
    this.engine = new EngineModel(args.fuelCapacityKg);
    this.frozen = true;
    this.lastEffectiveThrottle = 0;

    // Spawn velocity is applied at launch(); store via prevStepVel misuse-
    // free copy (kinematic bodies ignore linvel until made dynamic).
    this.pendingLaunchVelocity.copy(args.velocity);

    // Seed transforms
    this.prevPos.copy(args.position);
    this.currPos.copy(args.position);
    this.prevQuat.copy(this.quat);
    this.currQuat.copy(this.quat);
    this.rig.position.copy(args.position);
    this.rig.quaternion.copy(this.quat);
    this.prevStepVel.set(0, 0, 0);
  }

  private readonly pendingLaunchVelocity = new THREE.Vector3();

  /** Unfreeze: unlock all axes and apply the mission's initial velocity. */
  launch(): void {
    if (!this.body || !this.frozen) return;
    this.body.lockTranslations(false, true);
    this.body.lockRotations(false, true);
    this.body.setLinvel(
      {
        x: this.pendingLaunchVelocity.x,
        y: this.pendingLaunchVelocity.y,
        z: this.pendingLaunchVelocity.z,
      },
      true
    );
    this.frozen = false;
  }

  isFrozen(): boolean {
    return this.frozen;
  }

  /** Remove the body and colliders from the physics world. */
  despawn(): void {
    if (this.body) {
      this.world.removeRigidBody(this.body); // removes attached colliders
      this.body = null;
      this.hullCollider = null;
      this.tankCollider = null;
      this.legColliders = [];
    }
  }

  // ---- PhysicsStepListener ----

  beforePhysicsStep(dt: number): void {
    if (!this.body) return;

    // Snapshot pre-step transform for interpolation
    const pos = this.body.translation();
    const rot = this.body.rotation();
    this.prevPos.set(pos.x, pos.y, pos.z);
    this.prevQuat.set(rot.x, rot.y, rot.z, rot.w);

    if (this.frozen) return;

    this.quat.set(rot.x, rot.y, rot.z, rot.w);
    const linvel = this.body.linvel();
    const angvel = this.body.angvel();
    this.angVel.set(angvel.x, angvel.y, angvel.z);

    // --- Grading sample: contacts are the result of the PREVIOUS step, so
    // pair them with the velocity going into that step (impact velocity) ---
    let legContacts = 0;
    for (const leg of this.legColliders) {
      if (this.isColliderTouching(leg)) legContacts++;
    }
    const bodyContact =
      this.hullCollider !== null && this.isColliderTouching(this.hullCollider);

    this.localUp.set(0, 1, 0).applyQuaternion(this.quat);
    const cosTilt = Math.min(Math.max(this.localUp.y, -1), 1);
    const tiltDeg = (Math.acos(cosTilt) * 180) / Math.PI;

    this.sample.legContactCount = legContacts;
    this.sample.bodyContact = bodyContact;
    this.sample.impactVerticalSpeed = -this.prevStepVel.y; // positive down
    this.sample.impactDriftSpeed = Math.hypot(this.prevStepVel.x, this.prevStepVel.z);
    this.sample.tiltDeg = tiltDeg;
    this.sample.speed = Math.hypot(linvel.x, linvel.y, linvel.z);
    this.sample.dt = dt;
    if (this.onStep) this.onStep(this.sample);

    // Record this step's incoming velocity for the next sample
    this.prevStepVel.set(linvel.x, linvel.y, linvel.z);

    // --- Engine ---
    if (this.controls.consumeHoverToggle()) {
      this.engine.toggleHoverHold();
    }
    const mass = this.body.mass();
    const engineResult = this.engine.step(
      dt,
      this.controls.consumeEngineInput(),
      mass,
      Math.max(cosTilt, 0),
      linvel.y
    );
    this.lastEffectiveThrottle = engineResult.effectiveThrottle;

    // Drain the tank collider so mass AND angular inertia track the burn
    if (engineResult.burnedKg > 0 && this.tankCollider) {
      // Rapier requires strictly positive collider mass in some builds;
      // keep a tiny floor
      this.tankCollider.setMass(Math.max(this.engine.getFuelKg(), 0.001));
    }

    // Thrust along local up, as a per-step impulse
    if (engineResult.thrustN > 0) {
      this.impulse.copy(this.localUp).multiplyScalar(engineResult.thrustN * dt);
      this.body.applyImpulse(
        { x: this.impulse.x, y: this.impulse.y, z: this.impulse.z },
        true
      );
    }

    // --- Attitude PD → torque impulse via world-frame effective inertia ---
    const response = this.attitude.update(
      dt,
      this.controls.getAttitudeCommand(),
      this.quat,
      this.angVel
    );
    const alpha = response.angularAcceleration;
    const inertia = this.body.effectiveAngularInertia();
    this.torque.set(
      inertia.m11 * alpha.x + inertia.m12 * alpha.y + inertia.m13 * alpha.z,
      inertia.m12 * alpha.x + inertia.m22 * alpha.y + inertia.m23 * alpha.z,
      inertia.m13 * alpha.x + inertia.m23 * alpha.y + inertia.m33 * alpha.z
    );
    this.torque.multiplyScalar(dt);
    this.body.applyTorqueImpulse(
      { x: this.torque.x, y: this.torque.y, z: this.torque.z },
      true
    );
  }

  /**
   * True when the collider has an actual contact point against another
   * collider. contactPairsWith alone is NOT sufficient: it enumerates
   * broad-phase (AABB) pairs, and a terrain heightfield's AABB spans the
   * whole chunk's height range — a lander flying far above rough terrain
   * would register as "touching". Only manifold points at ~zero distance
   * count as contact.
   */
  private isColliderTouching(collider: RAPIER.Collider): boolean {
    let touching = false;
    this.world.contactPairsWith(collider, (other) => {
      if (touching) return;
      this.world.contactPair(collider, other, (manifold) => {
        if (touching) return;
        const count = manifold.numContacts();
        for (let i = 0; i < count; i++) {
          if (manifold.contactDist(i) <= 0.01) {
            touching = true;
            return;
          }
        }
      });
    });
    return touching;
  }

  afterPhysicsSync(alpha: number): boolean {
    if (!this.body) return false;

    const pos = this.body.translation();
    const rot = this.body.rotation();
    this.currPos.set(pos.x, pos.y, pos.z);
    this.currQuat.set(rot.x, rot.y, rot.z, rot.w);

    this.rig.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.rig.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);

    if (this.onSync) this.onSync();

    if (this.frozen) return false;
    const linvel = this.body.linvel();
    const angvel = this.body.angvel();
    const moving =
      Math.hypot(linvel.x, linvel.y, linvel.z) > 0.01 ||
      Math.hypot(angvel.x, angvel.y, angvel.z) > 0.01 ||
      this.lastEffectiveThrottle > 0;
    return moving;
  }

  // ---- State accessors (physics truth, not interpolated) ----

  getEngine(): EngineModel {
    return this.engine;
  }

  /** Total current mass (kg), or full-spec mass before spawn. */
  getMass(): number {
    return this.body ? this.body.mass() : LANDER_CONFIG.dryMass + LANDER_CONFIG.fuelMass;
  }

  /** Copy current velocity into `out` (m/s, world). */
  getVelocity(out: THREE.Vector3): THREE.Vector3 {
    if (!this.body) return out.set(0, 0, 0);
    const v = this.body.linvel();
    return out.set(v.x, v.y, v.z);
  }

  /** Tilt from upright, degrees. */
  getTiltDeg(): number {
    this.localUp.set(0, 1, 0).applyQuaternion(this.rig.quaternion);
    return (Math.acos(Math.min(Math.max(this.localUp.y, -1), 1)) * 180) / Math.PI;
  }

  /** Pitch/roll relative to upright in the heading frame (degrees). */
  getPitchRollDeg(out: { pitch: number; roll: number }): void {
    // Decompose rig orientation as YXZ: y=heading, x=-pitch, z=-roll
    // (matches AttitudeController's target construction)
    const e = new THREE.Euler().setFromQuaternion(this.rig.quaternion, 'YXZ');
    out.pitch = (-e.x * 180) / Math.PI;
    out.roll = (-e.z * 180) / Math.PI;
  }

  /** Heading (yaw around world up) of the rig, radians. */
  getHeading(): number {
    const e = new THREE.Euler().setFromQuaternion(this.rig.quaternion, 'YXZ');
    return e.y;
  }

  /** Throttle needed to hover right now (HUD tick), 0..1. */
  getHoverThrottle(): number {
    this.localUp.set(0, 1, 0).applyQuaternion(this.rig.quaternion);
    return hoverThrottle(this.getMass(), Math.max(this.localUp.y, 0));
  }

  /**
   * Radar altitude: Rapier ray straight down from the body center to the
   * nearest collider (terrain), minus gear height (ADR-0003 §4). Returns
   * null when nothing is hit (no colliders under the lander yet).
   */
  raycastAltitudeAGL(): number | null {
    if (!this.body) return null;
    const pos = this.body.translation();
    const ray = new RAPIER.Ray({ x: pos.x, y: pos.y, z: pos.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(
      ray,
      2000,
      true,
      undefined,
      undefined,
      undefined,
      this.body
    );
    if (!hit) return null;
    return hit.toi - LANDER_CONFIG.gearHeight;
  }

  dispose(): void {
    this.despawn();
    this.onStep = null;
    this.onSync = null;
  }
}
