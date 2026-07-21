/**
 * In-world mission markers (ADR-0003 §3): landing-pad ring + beacon and the
 * velocity-impact reticle. All markers use curvature-aware materials in
 * flat world coordinates — at the 800 m spawn offset the terrain is
 * visually ~64 m below its flat height, so plain materials would float in
 * the sky (ADR review finding).
 */
import * as THREE from 'three';
import { CurvedStandardMaterial } from '../shaders/CurvedStandardMaterial';
import { LANDER_CONFIG } from './config';

export class MissionMarkers {
  private scene: THREE.Scene;
  private readonly padGroup = new THREE.Group();
  private readonly impactReticle: THREE.Mesh;
  private readonly beacon: THREE.Mesh;
  private readonly beaconMat: CurvedStandardMaterial;
  private readonly ring: THREE.Mesh;
  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;

    // Pad ring: flat on the terrain, emissive green
    this.ring = new THREE.Mesh(
      this.track(new THREE.RingGeometry(0.82, 1.0, 48)),
      this.track(
        new CurvedStandardMaterial({
          color: 0x0a2012,
          emissive: 0x2dff7a,
          emissiveIntensity: 0.9,
          roughness: 1,
          metalness: 0,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        })
      )
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.padGroup.add(this.ring);

    // Beacon: tall thin light column, bright enough to bloom (threshold .85)
    this.beaconMat = this.track(
      new CurvedStandardMaterial({
        color: 0x061008,
        emissive: 0x54ffa0,
        emissiveIntensity: 2.2,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      })
    );
    this.beacon = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.5, 0.9, 130, 12, 1, true)),
      this.beaconMat
    );
    this.beacon.position.y = 65;
    this.padGroup.add(this.beacon);

    this.padGroup.visible = false;
    scene.add(this.padGroup);

    // Impact reticle: where the lander touches down at current velocity
    this.impactReticle = new THREE.Mesh(
      this.track(new THREE.RingGeometry(0.55, 0.75, 32)),
      this.track(
        new CurvedStandardMaterial({
          color: 0x201205,
          emissive: 0xffb347,
          emissiveIntensity: 1.1,
          roughness: 1,
          metalness: 0,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
        })
      )
    );
    this.impactReticle.rotation.x = -Math.PI / 2;
    this.impactReticle.visible = false;
    scene.add(this.impactReticle);
  }

  /** Place and show the pad marker (y = terrain height at the pad center). */
  setPad(x: number, y: number, z: number, radius: number): void {
    this.padGroup.position.set(x, y + 0.15, z);
    this.ring.scale.setScalar(radius);
    this.padGroup.visible = true;
  }

  hidePad(): void {
    this.padGroup.visible = false;
  }

  getPadPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.padGroup.position);
  }

  /** Pulse the beacon (call per frame with elapsed seconds). */
  updateBeacon(timeS: number): void {
    this.beaconMat.emissiveIntensity = 1.6 + 0.9 * Math.sin(timeS * 3.5);
  }

  /**
   * Project the ballistic touchdown point from the current state and place
   * the reticle there.
   *
   * @param position body position
   * @param velocity body velocity
   * @param groundHeightAt terrain height lookup (null = unknown → hide)
   */
  updateImpactReticle(
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    groundHeightAt: (x: number, z: number) => number | null
  ): void {
    // Time to fall to the ground under gravity from current vertical state:
    // solve y + vy·t − g/2·t² = ground. Iterate twice since ground height
    // moves with the horizontal projection.
    const g = LANDER_CONFIG.gravity;
    let groundY = groundHeightAt(position.x, position.z);
    if (groundY === null) {
      this.impactReticle.visible = false;
      return;
    }
    let t = 0;
    for (let i = 0; i < 2; i++) {
      const drop = position.y - LANDER_CONFIG.gearHeight - groundY;
      if (drop <= 0) {
        t = 0;
        break;
      }
      const vy = velocity.y;
      // 0.5·g·t² − vy·t − drop = 0 → t = (vy + √(vy² + 2·g·drop)) / g
      t = (vy + Math.sqrt(vy * vy + 2 * g * drop)) / g;
      const gx = position.x + velocity.x * t;
      const gz = position.z + velocity.z * t;
      const h = groundHeightAt(gx, gz);
      if (h === null) break;
      groundY = h;
    }
    const ix = position.x + velocity.x * t;
    const iz = position.z + velocity.z * t;
    const iy = groundHeightAt(ix, iz);
    if (iy === null) {
      this.impactReticle.visible = false;
      return;
    }
    this.impactReticle.position.set(ix, iy + 0.12, iz);
    this.impactReticle.visible = true;
  }

  hideImpactReticle(): void {
    this.impactReticle.visible = false;
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  dispose(): void {
    this.scene.remove(this.padGroup);
    this.scene.remove(this.impactReticle);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
