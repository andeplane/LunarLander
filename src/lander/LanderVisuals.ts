/**
 * Placeholder lander geometry (ADR-0003 §2): exterior hull + legs (curved
 * materials, matching collider dimensions) and the interior cockpit shell —
 * dark panels + window struts that give the fixed reference frame that
 * makes tilt readable against a barren surface. Swappable for a GLTF model
 * later: everything is a child of the physics-synced rig.
 */
import * as THREE from 'three';
import { CurvedStandardMaterial } from '../shaders/CurvedStandardMaterial';
import { LANDER_CONFIG } from './config';

export class LanderVisuals {
  /** Attach this to the LanderBody rig. */
  readonly group = new THREE.Group();

  private readonly disposables: Array<{ dispose(): void }> = [];

  constructor() {
    const cfg = LANDER_CONFIG;

    // --- Exterior (visible when glancing down / in aftermath shots) ---
    const hullMat = this.track(
      new CurvedStandardMaterial({ color: 0xb8b0a4, roughness: 0.7, metalness: 0.5 })
    );
    const legMat = this.track(
      new CurvedStandardMaterial({ color: 0x8a8478, roughness: 0.8, metalness: 0.6 })
    );

    const hull = new THREE.Mesh(
      this.track(
        new THREE.BoxGeometry(
          cfg.bodyHalfExtents.x * 2,
          cfg.bodyHalfExtents.y * 2,
          cfg.bodyHalfExtents.z * 2
        )
      ),
      hullMat
    );
    this.group.add(hull);

    // Descent-stage skirt (octagonal cylinder, purely cosmetic)
    const skirt = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(1.9, 2.1, 0.8, 8)),
      legMat
    );
    skirt.position.y = -cfg.bodyHalfExtents.y - 0.3;
    this.group.add(skirt);

    // Legs: angled struts to the four diagonal feet + foot pads
    const legGeom = this.track(new THREE.CylinderGeometry(0.07, 0.09, 1, 6));
    const footGeom = this.track(new THREE.SphereGeometry(cfg.legFootRadius, 10, 8));
    const footY = -cfg.gearHeight + cfg.legFootRadius;
    for (const angle of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
      const foot = new THREE.Vector3(
        Math.cos(angle) * cfg.legRadialOffset,
        footY,
        Math.sin(angle) * cfg.legRadialOffset
      );
      const hip = new THREE.Vector3(
        Math.cos(angle) * cfg.bodyHalfExtents.x * 1.05,
        -cfg.bodyHalfExtents.y * 0.6,
        Math.sin(angle) * cfg.bodyHalfExtents.z * 1.05
      );
      const mid = foot.clone().add(hip).multiplyScalar(0.5);
      const strut = new THREE.Mesh(legGeom, legMat);
      strut.position.copy(mid);
      strut.scale.y = hip.distanceTo(foot);
      strut.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        foot.clone().sub(hip).normalize()
      );
      this.group.add(strut);

      const footMesh = new THREE.Mesh(footGeom, legMat);
      footMesh.position.copy(foot);
      this.group.add(footMesh);
    }

    // Engine bell
    const bell = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.35, 0.7, 0.7, 12, 1, true)),
      this.track(
        new CurvedStandardMaterial({
          color: 0x5c5650,
          roughness: 0.4,
          metalness: 0.9,
          side: THREE.DoubleSide,
        })
      )
    );
    bell.position.y = -cfg.bodyHalfExtents.y - 0.9;
    this.group.add(bell);

    // --- Interior cockpit shell (dark panels + window frame) ---
    // Built around the eye position; plain (non-curved) materials are fine
    // at centimeter range. Panels use BasicMaterial so they stay readable
    // black regardless of lighting; a faint emissive panel provides glow.
    this.buildCockpit();
  }

  private buildCockpit(): void {
    const cfg = LANDER_CONFIG;
    const eye = cfg.eyeOffset;
    const shellMat = this.track(
      new THREE.MeshBasicMaterial({ color: 0x0a0a0c, side: THREE.DoubleSide })
    );
    const strutMat = this.track(new THREE.MeshBasicMaterial({ color: 0x1a1c20 }));

    const cockpit = new THREE.Group();
    cockpit.position.set(eye.x, eye.y, eye.z);
    // The cockpit shell is pitched with the default view so the window
    // frames the forward-down line of sight symmetrically.
    cockpit.rotation.x = -cfg.cockpitViewPitchRad;

    // Window aperture in the front wall at z = -D
    const D = 0.75; // distance from eye to front wall
    const W = 1.7; // wall width
    const H = 1.3; // wall height
    const winW = 1.15;
    const winH = 0.78;
    const winCY = 0.02; // window center slightly above eye line

    const panel = (w: number, h: number, x: number, y: number, z: number, ry = 0, rx = 0) => {
      const mesh = new THREE.Mesh(this.track(new THREE.PlaneGeometry(w, h)), shellMat);
      mesh.position.set(x, y, z);
      mesh.rotation.set(rx, ry, 0);
      cockpit.add(mesh);
    };

    // Front wall around the window (top, bottom/sill wall, left, right)
    const sideW = (W - winW) / 2;
    panel(W, (H / 2) - (winCY + winH / 2), 0, (H / 2 + winCY + winH / 2) / 2, -D); // top strip
    panel(W, (H / 2) + (winCY - winH / 2), 0, (winCY - winH / 2 - H / 2) / 2, -D); // bottom strip
    panel(sideW, winH, -(winW + sideW) / 2, winCY, -D); // left strip
    panel(sideW, winH, (winW + sideW) / 2, winCY, -D); // right strip

    // Side walls, floor, ceiling, back wall (enclose the view)
    panel(2 * D, H, -W / 2, 0, 0, Math.PI / 2); // left
    panel(2 * D, H, W / 2, 0, 0, -Math.PI / 2); // right
    panel(W, 2 * D, 0, -H / 2, 0, 0, -Math.PI / 2); // floor
    panel(W, 2 * D, 0, H / 2, 0, 0, Math.PI / 2); // ceiling
    panel(W, H, 0, 0, D, Math.PI); // back

    // Window struts: two verticals dividing the pane, plus a center sill bar
    const strutGeom = this.track(new THREE.BoxGeometry(0.025, winH, 0.02));
    for (const x of [-winW / 6, winW / 6]) {
      const strut = new THREE.Mesh(strutGeom, strutMat);
      strut.position.set(x, winCY, -D + 0.005);
      cockpit.add(strut);
    }
    const sillBar = new THREE.Mesh(
      this.track(new THREE.BoxGeometry(winW, 0.03, 0.04)),
      strutMat
    );
    sillBar.position.set(0, winCY - winH / 2 + 0.015, -D + 0.01);
    cockpit.add(sillBar);

    // Faint instrument-panel glow below the sill
    const glow = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(winW * 0.9, 0.18)),
      this.track(
        new THREE.MeshBasicMaterial({
          color: 0x18324a,
          transparent: true,
          opacity: 0.85,
        })
      )
    );
    glow.position.set(0, winCY - winH / 2 - 0.14, -D + 0.02);
    glow.rotation.x = 0.5;
    cockpit.add(glow);

    this.group.add(cockpit);
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
