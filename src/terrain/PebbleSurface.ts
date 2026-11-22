import {
  BackSide,
  BufferAttribute,
  type Camera,
  DynamicDrawUsage,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  MeshStandardMaterial,
  type PerspectiveCamera,
  type Scene,
  ShaderMaterial,
  Vector3,
} from 'three';
import { NEAR_SHADOW_CASTER_LAYER } from '../core/layers';
import { getSharedPebbleStamps, type MoonMaterial } from '../shaders/MoonMaterial';
import { pebbleReliefVertex } from '../shaders/pebbleRelief';
import {
  type ChipPrototype,
  FIELD_STRIDE,
  INSTANCE_STRIDE,
  PEBBLE_SHAPES,
  PebbleField,
  type PebbleWindow,
} from './pebbleField';
import { PEBBLE_REACH, PEBBLE_TILE_SIZE } from './pebblePlacement';

/** Write terrain normal XYZ (any positive length) followed by the visible triangle's Y. */
export type PebbleGroundSampler = (
  x: number,
  z: number,
  out: Float32Array,
  offset: number
) => boolean;

function stoneGeometry(source: ChipPrototype) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(source.position, 3));
  geometry.setAttribute('normal', new BufferAttribute(source.normal, 3));
  geometry.setIndex(new BufferAttribute(source.index, 1));
  geometry.instanceCount = 0;
  return geometry;
}

function instanceBuffer(geometry: InstancedBufferGeometry, count: number) {
  const capacity = 2 ** Math.ceil(Math.log2(Math.max(1, count)));
  const buffer = new InstancedInterleavedBuffer(
    new Float32Array(capacity * INSTANCE_STRIDE),
    INSTANCE_STRIDE
  );
  buffer.setUsage(DynamicDrawUsage);
  geometry.setAttribute('chipGround', new InterleavedBufferAttribute(buffer, 4, 0));
  geometry.setAttribute('chipForm', new InterleavedBufferAttribute(buffer, 4, 4));
  geometry.setAttribute('chipBed', new InterleavedBufferAttribute(buffer, 4, 8));
  geometry.setAttribute('chipWidth', new InterleavedBufferAttribute(buffer, 2, 12));
  return buffer;
}

interface StoneBatch {
  geometry: InstancedBufferGeometry;
  buffer: InstancedInterleavedBuffer;
  surface: Mesh;
  shadow: Mesh;
}

export class PebbleSurface {
  readonly root = new Group();
  private readonly eye = new Vector3();
  private readonly shadowEye = new Vector3();
  private readonly strength = { value: 1 };
  private readonly ground = new Float32Array(4);
  private readonly batches = new Map<number, StoneBatch>();
  private readonly groups: number[][] = Array.from({ length: PEBBLE_SHAPES * 2 }, () => []);
  private field = new Float32Array(0) as Float32Array;
  private shapes: ChipPrototype[] = [];
  private close = new Uint8Array(0);
  private worker?: Worker;
  private fallback?: PebbleField;
  private dirty = false;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private finishRequest?: () => void;
  private readonly forward = new Vector3();
  private readonly previousForward = new Vector3();
  private readonly previousEye = new Vector3();
  private previousFov = -1;
  private instanceCount = 0;
  private readonly material = new MeshStandardMaterial({ roughness: 1 });
  private readonly caster: ShaderMaterial;
  private active = false;
  private revision = -1;
  private tileX = NaN;
  private tileZ = NaN;

  constructor(
    private readonly groundMaterial: MoonMaterial,
    private readonly sample: PebbleGroundSampler,
    private readonly requestRender: () => void = () => {}
  ) {
    const uniforms = { uPebbleEye: { value: this.eye }, uPebbleStrength: this.strength };
    this.material.defines = { ...groundMaterial.defines, MOON_PEBBLE_STONE: '' };
    this.material.onBeforeCompile = (shader, renderer) => {
      groundMaterial.onBeforeCompile(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader =
        pebbleReliefVertex +
        shader.vertexShader
          .replace(
            '#include <beginnormal_vertex>',
            'vec3 objectNormal; vec3 chip = chipPosition(objectNormal);'
          )
          .replace('#include <begin_vertex>', 'vec3 transformed = chip;');
      shader.fragmentShader = `varying vec2 vChipSurface;\n${shader.fragmentShader}`;
    };
    this.material.customProgramCacheKey = () => `${groundMaterial.customProgramCacheKey()}/stone`;
    this.caster = new ShaderMaterial({
      uniforms: { ...uniforms, uWarp: { value: new Vector3() } },
      vertexShader:
        pebbleReliefVertex +
        `
        uniform vec3 uWarp;
        void main() {
          vec3 n;
          vec3 world = chipPosition(n);
          vec2 delta = world.xz - uWarp.xy;
          world.y -= dot(delta, delta) * uWarp.z;
          gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        }`,
      fragmentShader: 'void main() { gl_FragColor = vec4(1.0); }',
      side: BackSide,
      colorWrite: false,
    });
    this.caster.allowOverride = false;
    this.root.name = 'Raised regolith pebbles';
    this.root.visible = false;
  }

  private makeBatch(key: number, count: number) {
    const geometry = stoneGeometry(this.shapes[key]);
    const buffer = instanceBuffer(geometry, count);
    const surface = new Mesh(geometry, this.material);
    surface.frustumCulled = false;
    const shadow = new Mesh(geometry, this.caster);
    shadow.frustumCulled = false;
    shadow.layers.set(NEAR_SHADOW_CASTER_LAYER);
    shadow.onBeforeRender = (_renderer, scene: Scene) => {
      const override = scene.overrideMaterial as ShaderMaterial | null;
      if (override?.uniforms?.uWarp)
        this.caster.uniforms.uWarp.value.copy(override.uniforms.uWarp.value);
    };
    this.root.add(surface, shadow);
    const batch = { geometry, buffer, surface, shadow };
    this.batches.set(key, batch);
    return batch;
  }

  /** One request in flight. Fast panning coalesces all intervening windows into the latest one. */
  private requestWindow() {
    if (this.pending || this.disposed) return;
    this.pending = new Promise<void>((resolve) => {
      this.finishRequest = resolve;
    });
    const receive = (result: PebbleWindow) => {
      if (this.disposed) return;
      if (result.shapes) this.shapes = result.shapes;
      this.finishRequest?.();
      this.pending = null;
      if (result.x !== this.tileX || result.z !== this.tileZ) {
        this.requestWindow();
        return;
      }
      this.field = result.stones;
      this.close = new Uint8Array(this.field.length / FIELD_STRIDE);
      this.dirty = true;
      this.requestRender();
    };
    const useFallback = () => {
      this.worker?.terminate();
      this.worker = undefined;
      this.fallback ??= new PebbleField(getSharedPebbleStamps());
      receive(this.fallback.window(this.tileX, this.tileZ));
    };
    if (typeof Worker === 'undefined' || this.fallback) {
      useFallback();
      return;
    }
    try {
      const first = !this.worker;
      this.worker ??= new Worker(new URL('./pebbleField.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = ({ data }: MessageEvent<PebbleWindow>) => receive(data);
      this.worker.onerror = useFallback;
      this.worker.postMessage({
        x: this.tileX,
        z: this.tileZ,
        stamps: first ? getSharedPebbleStamps() : undefined,
      });
    } catch {
      useFallback();
    }
  }

  /** The lab awaits the current camera window before recording a timing or revealing its initial view. */
  async ready() {
    while (this.pending) await this.pending;
  }

  private upload(camera: Vector3, cosine: number) {
    for (const group of this.groups) group.length = 0;
    const field = this.field;
    for (let at = 0; at < field.length; at += FIELD_STRIDE) {
      const x = field[at],
        z = field[at + 2],
        radius = field[at + 3],
        reach = field[at + 7];
      const dx = x - camera.x,
        dz = z - camera.z;
      if (dx * dx + dz * dz > (reach + 1) ** 2 || !this.sample(x, z, this.ground, 0)) continue;
      const dy = this.ground[3] - camera.y,
        distance = Math.hypot(dx, dy, dz);
      if (distance > reach + 1) continue;
      // The margin preserves off-screen casters and covers motion between visibility updates.
      if (
        cosine >= 0 &&
        dx * this.forward.x + dy * this.forward.y + dz * this.forward.z + 1.45 + 8 * radius <
          cosine * distance
      )
        continue;
      field[at + 1] = this.ground[3];
      field[at + 8] = -this.ground[0] / this.ground[1];
      field[at + 9] = -this.ground[2] / this.ground[1];
      const i = at / FIELD_STRIDE;
      this.close[i] = Number(radius > distance * (this.close[i] ? 0.024 : 0.034));
      this.groups[field[at + 14] + this.close[i] * PEBBLE_SHAPES].push(at);
    }
    this.instanceCount = 0;
    for (let key = 0; key < this.groups.length; key++) {
      const stones = this.groups[key];
      let batch = this.batches.get(key);
      if (!batch && !stones.length) continue;
      batch ??= this.makeBatch(key, stones.length);
      batch.surface.visible = batch.shadow.visible = stones.length > 0;
      batch.geometry.instanceCount = stones.length;
      this.instanceCount += stones.length;
      if (!stones.length) continue;
      if (stones.length > batch.buffer.count) {
        batch.geometry.dispose();
        batch.buffer = instanceBuffer(batch.geometry, stones.length);
      }
      const data = batch.buffer.array;
      for (let i = 0; i < stones.length; i++) {
        const src = stones[i],
          dst = i * INSTANCE_STRIDE;
        for (let j = 0; j < INSTANCE_STRIDE; j++) data[dst + j] = field[src + j];
      }
      batch.buffer.clearUpdateRanges();
      batch.buffer.addUpdateRange(0, stones.length * INSTANCE_STRIDE);
      batch.buffer.needsUpdate = true;
    }
  }

  update(
    camera: Vector3,
    altitude: number,
    revision: number,
    enabled = true,
    view?: Camera | null
  ) {
    const wasActive = this.active;
    const newStrength = this.groundMaterial.getParam('pebbleHeight');
    const strengthChanged = newStrength !== this.strength.value;
    this.strength.value = newStrength;
    this.eye.copy(camera);
    this.active =
      enabled &&
      this.groundMaterial.getParam('enableDetail') &&
      newStrength > 0 &&
      Math.abs(altitude) < PEBBLE_REACH + 1;
    if (!this.active) {
      this.root.visible = false;
      return wasActive;
    }
    const tx = Math.floor(camera.x / PEBBLE_TILE_SIZE),
      tz = Math.floor(camera.z / PEBBLE_TILE_SIZE);
    const moved = tx !== this.tileX || tz !== this.tileZ;
    if (moved) {
      this.tileX = tx;
      this.tileZ = tz;
      this.requestWindow();
    }
    const perspective = view as PerspectiveCamera | undefined;
    let cosine = -1;
    if (perspective?.isPerspectiveCamera) {
      perspective.getWorldDirection(this.forward);
      const half = Math.atan(
        Math.tan((perspective.fov * Math.PI) / 360) * Math.hypot(1, perspective.aspect)
      );
      cosine = Math.cos(half + 0.18);
    }
    const rebuild =
      this.dirty ||
      !wasActive ||
      moved ||
      this.revision !== revision ||
      cosine !== this.previousFov ||
      this.previousEye.distanceToSquared(camera) > 0.65 ** 2 ||
      (cosine >= 0 && this.previousForward.dot(this.forward) < 0.994);

    if (rebuild) {
      this.dirty = false;
      this.revision = revision;
      this.upload(camera, cosine);
      this.previousFov = cosine;
      this.previousEye.copy(camera);
      this.previousForward.copy(this.forward);
    }
    this.root.visible = this.instanceCount > 0;
    const changed =
      rebuild || strengthChanged || this.shadowEye.distanceToSquared(camera) > 0.25 ** 2;
    if (changed) this.shadowEye.copy(camera);
    return changed;
  }

  dispose() {
    this.root.removeFromParent();
    this.disposed = true;
    this.worker?.terminate();
    this.finishRequest?.();
    this.pending = null;
    this.fallback = undefined;
    for (const b of this.batches.values()) b.geometry.dispose();
    this.batches.clear();
    this.material.dispose();
    this.caster.dispose();
  }
}
