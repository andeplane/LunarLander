import {
  BufferGeometry,
  CanvasTexture,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MultiplyBlending,
  Object3D,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Vector3,
} from 'three';
import type { PebbleGroundSampler } from '../terrain/PebbleSurface';
import { type RoverBody, WHEELS } from './RoverBody';

function imprint() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) throw new Error('Rover tread needs a 2D canvas');
  const dirt = g.createLinearGradient(0, 0, 64, 0);
  for (const [p, color] of [
    [0, 'white'],
    [0.12, '#d4d4d4'],
    [0.5, '#dedede'],
    [0.88, '#d4d4d4'],
    [1, 'white'],
  ] as const)
    dirt.addColorStop(p, color);
  g.fillStyle = dirt;
  g.fillRect(0, 0, 64, 64);
  for (const y of [-12, 19, 50]) {
    g.strokeStyle = '#b6b6b6';
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(6, y);
    g.lineTo(32, y + 19);
    g.lineTo(58, y);
    g.stroke();
  }
  return new CanvasTexture(c);
}

// Fixed-size pools. Treads use the slope of the displayed triangle; grains
// follow vacuum ballistics until they meet the ground again.
export class RoverTrail {
  readonly root = new Group();
  private readonly tracks = new InstancedMesh(
    new PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({
      map: imprint(),
      color: 0xffffff,
      blending: MultiplyBlending,
      premultipliedAlpha: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
    2048
  );
  private readonly last = WHEELS.map(() => new Vector3(NaN, 0, 0));
  private readonly particles = new Float32Array(192 * 3);
  private readonly velocities = new Float32Array(this.particles.length);
  private readonly lifetimes = new Float32Array(this.particles.length / 3);
  private readonly grains = new Points(
    new BufferGeometry(),
    new PointsMaterial({
      color: 0x8f867b,
      size: 0.014,
      sizeAttenuation: true,
      depthWrite: false,
    })
  );
  private readonly sample = new Float32Array(4);
  private readonly delta = new Vector3();
  private readonly tilt = new Vector3();
  private readonly right = new Vector3();
  private readonly stamp = new Object3D();
  private readonly basis = new Matrix4();
  private trackIndex = 0;
  private grainIndex = 0;
  private clock = 0;
  constructor(private readonly ground: PebbleGroundSampler) {
    this.tracks.count = 0;
    this.tracks.instanceMatrix.setUsage(DynamicDrawUsage);
    this.tracks.frustumCulled = this.grains.frustumCulled = false;
    this.particles.fill(-1e6);
    this.grains.geometry.setAttribute(
      'position',
      new Float32BufferAttribute(this.particles, 3).setUsage(DynamicDrawUsage)
    );
    this.root.add(this.tracks, this.grains);
  }

  update(b: RoverBody) {
    const dt = b.elapsed - this.clock;
    this.clock = b.elapsed;
    if (dt <= 0) return;
    for (const [i, p] of b.contacts.entries()) {
      const last = this.last[i];
      if (
        !b.contacting[i] ||
        !this.ground(p.x, p.z, this.sample, 0) ||
        Math.abs(p.y - this.sample[3]) > 0.16
      ) {
        last.x = NaN;
        continue;
      }
      this.delta.subVectors(p, last);
      const len = this.delta.length();
      if (!Number.isFinite(len) || len > 1.2) {
        last.copy(p);
        continue;
      }
      if (len < 0.15) continue;
      this.tilt.fromArray(this.sample).normalize();
      this.right.crossVectors(this.tilt, this.delta).normalize();
      this.delta.crossVectors(this.right, this.tilt).normalize();
      this.basis.makeBasis(this.right, this.tilt, this.delta);
      this.stamp.quaternion.setFromRotationMatrix(this.basis);
      this.stamp.position.copy(last).lerp(p, 0.5);
      this.stamp.position.y = (this.sample[3] + last.y) * 0.5 + 0.004;
      this.stamp.scale.set(0.216, 1, len + 0.008);
      this.stamp.updateMatrix();
      this.tracks.setMatrixAt(this.trackIndex, this.stamp.matrix);
      this.trackIndex = (this.trackIndex + 1) % this.tracks.instanceMatrix.count;
      this.tracks.count = Math.min(this.tracks.count + 1, this.tracks.instanceMatrix.count);
      this.tracks.instanceMatrix.needsUpdate = true;
      last.copy(p);
      if (Math.abs(b.speed) < 0.9) continue;
      for (let j = 0; j < 3; j++) {
        const k = this.grainIndex,
          offset = 3 * k;
        this.grainIndex = (k + 1) % this.lifetimes.length;
        const scatter = (Math.random() - 0.5) * 0.55;
        this.particles[offset] = p.x + this.right.x * scatter * 0.35;
        this.particles[offset + 1] = p.y + 0.055;
        this.particles[offset + 2] = p.z + this.right.z * scatter * 0.35;
        const kick = Math.abs(b.speed) * (0.12 + Math.random() * 0.3);
        this.velocities[offset] = -this.delta.x * kick + this.right.x * scatter;
        this.velocities[offset + 1] = 0.15 + kick * 0.65;
        this.velocities[offset + 2] = -this.delta.z * kick + this.right.z * scatter;
        this.lifetimes[k] = 1.9;
      }
    }
    const pos = this.grains.geometry.getAttribute('position');
    for (let i = 0; i < this.lifetimes.length; i++) {
      if (this.lifetimes[i] <= 0) continue;
      const k = i * 3;
      this.lifetimes[i] -= dt;
      this.velocities[k + 1] -= 1.62 * dt;
      for (let a = 0; a < 3; a++) this.particles[k + a] += this.velocities[k + a] * dt;
      const x = this.particles[k],
        y = this.particles[k + 1],
        z = this.particles[k + 2];
      if (
        this.lifetimes[i] <= 0 ||
        (this.velocities[k + 1] < 0 && this.ground(x, z, this.sample, 0) && y < this.sample[3])
      ) {
        this.lifetimes[i] = 0;
        pos.setXYZ(i, 0, -1e6, 0);
      } else pos.setXYZ(i, x, y, z);
    }
    pos.needsUpdate = true;
  }

  dispose() {
    this.root.removeFromParent();
    this.tracks.material.map?.dispose();
    this.tracks.material.dispose();
    this.tracks.geometry.dispose();
    this.tracks.dispose();
    this.grains.material.dispose();
    this.grains.geometry.dispose();
  }
}
