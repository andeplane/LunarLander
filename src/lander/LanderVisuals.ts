/**
 * Lander visuals (ADR-0003 §2): the NASA Apollo Lunar Module glTF model
 * (public/models/apollo-lm.glb, from nasa/NASA-3D-Resources) for the
 * exterior, plus a procedural interior cockpit shell — dark panels + window
 * struts that give the fixed reference frame that makes tilt readable
 * against a barren surface. Everything is a child of the physics-synced rig.
 *
 * The exterior is scaled so the foot pads sit at the collider gear height
 * and is only shown to external (orbit/aftermath) cameras: the cockpit eye
 * sits inside the ascent stage and the belly camera inside the descent
 * stage, where the model's own geometry would fill the frame.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CurvedStandardMaterial } from '../shaders/CurvedStandardMaterial';
import { LANDER_CONFIG } from './config';

/** Model-space extents of apollo-lm.glb (feet at y≈0.1, top at y≈5.1). */
const MODEL_FOOT_Y = 0.1;
const MODEL_HEIGHT = 5.0;
/** Real LM: ~7 m tall on a ~9.4 m footprint. Scaled to the collider rig. */
const MODEL_SCALE = (LANDER_CONFIG.gearHeight + LANDER_CONFIG.bodyHalfExtents.y + 0.3) / MODEL_HEIGHT;

export class LanderVisuals {
  /** Attach this to the LanderBody rig. */
  readonly group = new THREE.Group();

  /** Exterior model root (hidden in cockpit view). */
  private readonly exterior = new THREE.Group();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private disposed = false;

  constructor(modelUrl = `${import.meta.env.BASE_URL}models/apollo-lm.glb`) {
    const cfg = LANDER_CONFIG;

    // Feet at the collider gear height; model +Z faces the hatch, our
    // forward is -Z, so spin it round.
    this.exterior.scale.setScalar(MODEL_SCALE);
    this.exterior.position.y = -cfg.gearHeight - MODEL_FOOT_Y * MODEL_SCALE;
    this.exterior.rotation.y = Math.PI;
    this.group.add(this.exterior);
    this.loadModel(modelUrl);

    this.buildCockpit();
  }

  /** Only external (orbit/aftermath) cameras show the exterior model. */
  setExteriorVisible(visible: boolean): void {
    this.exterior.visible = visible;
  }

  private loadModel(url: string): void {
    new GLTFLoader().load(
      url,
      (gltf) => {
        if (this.disposed) return;
        // Swap the glTF materials for curvature-aware ones so the craft
        // follows the same planet curvature as the terrain (ADR-0003 §3)
        gltf.scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const source = mesh.material as THREE.MeshStandardMaterial;
          const curved = this.track(
            new CurvedStandardMaterial({
              color: source.color,
              map: source.map,
              roughness: Math.max(source.roughness, 0.55),
              metalness: source.metalness,
              side: THREE.FrontSide,
            })
          );
          mesh.material = curved;
          this.track(mesh.geometry);
        });
        this.exterior.add(gltf.scene);
      },
      undefined,
      (err) => console.warn('[Lander] Could not load lander model', err)
    );
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
    this.disposed = true;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
