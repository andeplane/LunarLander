import {
  BoxGeometry,
  type BufferGeometry,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  OctahedronGeometry,
  SphereGeometry,
} from 'three';
import { LANDER_CONFIG } from '../lander/config';
import { LanderVisuals } from '../lander/LanderVisuals';
import { type Expedition, type Mineral, minerals } from './Expedition';

export class FieldModels {
  readonly root = new Group();
  readonly boots = new Group();
  readonly lander = new LanderVisuals();
  readonly habitat = new Group();
  private readonly shovelArm = new Group();
  private readonly legs = [new Group(), new Group()];
  private readonly resources = new Set<{ dispose(): void }>();
  private readonly shell = new Group();
  private readonly interior = new Group();
  private readonly specimens: Record<Mineral, BufferGeometry> = {
    monazite: new IcosahedronGeometry(0.21, 0).scale(0.85, 1.05, 0.78),
    xenotime: new CylinderGeometry(0.07, 0.15, 0.32, 4).rotateZ(0.22),
    gold: new IcosahedronGeometry(0.2, 0).scale(1.22, 0.72, 0.85),
    diamond: new OctahedronGeometry(0.21),
  };
  private readonly displaySamples = new Map<Mineral, Mesh>();
  private readonly signals = new Group();
  private readonly samples: Mesh[] = [];
  private readonly buriedY: number[] = [];
  private readonly held = new Group();
  private readonly poles: Group[] = [];

  private part(
    parent: Object3D,
    geo: BufferGeometry,
    color: number,
    x: number,
    y: number,
    z: number
  ) {
    const material = new MeshStandardMaterial({ color, roughness: 0.78 });
    this.resources.add(geo);
    this.resources.add(material);
    const mesh = new Mesh(geo, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }
  private box(
    parent: Object3D,
    color: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number
  ) {
    return this.part(parent, new BoxGeometry(w, h, d), color, x, y, z);
  }
  private oval(
    parent: Object3D,
    color: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number
  ) {
    const mesh = this.part(parent, new SphereGeometry(1, 16, 12), color, x, y, z);
    mesh.scale.set(w, h, d);
    return mesh;
  }

  constructor(baseX: number, baseZ: number, height: (x: number, z: number) => number) {
    this.root.add(this.boots, this.lander.group, this.habitat, this.signals);
    this.lander.setExteriorVisible(true);
    this.lander.group.position.set(
      baseX - 8,
      height(baseX - 8, baseZ) + LANDER_CONFIG.gearHeight,
      baseZ
    );
    this.habitat.position.set(baseX - 6, height(baseX - 6, baseZ + 8), baseZ + 8);
    const white = 0xd5d2c5,
      dark = 0x524e49,
      red = 0xad422c;
    this.habitat.add(this.shell);
    this.part(this.shell, new CylinderGeometry(2.4, 2.6, 2.4, 12), white, 0, 1.15, 0);
    this.oval(this.shell, white, 0, 2.35, 0, 2.4, 0.95, 2.4);
    this.box(this.shell, dark, 2.4, 0.9, 0, 0.45, 1.9, 1.2);
    this.box(this.shell, 0xe2aa5a, 2.64, 1.1, 0, 0.06, 1.3, 0.86);
    this.buildVault();
    // A standing pressure suit with a gold visor, life-support pack and articulated spade.
    this.oval(this.boots, white, 0, 1.06, 0, 0.28, 0.43, 0.2);
    this.box(this.boots, 0xb4ad98, 0, 1.14, 0.22, 0.4, 0.54, 0.25);
    this.box(this.boots, dark, 0, 1.23, -0.18, 0.27, 0.15, 0.08);
    this.oval(this.boots, white, 0, 1.63, 0, 0.239, 0.25, 0.225);
    this.oval(this.boots, 0x77552a, 0, 1.63, -0.125, 0.21, 0.177, 0.145);
    this.legs.forEach((leg, i) => {
      const x = i ? 0.145 : -0.145;
      this.boots.add(leg);
      leg.position.set(x, 0.78, 0);
      this.oval(leg, white, 0, -0.32, 0, 0.127, 0.37, 0.127);
      this.oval(leg, dark, 0, -0.68, -0.045, 0.13, 0.1, 0.19);
      const arm = i ? this.shovelArm : new Group();
      this.boots.add(arm);
      arm.position.set(x * 2, 1.37, 0);
      this.oval(arm, white, 0, -0.21, 0, 0.095, 0.25, 0.1);
      this.oval(arm, red, 0, -0.15, 0, 0.099, 0.04, 0.102);
      this.oval(arm, dark, 0, -0.45, -0.04, 0.078, 0.09, 0.075);
      if (!i) arm.add(this.held);
    });
    this.held.position.set(-0.07, -0.52, -0.04);
    const spade = new Group();
    spade.position.set(0.01, -0.41, -0.05);
    spade.rotation.x = 0.52;
    this.shovelArm.add(spade);
    this.part(spade, new CylinderGeometry(0.022, 0.022, 1.15, 8), 0x99938a, 0, -0.27, 0);
    this.oval(spade, 0xaaa49a, 0, -0.88, 0, 0.12, 0.2, 0.045);
    this.boots.visible = false;
  }
  private buildVault() {
    this.habitat.add(this.interior);
    const lining = 0xa3afa9,
      steel = 0x354247,
      trim = 0x73827e;
    // Leave an observation window in the forward bulkhead, looking toward the LM.
    this.box(this.interior, lining, 0, 0.45, -1.55, 3.85, 0.9, 0.12);
    this.box(this.interior, lining, 0, 2.41, -1.55, 3.85, 0.55, 0.12);
    this.box(this.interior, lining, -1.78, 1.53, -1.55, 0.32, 1.25, 0.12);
    this.box(this.interior, lining, 1.03, 1.53, -1.55, 1.8, 1.25, 0.12);
    for (const y of [0.9, 2.12]) this.box(this.interior, steel, -0.73, y, -1.45, 1.85, 0.08, 0.15);
    for (const x of [-1.63, 0.17])
      this.box(this.interior, steel, x, 1.51, -1.45, 0.075, 1.27, 0.15);
    for (const side of [-1, 1]) this.box(this.interior, lining, side * 1.9, 1.4, 0, 0.12, 2.8, 3.1);
    this.box(this.interior, steel, 0, 0.08, 0, 3.85, 0.16, 3.8);
    this.box(this.interior, lining, 0, 2.68, 0, 3.85, 0.14, 3.8);
    for (const z of [-1, 0, 1]) this.box(this.interior, trim, 0, 2.57, z, 3.8, 0.11, 0.12);
    this.box(this.interior, steel, 0.98, 1.4, -1.4, 1.53, 1.47, 0.14);
    for (const y of [0.75, 1.43, 2.1])
      this.box(this.interior, trim, 0.98, y, -1.2, 1.57, 0.06, 0.45);
    for (const x of [0.21, 0.98, 1.75])
      this.box(this.interior, trim, x, 1.44, -1.19, 0.05, 1.39, 0.46);
    (Object.keys(minerals) as Mineral[]).forEach((key, i) => {
      const x = 0.59 + (i % 2) * 0.77,
        y = 1.46 - Math.floor(i / 2) * 0.68;
      this.part(
        this.interior,
        new CylinderGeometry(0.205, 0.23, 0.055, 20),
        trim,
        x,
        y + 0.024,
        -1.18
      );
      const sample = this.part(this.interior, this.specimens[key], 0xffffff, x, y + 0.205, -1.18);
      sample.material.color.set(minerals[key].color);
      this.displaySamples.set(key, sample);
    });
    this.interior.traverse((part) => {
      if (part instanceof Mesh) {
        part.material.emissive.copy(part.material.color);
        part.material.emissiveIntensity = 0.43;
      }
    });
  }
  showVault(mission: Expedition) {
    this.interior.visible = mission.phase === 'base';
    this.shell.visible = !this.interior.visible;
    for (const [key, mesh] of this.displaySamples) mesh.visible = mission.collection[key] > 0;
  }
  setSites(mission: Expedition, height: (x: number, z: number) => number) {
    // Reuse four survey markers and specimens between surveys.
    for (const [i, site] of mission.sites.entries()) {
      if (!this.samples[i]) {
        const pole = new Group();
        this.signals.add(pole);
        this.part(pole, new CylinderGeometry(0.024, 0.038, 1.15, 8), 0xb8b6a5, 0, 0.575, 0);
        this.box(pole, 0xe4aa52, 0, 1.08, 0, 0.32, 0.18, 0.1);
        this.poles.push(pole);
        this.samples.push(this.part(this.root, this.specimens[site.mineral], 0xffffff, 0, 0, 0));
      }
      this.burySample(i, height(site.x, site.z));
      const pole = this.poles[i];
      pole.position.set(site.x + 2, height(site.x + 2, site.z), site.z);
      this.samples[i].geometry = this.specimens[site.mineral];
      (this.samples[i].material as MeshStandardMaterial).color.set(minerals[site.mineral].color);
    }
  }
  burySample(index: number, surface: number) {
    this.buriedY[index] = surface - 0.73;
  }
  syncSamples(mission: Expedition, rover: Group) {
    let slot = 0;
    mission.sites.forEach((site, i) => {
      const mesh = this.samples[i];
      this.poles[i].visible = site.location === 'ground';
      mesh.visible =
        site.location === 'cargo' ||
        site.location === 'hand' ||
        (site.location === 'ground' && site.strokes > 0);
      if (site.location === 'ground') {
        this.root.add(mesh);
        // The specimen stays buried at its original elevation as the surface lowers.
        mesh.position.set(site.x, this.buriedY[i], site.z);
      } else if (site.location === 'hand') {
        this.held.add(mesh);
        mesh.position.set(0, 0, 0);
      } else if (site.location === 'cargo') {
        rover.add(mesh);
        mesh.position.set((slot++ - 1) * 0.3, 0.76, 0.94);
      } else this.root.add(mesh);
    });
  }
  animate(stride: number, moving: boolean, swing: number) {
    this.legs.forEach((leg, i) => {
      leg.rotation.x = moving ? Math.sin(stride + i * Math.PI) * 0.43 : 0;
    });
    this.shovelArm.rotation.x = -0.2 + Math.sin(swing * Math.PI * 2) * 0.86;
  }
  dispose() {
    for (const sample of this.samples) sample.removeFromParent();
    this.root.removeFromParent();
    this.lander.dispose();
    for (const resource of this.resources) resource.dispose();
  }
}
