import RAPIER from '@dimforge/rapier3d-compat';
import { MathUtils, Quaternion, Vector3 } from 'three';
import type { PhysicsStepListener } from '../physics/PhysicsWorld';

// Apollo LRV wheelbase 2.3 m, track 1.83 m, 32-inch wheels. Local forward is -Z.
export const WHEEL_RADIUS = 0.406;
export const REST_LENGTH = 0.24;
export const WHEELS = [
  { x: -0.915, z: -1.15 },
  { x: 0.915, z: -1.15 },
  { x: -0.915, z: 1.15 },
  { x: 0.915, z: 1.15 },
];

// Parking and chase-camera queries must pass through every collider on the rover.
export function castEnvironmentRay(
  world: RAPIER.World,
  ray: RAPIER.Ray,
  distance: number,
  rover?: RoverBody
) {
  return world.castRay(
    ray,
    distance,
    true,
    RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
    undefined,
    undefined,
    rover?.chassis
  );
}

export class RoverBody implements PhysicsStepListener {
  readonly chassis: RAPIER.RigidBody;
  private readonly vehicle: RAPIER.DynamicRayCastVehicleController;
  readonly position = new Vector3();
  readonly rotation = new Quaternion();
  elapsed = 0;
  readonly contacts = WHEELS.map(() => new Vector3());
  readonly contacting = WHEELS.map(() => false);
  readonly lengths = WHEELS.map(() => REST_LENGTH);
  readonly angles = WHEELS.map(() => 0);
  readonly spins = WHEELS.map(() => 0);
  private readonly lastPosition = new Vector3();
  private readonly currentRotation = new Quaternion();
  private readonly lastRotation = new Quaternion();
  private readonly forward = new Vector3();
  throttle = 0;
  steer = 0;
  brake = false;
  speed = 0;
  distance = 0;
  grounded = 0;
  private steering = 0;

  constructor(
    private readonly world: RAPIER.World,
    spawn: Vector3
  ) {
    this.chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setCanSleep(false)
        .setCcdEnabled(true)
        .setAngularDamping(0.09)
    );
    // Loaded rover with one suited driver and equipment. A second shape
    // represents the raised rear stowage and lets the chassis come to rest inverted.
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.6, 0.12, 1.25).setMass(365).setFriction(0.65),
      this.chassis
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.48, 0.29, 0.27).setTranslation(0, 0.38, 0.93).setMass(55),
      this.chassis
    );
    this.vehicle = world.createVehicleController(this.chassis);
    this.vehicle.indexUpAxis = 1;
    this.vehicle.setIndexForwardAxis = 2;
    for (const [i, wheel] of WHEELS.entries()) {
      this.vehicle.addWheel(
        { ...wheel, y: 0 },
        { x: 0, y: -1, z: 0 },
        { x: 1, y: 0, z: 0 },
        REST_LENGTH,
        WHEEL_RADIUS
      );
      this.vehicle.setWheelSuspensionStiffness(i, 9);
      this.vehicle.setWheelSuspensionCompression(i, 1.55);
      this.vehicle.setWheelSuspensionRelaxation(i, 1.9);
      this.vehicle.setWheelMaxSuspensionTravel(i, 0.19);
      this.vehicle.setWheelMaxSuspensionForce(i, 1700);
      this.vehicle.setWheelFrictionSlip(i, 1.05);
      this.vehicle.setWheelSideFrictionStiffness(i, 0.9);
    }
    this.reset(spawn);
  }

  reset(spawn: Vector3, yaw = 0): void {
    this.position.copy(spawn);
    this.rotation.setFromAxisAngle(this.forward.set(0, 1, 0), yaw);
    this.chassis.setTranslation(spawn, true);
    this.chassis.setRotation(this.rotation, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.lastPosition.copy(spawn);
    this.lastRotation.copy(this.rotation);
    this.speed = this.steering = 0;
    this.angles.fill(0);
    this.lengths.fill(REST_LENGTH);
  }

  beforePhysicsStep(dt: number): void {
    this.lastPosition.copy(this.chassis.translation());
    this.lastRotation.copy(this.chassis.rotation());
    this.elapsed += dt;
    const velocity = this.chassis.linvel();
    this.forward.set(0, 0, -1).applyQuaternion(this.lastRotation);
    this.speed = this.forward.dot(velocity);
    const speed = Math.abs(this.speed);
    const targetSteer = (this.steer * 0.46) / (1 + 0.16 * speed);
    this.steering = MathUtils.damp(this.steering, targetSteer, 5.5, dt);
    const opposing = this.throttle * this.speed < -0.14;
    const stopping = this.brake || opposing;
    // Torque-limited at low speed, power-limited higher up. Four 1/4-hp
    // hub motors; the governor tapers traction near 14 km/h on level ground.
    const maxSpeed = this.throttle < 0 ? 1.65 : 3.9;
    const motor =
      Math.min(90, 186 / Math.max(1, speed)) * MathUtils.clamp((maxSpeed - speed) / 0.45, 0, 1);
    const drive = stopping ? 0 : this.throttle * motor;
    const brakeImpulse = stopping ? 150 * dt : this.throttle === 0 ? 6 * dt : 0;
    for (const [i, wheel] of WHEELS.entries()) {
      // Counter-steering axles with concentric inside/outside wheel paths.
      const turn = Math.tan(this.steering);
      this.angles[i] = Math.atan((-wheel.z * turn) / (1.15 + wheel.x * turn));
      this.vehicle.setWheelSteering(i, this.angles[i]);
      this.vehicle.setWheelEngineForce(i, drive);
      this.vehicle.setWheelBrake(i, brakeImpulse);
    }
    this.vehicle.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC);
    this.grounded = 0;
    for (const i of WHEELS.keys()) {
      this.lengths[i] = this.vehicle.wheelSuspensionLength(i) ?? REST_LENGTH;
      this.spins[i] = this.vehicle.wheelRotation(i) ?? 0;
      const point = this.vehicle.wheelIsInContact(i) ? this.vehicle.wheelContactPoint(i) : null;
      this.contacting[i] = point !== null;
      if (point) {
        this.contacts[i].copy(point);
        this.grounded++;
      }
    }
    this.distance += Math.hypot(velocity.x, velocity.z) * dt;
  }

  afterPhysicsSync(alpha: number): boolean {
    this.position.copy(this.lastPosition).lerp(this.chassis.translation(), alpha);
    this.rotation
      .copy(this.lastRotation)
      .slerp(this.currentRotation.copy(this.chassis.rotation()), alpha);
    return true;
  }

  dispose(): void {
    this.world.removeVehicleController(this.vehicle);
    this.world.removeRigidBody(this.chassis);
  }
}
