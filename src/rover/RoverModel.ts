import {
  BoxGeometry,
  type BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  EquirectangularReflectionMapping,
  Euler,
  Group,
  LatheGeometry,
  type Material,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  RGBAFormat,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { SUN_SHADOW_FRAGMENT_PARS, type SunShadows } from '../rendering/SunShadows';
import { REST_LENGTH, type RoverBody, WHEEL_RADIUS, WHEELS } from './RoverBody';
import { RoverPanel } from './RoverPanel';

type Point = [number, number, number];
const up = new Vector3(0, 1, 0);

// Bake fixed components by finish. Hundreds of tubes, fittings and treads
// then cost one draw per material, and each wheel assembly stays articulated.
class Parts {
  private batches = new Map<Material, BufferGeometry[]>();

  add(geo: BufferGeometry, mat: Material, at: Point, rotation?: Euler | Quaternion) {
    if (rotation instanceof Euler) geo.rotateX(rotation.x).rotateY(rotation.y).rotateZ(rotation.z);
    else if (rotation) geo.applyQuaternion(rotation);
    geo.translate(...at);
    const batch = this.batches.get(mat) ?? [];
    batch.push(geo);
    this.batches.set(mat, batch);
  }

  box(mat: Material, at: Point, size: Point, tilt = 0) {
    const radius = Math.min(...size) * 0.11;
    if (radius > 0.006) {
      const corners = new RoundedBoxGeometry(...size, 2, Math.min(radius, 0.035));
      this.add(mergeVertices(corners), mat, at, new Euler(tilt, 0, 0));
      corners.dispose();
    } else this.add(new BoxGeometry(...size), mat, at, new Euler(tilt, 0, 0));
  }

  tube(mat: Material, a: Point, b: Point, radius: number, endRadius = radius, sides = 8) {
    const axis = new Vector3(...b).sub(new Vector3(...a));
    const geo = new CylinderGeometry(endRadius, radius, axis.length(), sides);
    this.add(
      geo,
      mat,
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
      new Quaternion().setFromUnitVectors(up, axis.normalize())
    );
  }

  sleeve(mat: Material, a: Point, b: Point, start: number, end: number) {
    const axis = new Vector3(...b).sub(new Vector3(...a));
    const length = axis.length(),
      profile: Vector2[] = [];
    for (let i = 0; i <= 36; i++) {
      const t = i / 36,
        taper = 0.83 + 0.17 * Math.sin(Math.PI * t);
      const folds = 1 + Math.sin(t * 37 + 0.7 * Math.sin(t * 13)) * 0.074;
      profile.push(new Vector2((start + (end - start) * t) * folds * taper, length * t));
    }
    this.add(
      new LatheGeometry(profile, 18),
      mat,
      a,
      new Quaternion().setFromUnitVectors(up, axis.normalize())
    );
  }

  hose(mat: Material, points: Point[], radius: number) {
    const path = new CatmullRomCurve3(points.map((point) => new Vector3(...point)));
    this.add(new TubeGeometry(path, 24, radius, 7, false), mat, [0, 0, 0]);
  }

  oval(mat: Material, at: Point, radii: Point, tilt = 0) {
    this.add(new SphereGeometry(1, 24, 16).scale(...radii), mat, at, new Euler(tilt, 0, 0));
  }

  finish() {
    const group = new Group();
    for (const [mat, parts] of this.batches) {
      const geo = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      if (!geo) throw new Error('Incompatible rover geometry');
      const mesh = new Mesh(geo, mat);
      group.add(mesh);
    }
    return group;
  }
}

// Fine diamond wire cloth on the wheels and antenna, with actual openings.
function weave() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Wheel weave needs a 2D canvas');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 64, 64);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 11;
  ctx.beginPath();
  for (let x = -64; x <= 64; x += 64) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 64, 64);
    ctx.moveTo(x, 64);
    ctx.lineTo(x + 64, 0);
  }
  ctx.stroke();
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  return texture;
}

// A tiny lunar sky/ground reflection probe brings out the visor and bare
// alloy. The actual scene sun supplies the moving directional highlights.
function reflectionProbe() {
  const width = 128,
    height = 64,
    data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const az = (2 * Math.PI * x) / width;
      const ridge = 32 + 1.6 * Math.sin(az * 5) + Math.sin(az * 11);
      const grain = Math.sin(x * 48.7 + y * 91.3) * 7;
      const v = y < ridge ? 98 + 42 * Math.cos(az - 1) + grain : 6;
      data.set([v, v, v, 255], 4 * (y * width + x));
    }
  const tex = new DataTexture(data, width, height, RGBAFormat);
  tex.mapping = EquirectangularReflectionMapping;
  tex.needsUpdate = true;
  return tex;
}

// A small equipment placard printed on the communications unit's outer face.
function equipmentPlate() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 192;
  const g = c.getContext('2d');
  if (!g) throw new Error('Rover markings need a 2D canvas');
  g.fillStyle = '#d0c9b4';
  g.fillRect(0, 0, 512, 192);
  for (let i = 0; i < 13; i++) {
    g.fillStyle = i % 2 === 0 ? '#954739' : '#d2cbb7';
    g.fillRect(16, 17 + i * 6, 137, 6);
  }
  g.fillStyle = '#333f53';
  g.fillRect(16, 17, 58, 42);
  g.fillStyle = '#cfcbb7';
  for (let j = 0; j < 9; j++)
    for (let i = 0; i < (j % 2 === 0 ? 6 : 5); i++)
      g.fillRect(19 + 9 * i + 4 * (j % 2), 19 + j * 4.5, 2.8, 2.8);
  g.fillStyle = '#252620';
  g.font = 'bold 33px sans-serif';
  g.fillText('UNITED STATES', 166, 65);
  g.fillRect(17, 109, 478, 3);
  g.font = 'bold 22px monospace';
  g.fillText('LUNAR COMMUNICATIONS', 18, 144);
  g.font = '17px monospace';
  g.fillText('RELAY UNIT    /    LCRU', 18, 172);
  const map = new CanvasTexture(c);
  map.colorSpace = SRGBColorSpace;
  return new MeshStandardMaterial({ map, roughness: 0.79 });
}

function finishes() {
  const envMap = reflectionProbe();
  const metal = (color: number, metalness: number, roughness: number) =>
    new MeshStandardMaterial({ color, metalness, roughness, envMap, side: DoubleSide });
  const wire = metal(0xb2a69a, 0.65, 0.64),
    meshMap = weave();
  meshMap.repeat.set(70, 12);
  wire.alphaMap = meshMap;
  wire.alphaTest = 0.29;
  const net = metal(0xa38a59, 0.52, 0.59);
  net.alphaMap = meshMap.clone();
  net.alphaMap.repeat.set(70, 18);
  net.alphaTest = 0.38;
  const loader = new TextureLoader();
  function finish(url: string, metallic: number, roughness: number, relief: number) {
    const tex = loader.load(url);
    tex.colorSpace = SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = metal(0xffffff, metallic, roughness);
    mat.map = tex;
    mat.bumpMap = tex;
    mat.bumpScale = relief;
    return mat;
  }
  return {
    alloy: finish(new URL('./textures/alloy.webp', import.meta.url).href, 0.58, 0.52, 0.0003),
    charcoal: metal(0x3b3935, 0.38, 0.62),
    ivory: finish(new URL('./textures/beta-cloth.webp', import.meta.url).href, 0.035, 0.83, 0.0013),
    seam: metal(0xaba598, 0.12, 0.82),
    fender: finish(new URL('./textures/fender.webp', import.meta.url).href, 0.12, 0.7, 0.0007),
    plate: equipmentPlate(),
    foil: finish(new URL('./textures/thermal-foil.webp', import.meta.url).href, 0.63, 0.34, 0.002),
    gold: metal(0xbb9558, 0.68, 0.41),
    visor: metal(0xffbc57, 0.93, 0.095),
    red: metal(0x993e31, 0.08, 0.68),
    wire,
    net,
  };
}
type Finishes = ReturnType<typeof finishes>;

function chassis(p: Parts, m: Finishes) {
  // Open three-section folding deck, perimeter rails, bracing and hinge barrels.
  for (const x of [-0.58, 0.58]) {
    p.tube(m.alloy, [x, 0, -1.42], [x, 0, 1.42], 0.033);
    for (const z of [-1.15, -0.83, 0.62, 1.15]) {
      p.tube(m.alloy, [x, -0.07, z], [-x, -0.07, z], 0.024);
    }
    for (const z of [-0.81, 0.67]) p.tube(m.charcoal, [x - 0.07, 0, z], [x + 0.07, 0, z], 0.05);
    p.tube(m.alloy, [x, 0.08, -0.72], [x, 0.22, -1.43], 0.021);
    p.tube(m.alloy, [x, 0.24, 1.42], [x, 0.12, 0.67], 0.021);
  }
  p.box(m.alloy, [0, -0.045, 0], [1.12, 0.055, 2.65]);
  for (let x = -0.5; x <= 0.51; x += 0.1) p.box(m.charcoal, [x, 0, -0.36], [0.017, 0.013, 0.8]);
  for (const x of [-0.31, 0.31]) {
    p.box(m.foil, [x, 0.14, -1.08], [0.52, 0.26, 0.62]);
    p.box(m.ivory, [x, 0.285, -1.08], [0.51, 0.025, 0.61]);
    for (const z of [-1.3, -0.88]) p.box(m.charcoal, [x, 0.302, z], [0.48, 0.013, 0.023]);
  }
  // Communications relay in its thermal cover across the forward pallet.
  p.box(m.foil, [0, 0.19, -1.48], [0.84, 0.34, 0.2]);
  p.box(m.ivory, [0, 0.368, -1.47], [0.85, 0.025, 0.22], 0.045);
  p.add(new PlaneGeometry(0.255, 0.096), m.plate, [0.17, 0.19, -1.583], new Euler(0, Math.PI, 0));
  for (const x of [-0.37, -0.12, 0.37]) {
    p.box(m.alloy, [x, 0.19, -1.588], [0.016, 0.31, 0.012]);
    p.box(m.charcoal, [x, 0.24, -1.598], [0.037, 0.039, 0.009]);
    p.tube(m.alloy, [x, 0.068, -1.6], [x, 0.068, -1.58], 0.012);
  }
  // Two suspended canvas seats, separate tubular frame, webbing and handholds.
  for (const x of [-0.33, 0.33]) {
    p.box(m.ivory, [x, 0.271, 0.12], [0.48, 0.046, 0.54], -0.045);
    p.box(m.ivory, [x, 0.55, 0.428], [0.455, 0.54, 0.046], 0.15);
    for (const side of [-1, 1]) {
      const edge = x + side * 0.25;
      p.tube(m.alloy, [edge, 0.06, 0.04], [edge, 0.27, -0.15], 0.018);
      p.tube(m.alloy, [edge, 0.27, -0.15], [edge, 0.3, 0.38], 0.018);
      p.tube(m.alloy, [edge, 0.1, 0.34], [edge, 0.83, 0.49], 0.018);
      p.tube(m.alloy, [edge, 0.83, 0.49], [x, 0.85, 0.49], 0.016);
      p.tube(m.charcoal, [x + side * 0.19, 0.31, 0.02], [x + side * 0.14, 0.31, 0.32], 0.023);
    }
    const outer = x + Math.sign(x) * 0.29;
    p.hose(
      m.alloy,
      [
        [outer, 0.13, 0.28],
        [outer, 0.49, 0.22],
        [outer, 0.54, -0.04],
        [outer, 0.5, -0.16],
        [outer, 0.21, -0.19],
      ],
      0.017
    );
    p.tube(m.charcoal, [outer, 0.531, -0.01], [outer, 0.516, 0.13], 0.022);
    for (const h of [0.4, 0.66]) p.box(m.seam, [x, h, 0.48], [0.49, 0.027, 0.023], 0.15);
  }
  // Instrument console, recessed dials, circuit breakers and T-hand controller.
  p.tube(m.alloy, [0, 0.03, -0.55], [0, 0.67, -0.57], 0.037);
  p.box(m.ivory, [0, 0.71, -0.57], [0.46, 0.25, 0.17], -0.23);
  p.tube(m.charcoal, [0, 0.16, -0.06], [0, 0.48, -0.14], 0.019);
  p.tube(m.charcoal, [-0.072, 0.49, -0.14], [0.072, 0.49, -0.14], 0.022);

  // Rear tool pallet, stowage bags, buckled straps, survey tools and core tubes.
  for (const x of [-0.38, 0.05, 0.43]) {
    p.box(m.seam, [x, 0.19, 1.02], [0.32, 0.31, 0.6]);
    p.oval(m.ivory, [x, 0.36, 1.02], [0.18, 0.073, 0.31]);
    for (const z of [0.85, 1.22]) {
      p.box(m.charcoal, [x, 0.397, z], [0.3, 0.025, 0.025]);
      p.box(m.charcoal, [x, 0.21, 1.33], [0.028, 0.31, 0.012]);
    }
  }
  for (const x of [-0.53, 0.54]) {
    p.tube(m.alloy, [x, 0.04, 1.41], [x, 0.56, 1.31], 0.025);
    p.tube(m.alloy, [x, 0.56, 1.31], [0, 0.56, 1.31], 0.022);
  }
  for (let i = 0; i < 4; i++)
    p.tube(m.gold, [0.28 + i * 0.056, 0.19, 1.37], [0.37 + i * 0.056, 0.82, 1.29], 0.016);
  // Power and signal looms loop below the deck and around the antenna gimbal.
  for (const side of [-1, 1]) {
    const x = side * 0.52;
    p.hose(
      m.charcoal,
      [
        [x, 0.17, -1.33],
        [side * 0.64, 0.12, -1.2],
        [side * 0.6, 0.04, -0.83],
        [x, 0.06, -0.66],
        [x, 0.1, -0.49],
      ],
      0.014
    );
    p.hose(
      m.seam,
      [
        [x, 0.24, -1.3],
        [side * 0.59, 0.21, -1.12],
        [side * 0.58, 0.18, -0.9],
        [x, 0.15, -0.85],
      ],
      0.012
    );
    for (const z of [-1.29, -0.91]) {
      p.box(m.alloy, [x, 0.23, z], [0.06, 0.07, 0.04]);
      p.tube(m.charcoal, [x, 0.235, z - 0.026], [x, 0.235, z + 0.026], 0.014);
    }
  }
  p.hose(
    m.charcoal,
    [
      [0.47, 0.81, -1.07],
      [0.55, 0.75, -0.99],
      [0.56, 0.48, -1.06],
      [0.49, 0.49, -1.23],
      [0.47, 0.22, -1.23],
    ],
    0.016
  );
  // TV camera with black lens and brass pan head opposite the antenna.
  p.tube(m.alloy, [0.48, 0.21, -1.23], [0.48, 0.63, -1.24], 0.023);
  p.tube(m.gold, [0.48, 0.6, -1.24], [0.48, 0.71, -1.24], 0.075);
  p.box(m.foil, [0.48, 0.82, -1.23], [0.24, 0.18, 0.33]);
  p.box(m.ivory, [0.48, 0.93, -1.22], [0.256, 0.026, 0.35], 0.035);
  p.box(m.charcoal, [0.48, 0.818, -1.057], [0.175, 0.093, 0.015]);
  for (let i = 0; i < 8; i++)
    p.box(m.alloy, [0.41 + i * 0.02, 0.818, -1.045], [0.009, 0.065, 0.007]);
  p.tube(m.charcoal, [0.48, 0.82, -1.37], [0.48, 0.82, -1.47], 0.052, 0.071, 18);
  p.tube(m.alloy, [0.57, 0.22, -0.91], [0.6, 1.5, -0.88], 0.009, 0.004);
}

function antenna(m: Finishes) {
  const p = new Parts();
  const radius = 0.46,
    depth = 0.135;
  const profile: Vector2[] = [];
  for (let i = 0; i <= 12; i++) profile.push(new Vector2((radius * i) / 12, depth * (i / 12) ** 2));
  p.add(new LatheGeometry(profile, 64), m.net, [0, 0, 0]);
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * 2 * i) / 12;
    let previous: Point = [0, 0, 0];
    for (let j = 1; j <= 4; j++) {
      const t = j / 4;
      const node: Point = [Math.sin(a) * radius * t, depth * t * t, Math.cos(a) * radius * t];
      p.tube(m.gold, previous, node, 0.006);
      previous = node;
    }
    if (i % 4 === 0) p.tube(m.alloy, previous, [0, 0.31, 0], 0.005);
  }
  p.add(
    new TorusGeometry(radius, 0.009, 7, 64),
    m.gold,
    [0, depth, 0],
    new Euler(Math.PI / 2, 0, 0)
  );
  p.tube(m.charcoal, [0, 0.26, 0], [0, 0.33, 0], 0.026);
  const dish = p.finish();
  dish.rotation.set(-0.71, 0, 0.37);
  dish.position.set(-0.48, 1.66, -1.18);
  return dish;
}

function astronaut(p: Parts, m: Finishes) {
  const x = -0.33;
  p.oval(m.ivory, [x, 0.61, 0.1], [0.227, 0.36, 0.167], 0.1);
  p.box(m.ivory, [x, 0.67, 0.38], [0.38, 0.48, 0.22], 0.08);
  p.box(m.seam, [x, 0.68, 0.5], [0.31, 0.35, 0.038], 0.08);
  for (const h of [0.54, 0.77]) p.box(m.ivory, [x, h, 0.525], [0.32, 0.022, 0.024]);
  p.box(m.seam, [x, 0.79, -0.056], [0.26, 0.13, 0.11]);
  p.tube(m.charcoal, [x, 0.87, 0.085], [x, 0.93, 0.085], 0.147, 0.151, 28);
  p.oval(m.ivory, [x, 1.065, 0.083], [0.192, 0.204, 0.176]);
  p.oval(m.charcoal, [x, 1.065, 0.007], [0.174, 0.16, 0.132]);
  p.oval(m.visor, [x, 1.068, -0.011], [0.163, 0.148, 0.136]);
  for (const s of [-1, 1]) {
    const leg = x + s * 0.124;
    p.sleeve(m.ivory, [leg, 0.39, 0.11], [leg, 0.35, -0.26], 0.14, 0.113);
    p.oval(m.seam, [leg, 0.32, -0.26], [0.108, 0.11, 0.105]);
    p.sleeve(m.ivory, [leg, 0.32, -0.26], [leg, 0.09, -0.44], 0.105, 0.087);
    p.oval(m.seam, [leg, 0.067, -0.49], [0.09, 0.065, 0.156]);
    const shoulder: Point = [x + s * 0.197, 0.79, 0.1];
    const elbow: Point = [x + s * 0.246, 0.57, 0.01];
    const hand: Point = [s > 0 ? -0.045 : x - 0.22, 0.5, s > 0 ? -0.14 : -0.2];
    p.oval(m.ivory, shoulder, [0.1, 0.115, 0.101]);
    p.sleeve(m.ivory, shoulder, elbow, 0.11, 0.086);
    p.sleeve(m.ivory, elbow, hand, 0.092, 0.067);
    p.oval(m.seam, hand, [0.057, 0.054, 0.068]);
    const mid: Point = [x + s * 0.216, 0.703, 0.067];
    p.tube(m.red, mid, [mid[0] + s * 0.003, 0.682, 0.058], 0.107, 0.107, 24);
    p.hose(
      m.seam,
      [
        [x + s * 0.1, 0.61, -0.047],
        [x + s * 0.14, 0.46, -0.13],
        [x + s * 0.25, 0.4, 0.06],
        [x + s * 0.2, 0.55, 0.32],
      ],
      0.023
    );
    p.tube(m.alloy, [x + s * 0.1, 0.61, -0.05], [x + s * 0.1, 0.61, -0.08], 0.035, 0.03, 16);
    p.tube(m.seam, [x + s * 0.176, 1.07, 0.055], [x + s * 0.202, 1.07, 0.055], 0.045, 0.039, 18);
  }
}

function wheelParts(m: Finishes) {
  const p = new Parts();
  const profile = [
    [0.155, -0.072],
    [0.25, -0.108],
    [0.34, -0.113],
    [0.392, -0.082],
    [WHEEL_RADIUS, -0.052],
    [WHEEL_RADIUS, 0.052],
    [0.392, 0.082],
    [0.34, 0.113],
    [0.25, 0.108],
    [0.155, 0.072],
  ];
  p.add(
    new LatheGeometry(
      profile.map(([r, h]) => new Vector2(r, h)),
      64
    ),
    m.wire,
    [0, 0, 0],
    new Euler(0, 0, Math.PI / 2)
  );
  p.tube(m.alloy, [-0.088, 0, 0], [0.088, 0, 0], 0.152, 0.152, 36);
  for (const s of [-1, 1]) {
    p.tube(m.gold, [s * 0.09, 0, 0], [s * 0.117, 0, 0], 0.1, 0.077, 20);
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      const y = 0.112 * Math.cos(a),
        z = 0.112 * Math.sin(a);
      p.tube(m.charcoal, [s * 0.089, y, z], [s * 0.1, y, z], 0.012, 0.012, 6);
      p.tube(
        m.alloy,
        [s * 0.09, 0.13 * Math.cos(a), 0.13 * Math.sin(a)],
        [s * 0.1, 0.31 * Math.cos(a + 0.2), 0.31 * Math.sin(a + 0.2)],
        0.006
      );
    }
    // Paired titanium chevrons cover roughly half of the woven tread.
    for (let i = 0; i < 32; i++) {
      const a = (i * Math.PI) / 16;
      const geo = new BoxGeometry(0.11, 0.009, 0.032);
      geo
        .rotateY(s * 0.48)
        .translate(s * 0.045, 0.405, 0)
        .rotateX(a);
      p.add(geo, m.alloy, [0, 0, 0]);
    }
  }
  return p.finish();
}

export class RoverModel {
  readonly root = new Group();
  readonly panel = new RoverPanel();
  private readonly crew: Group;
  setOccupied(occupied: boolean) {
    this.crew.visible = occupied;
  }
  setDriverView(cab: boolean) {
    this.crew.traverse((o) => {
      if (o instanceof Mesh) {
        if (cab) o.layers.disable(0);
        else o.layers.enable(0);
      }
    });
  }
  private wheels: { pivot: Group; spin: Group; arms: Mesh[] }[] = [];
  private readonly materials = finishes();

  constructor(shadows: SunShadows) {
    const receivers = [...Object.values(this.materials), this.panel.mesh.material];
    for (const material of receivers) {
      material.defines = { ...material.defines, SUN_SHADOW_MAP_SIZE: shadows.options.mapSize };
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, shadows.uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vRoverWorld;')
          .replace(
            '#include <project_vertex>',
            `#include <project_vertex>
            vRoverWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`
          );
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
            varying vec3 vRoverWorld;
            ${SUN_SHADOW_FRAGMENT_PARS}`
          )
          .replace(
            '#include <lights_fragment_end>',
            `#include <lights_fragment_end>
            float roverSun = sunShadowVisibility(vRoverWorld, inverseTransformDirection(normal, viewMatrix));
            reflectedLight.directDiffuse *= roverSun;
            reflectedLight.directSpecular *= roverSun;`
          );
      };
    }
    const m = this.materials,
      p = new Parts();
    chassis(p, m);
    const suit = new Parts();
    astronaut(suit, m);
    this.crew = suit.finish();
    this.root.add(this.panel.mesh, this.crew);
    p.tube(m.alloy, [-0.49, 0.2, -1.2], [-0.48, 1.66, -1.18], 0.024, 0.017, 12);
    p.tube(m.charcoal, [-0.49, 0.72, -1.2], [-0.49, 0.92, -1.2], 0.034);
    p.tube(m.alloy, [-0.53, 0.03, -0.88], [-0.49, 0.88, -1.19], 0.014);
    this.root.add(p.finish(), antenna(m));
    const rim = wheelParts(m);
    const armGeometry = new CylinderGeometry(0.018, 0.018, 1, 8);
    for (const wheel of WHEELS) {
      const spin = rim.clone(),
        pivot = new Group(),
        f = new Parts();
      const shell = (
        radius: number,
        width: number,
        start: number,
        length: number,
        material: Material
      ) => {
        // Cylinder runs along X. Angle zero points up and the arc spans the wheel crown.
        const geo = new CylinderGeometry(radius, radius, width, 36, 1, true, start, length);
        geo.rotateZ(Math.PI / 2).rotateX(-Math.PI / 2);
        f.add(geo, material, [0, 0, 0]);
      };
      shell(0.456, 0.285, -1.12, 2.58, m.fender);
      for (const x of [-0.14, 0.14]) {
        const geo = new TorusGeometry(0.456, 0.007, 6, 36, 2.58);
        geo
          .rotateZ(-1.46)
          .rotateY(Math.PI / 2)
          .rotateX(Math.PI / 2);
        f.add(geo, m.gold, [x, 0, 0]);
      }
      for (const side of [-1, 1]) {
        f.tube(m.alloy, [side * 0.12, 0, 0], [side * 0.125, 0.39, 0.21], 0.011);
      }
      pivot.add(spin, f.finish());
      pivot.position.set(wheel.x, -REST_LENGTH, wheel.z);
      this.root.add(pivot);
      const arms = Array.from({ length: 4 }, () => {
        const arm = new Mesh(armGeometry, m.alloy);
        this.root.add(arm);
        return arm;
      });
      this.wheels.push({ pivot, spin, arms });
    }
  }

  private readonly start = new Vector3();
  private readonly direction = new Vector3();

  sync(body: RoverBody) {
    this.root.position.copy(body.position);
    this.root.quaternion.copy(body.rotation);
    for (const [i, { pivot, spin, arms }] of this.wheels.entries()) {
      const { x, z } = WHEELS[i];
      pivot.position.y = -body.lengths[i];
      pivot.rotation.y = body.angles[i];
      spin.rotation.x = body.spins[i];
      for (const [j, arm] of arms.entries()) {
        const h = j < 2 ? -0.075 : 0.055;
        this.start.set(Math.sign(x) * 0.49, h, z + (j % 2 === 0 ? -0.23 : 0.23));
        this.direction.set(x * 0.91, pivot.position.y + h, z).sub(this.start);
        arm.position.copy(this.start).addScaledVector(this.direction, 0.5);
        arm.scale.y = this.direction.length();
        arm.quaternion.setFromUnitVectors(up, this.direction.normalize());
      }
    }
  }

  dispose() {
    const geometries = new Set<BufferGeometry>();
    this.root.traverse((o) => {
      if (o instanceof Mesh) geometries.add(o.geometry);
    });
    for (const g of geometries) g.dispose();
    this.panel.dispose();
    this.materials.wire.alphaMap?.dispose();
    this.materials.net.alphaMap?.dispose();
    this.materials.visor.envMap?.dispose();
    for (const mat of Object.values(this.materials)) {
      mat.map?.dispose();
      mat.dispose();
    }
    this.root.removeFromParent();
  }
}
