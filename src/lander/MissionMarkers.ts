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
  private readonly label: THREE.Mesh;
  private readonly labelMat: CurvedStandardMaterial;
  private labelTexture: THREE.CanvasTexture | null = null;
  private labelText = '';
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

    // Pad multiplier label (ADR-0004 §3: "shown on the pad beacon"). A
    // camera-facing plane with a canvas texture; a Sprite cannot be used
    // because its material is not curvature-aware and would float ~64 m
    // above the pad at spawn distance.
    this.labelMat = this.track(
      new CurvedStandardMaterial({
        color: 0x000000,
        emissive: 0xffffff,
        emissiveIntensity: 1.4,
        roughness: 1,
        metalness: 0,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.label = new THREE.Mesh(this.track(new THREE.PlaneGeometry(1, 1)), this.labelMat);
    this.label.position.y = 8; // re-placed per frame in updateBeacon()
    this.label.visible = false;
    this.padGroup.add(this.label);

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

  /**
   * Place and show the pad marker (y = terrain height at the pad center).
   * `multiplier` is drawn on the beacon label; omit (or pass 1) to hide it.
   */
  setPad(x: number, y: number, z: number, radius: number, multiplier = 1): void {
    this.padGroup.position.set(x, y + 0.15, z);
    this.ring.scale.setScalar(radius);
    this.padGroup.visible = true;
    this.setLabel(multiplier > 1 ? `×${Number.isInteger(multiplier) ? multiplier : multiplier.toFixed(1)}` : '');
  }

  private setLabel(text: string): void {
    if (text === this.labelText) return;
    this.labelText = text;
    if (!text) {
      this.label.visible = false;
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 84px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 4);

    this.labelTexture?.dispose();
    this.labelTexture = new THREE.CanvasTexture(canvas);
    this.labelTexture.colorSpace = THREE.SRGBColorSpace;
    this.labelMat.map = this.labelTexture;
    this.labelMat.emissiveMap = this.labelTexture;
    this.labelMat.needsUpdate = true;
    this.label.visible = true;
  }

  hidePad(): void {
    this.padGroup.visible = false;
  }

  getPadPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.padGroup.position);
  }

  /**
   * Pulse the beacon and turn the multiplier label toward the camera (call
   * per frame with elapsed seconds and the camera's world position).
   */
  updateBeacon(timeS: number, cameraPosition?: THREE.Vector3): void {
    this.beaconMat.emissiveIntensity = 1.6 + 0.9 * Math.sin(timeS * 3.5);
    if (cameraPosition && this.label.visible) {
      // Yaw-only billboard: rotate about the pad's up axis to face the camera
      const dx = cameraPosition.x - this.padGroup.position.x;
      const dz = cameraPosition.z - this.padGroup.position.z;
      this.label.rotation.y = Math.atan2(dx, dz);
      // Scale with distance (~10% of the range → roughly constant on-screen
      // size on the 500-800 m approach) but never below 8 m so it does not
      // loom up close. Sits 30 m up the beacon column, clear of the HUD's
      // pad designator which is drawn at the pad point itself.
      const dist = Math.hypot(dx, cameraPosition.y - this.padGroup.position.y, dz);
      const width = Math.max(8, dist * 0.1);
      this.label.scale.set(width, width / 2, 1);
      this.label.position.y = 30 + width / 4;
    }
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
    this.labelTexture?.dispose();
    this.scene.remove(this.padGroup);
    this.scene.remove(this.impactReticle);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
