import {
  BackSide,
  BufferAttribute,
  type Camera,
  DynamicDrawUsage,
  Frustum,
  Group,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type PerspectiveCamera,
  type Scene,
  ShaderMaterial,
  Sphere,
  Vector3,
} from 'three';
import { NEAR_SHADOW_CASTER_LAYER } from '../core/layers';
import {
  getSharedPebbleStamps,
  getSharedStoneDetailMap,
  type MoonMaterial,
} from '../shaders/MoonMaterial';
import { pebbleReliefVertex } from '../shaders/pebbleRelief';
import { MEDIUM_PEBBLE_FREQUENCY } from '../shaders/regolithTiling';
import {
  type ChipPrototype,
  FIELD_STRIDE,
  INSTANCE_STRIDE,
  PEBBLE_DETAILS,
  PEBBLE_SHAPES,
  PebbleField,
  type PebbleWindow,
} from './pebbleField';
import {
  coversPebbleView,
  paddedPebbleView,
  pebbleInWindow,
  pebbleView,
  PEBBLE_ARRIVAL_SECONDS,
  PEBBLE_TEXTURE_PX,
  PEBBLE_TILE_SIZE,
  type PebbleView,
} from './pebbleLod';

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
  geometry.setAttribute('chipProfile', new InterleavedBufferAttribute(buffer, 3, 12));
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
  private readonly maxRadius =
    getSharedPebbleStamps().reduce((r, s) => Math.max(r, s.radius), 0) / MEDIUM_PEBBLE_FREQUENCY;

  /** Conservative horizontal reach of any mark, including streaming and shadow margins. */
  groundReach(focal: number) {
    return 12 + (2 * focal * this.maxRadius * 1.08) / PEBBLE_TEXTURE_PX;
  }

  private readonly eye = new Vector3();
  private readonly shadowEye = new Vector3();
  private readonly strength = { value: 1 };
  private readonly ground = new Float32Array(4);
  private readonly batches = new Map<number, StoneBatch>();
  private readonly groups: number[][] = Array.from(
    { length: PEBBLE_SHAPES * PEBBLE_DETAILS.length },
    () => []
  );
  private field = new Float32Array(0) as Float32Array;
  private shapes: ChipPrototype[] = [];
  private levels = new Uint8Array(0);
  private worker?: Worker;
  private fallback?: PebbleField;
  private dirty = false;
  private disposed = false;
  private pending: Promise<void> | null = null;
  private finishRequest?: () => void;
  private readonly forward = new Vector3();
  private readonly previousForward = new Vector3();
  private readonly previousEye = new Vector3();
  private readonly frustum = new Frustum();
  private readonly viewProjection = new Matrix4();
  private readonly bounds = new Sphere();
  private previousAspect = -1;
  private previousProjection = -1;
  private instanceCount = 0;
  private readonly material = new MeshStandardMaterial({ roughness: 1 });
  private readonly caster: ShaderMaterial;
  private active = false;
  private revision = -1;
  private window?: PebbleView;
  private readonly projection = { value: 720 };
  private readonly time = { value: 0 };
  private fadingUntil = 0;

  constructor(
    private readonly groundMaterial: MoonMaterial,
    private readonly sample: PebbleGroundSampler,
    private readonly requestRender: () => void = () => {}
  ) {
    const uniforms = {
      uPebbleEye: { value: this.eye },
      uPebbleProjection: this.projection,
      uPebbleStrength: this.strength,
      uPebbleTime: this.time,
    };
    this.material.defines = { ...groundMaterial.defines, MOON_PEBBLE_STONE: '' };
    this.material.onBeforeCompile = (shader, renderer) => {
      groundMaterial.onBeforeCompile(shader, renderer);
      Object.assign(shader.uniforms, uniforms, {
        uChipDetail: { value: getSharedStoneDetailMap() },
      });
      shader.vertexShader =
        pebbleReliefVertex +
        shader.vertexShader
          .replace(
            '#include <beginnormal_vertex>',
            'vec3 objectNormal; vec3 chip = chipPosition(objectNormal);'
          )
          .replace('#include <begin_vertex>', 'vec3 transformed = chip;');
      shader.fragmentShader = `uniform sampler2D uChipDetail;\nvarying vec3 vChipSurface;\n${shader.fragmentShader}`;
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

  /** Keep one worker request in flight and coalesce intervening views. */
  private requestWindow() {
    const requested = this.window;
    if (this.pending || this.disposed || !requested) return;
    this.pending = new Promise<void>((resolve) => {
      this.finishRequest = resolve;
    });
    const receive = (result: PebbleWindow) => {
      if (this.disposed) return;
      if (result.shapes) this.shapes = result.shapes;
      this.finishRequest?.();
      this.pending = null;
      // Keep the overlapping part of a late reply during fast flight. Waiting for
      // an exact match could starve a moving camera of stones indefinitely.
      this.acceptField(result.stones);
      this.dirty = true;
      this.requestRender();
      if (requested !== this.window) this.requestWindow();
    };
    const useFallback = () => {
      this.worker?.terminate();
      this.worker = undefined;
      this.fallback ??= new PebbleField(getSharedPebbleStamps());
      receive(this.fallback.window(requested));
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
        view: requested,
        stamps: first ? getSharedPebbleStamps() : undefined,
      });
    } catch {
      useFallback();
    }
  }

  private acceptField(next: Float32Array) {
    const old = this.field,
      levels = new Uint8Array(next.length / FIELD_STRIDE);
    // The worker knows which slots in the last reply belonged to this same
    // world tile and stamp. Carry over samples, birth times and tier hysteresis.
    for (let i = 0; i < next.length; i += FIELD_STRIDE) {
      const prev = next[i + 7] * FIELD_STRIDE;
      if (prev < 0) {
        next[i + 7] = -1;
      } else {
        next[i + 1] = old[prev + 1];
        next[i + 7] = old[prev + 7];
        next[i + 8] = old[prev + 8];
        next[i + 9] = old[prev + 9];
        levels[i / FIELD_STRIDE] = this.levels[prev / FIELD_STRIDE];
      }
    }
    this.field = next;
    this.levels = levels;
  }

  /** The lab awaits the current camera window before recording a timing or revealing its initial view. */
  async ready() {
    while (this.pending) await this.pending;
  }

  private upload(
    camera: Vector3,
    view: PerspectiveCamera | undefined,
    projection: number,
    moveStep: number,
    groundChanged: boolean
  ) {
    if (view) {
      this.viewProjection.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.viewProjection);
    }
    for (const group of this.groups) group.length = 0;
    const field = this.field;
    for (let at = 0; at < field.length; at += FIELD_STRIDE) {
      const x = field[at],
        z = field[at + 2],
        radius = field[at + 3];
      const dx = x - camera.x,
        dz = z - camera.z;
      if (groundChanged || !Number.isFinite(field[at + 1])) {
        if (!this.sample(x, z, this.ground, 0)) {
          field[at + 1] = NaN;
          continue;
        }
        field[at + 1] = this.ground[3];
        field[at + 8] = -this.ground[0] / this.ground[1];
        field[at + 9] = -this.ground[2] / this.ground[1];
      }
      const dy = field[at + 1] - camera.y;
      const width = radius * Math.max(field[at + 12], field[at + 13]);
      // The shader finishes the blend before an instance leaves this padded draw list.
      const distanceSq = dx * dx + dy * dy + dz * dz;
      const reach = (width * projection) / PEBBLE_TEXTURE_PX + moveStep;
      if (distanceSq > reach * reach) continue;
      const distance = Math.sqrt(distanceSq);
      const pixels = (width * projection) / Math.max(distance, 0.001);
      // Keep a wider fringe for cast shadows. Only stones that can enter the picture
      // before the next update need a close-up mesh.
      const motionMargin = moveStep + 0.11 * distance;
      if (view) {
        this.bounds.center.set(x, field[at + 1], z);
        this.bounds.radius = 1.45 + 8 * radius + motionMargin;
        if (!this.frustum.intersectsSphere(this.bounds)) continue;
      }
      if (field[at + 7] < 0) {
        field[at + 7] = this.time.value;
        this.fadingUntil = this.time.value + PEBBLE_ARRIVAL_SECONDS;
      }
      const i = at / FIELD_STRIDE;
      const previous = this.levels[i];
      const coarse = pixels > (previous >= 1 ? 9 : 12);
      const medium = pixels > (previous >= 2 ? 16 : 21);
      const close = pixels > (previous === 3 ? 59 : 76);
      let level = close ? 3 : medium ? 2 : Number(coarse);
      if (level > 0 && view) {
        this.bounds.radius = 1.5 * radius + motionMargin;
        if (!this.frustum.intersectsSphere(this.bounds)) level--;
      }
      this.levels[i] = level;
      this.groups[field[at + INSTANCE_STRIDE] + level * PEBBLE_SHAPES].push(at);
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
    revision: number,
    enabled = true,
    view?: Camera | null,
    viewportHeight = 720,
    minGround = -Infinity,
    maxGround = Infinity
  ) {
    const wasActive = this.active;
    const wasVisible = this.root.visible;
    const newStrength = this.groundMaterial.getParam('pebbleHeight');
    const strengthChanged = newStrength !== this.strength.value;
    this.strength.value = newStrength;
    this.eye.copy(camera);
    this.time.value = performance.now() * 0.001;
    this.active = enabled && this.groundMaterial.getParam('enableDetail') && newStrength > 0;
    if (!this.active) {
      this.root.visible = false;
      return wasActive;
    }
    const perspective = (view as PerspectiveCamera | undefined)?.isPerspectiveCamera
      ? (view as PerspectiveCamera)
      : undefined;
    let projection = viewportHeight;
    if (perspective) {
      perspective.getWorldDirection(this.forward);
      const tanHalfFov = Math.tan((perspective.fov * Math.PI) / 360) / perspective.zoom;
      projection = viewportHeight / tanHalfFov;
    } else {
      this.forward.set(0, 0, 0);
    }
    this.projection.value = projection;
    const footprint = pebbleView(
      Math.floor(camera.x / PEBBLE_TILE_SIZE),
      Math.floor(camera.z / PEBBLE_TILE_SIZE),
      projection,
      perspective,
      minGround - camera.y,
      maxGround - camera.y
    );
    if (!pebbleInWindow(footprint, 0, 0, this.maxRadius, 8)) {
      this.root.visible = this.active = false;
      return wasVisible;
    }
    const moved = !this.window || !coversPebbleView(this.window, footprint);
    if (moved) {
      this.window = paddedPebbleView(footprint);
      this.requestWindow();
    }
    const aspect = perspective?.aspect ?? 0;
    const moveStep = 0.35;
    const rebuild =
      this.dirty ||
      !wasActive ||
      moved ||
      this.revision !== revision ||
      aspect !== this.previousAspect ||
      projection !== this.previousProjection ||
      this.previousEye.distanceToSquared(camera) > moveStep ** 2 ||
      (perspective !== undefined && this.previousForward.dot(this.forward) < 0.994);

    if (rebuild) {
      this.dirty = false;
      this.upload(camera, perspective, projection, moveStep, revision !== this.revision);
      this.revision = revision;
      this.previousProjection = projection;
      this.previousAspect = aspect;
      this.previousEye.copy(camera);
      this.previousForward.copy(this.forward);
    }
    this.root.visible = this.instanceCount > 0;
    if (!this.root.visible && !wasVisible) return false;
    const changed =
      rebuild ||
      strengthChanged ||
      (this.instanceCount > 0 && this.time.value <= this.fadingUntil) ||
      this.shadowEye.distanceToSquared(camera) > 0.25 ** 2;
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
