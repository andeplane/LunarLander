import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  type Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';
import { NEAR_SHADOW_CASTER_LAYER } from '../core/layers';
import { getSharedPebbleHeightMap, type MoonMaterial } from '../shaders/MoonMaterial';
import {
  PEBBLE_PATCH_RADIUS,
  PEBBLE_REACH,
  pebbleDiscard,
  pebbleReliefVertex,
} from '../shaders/pebbleRelief';

/** Write the visible surface normal and Y to four consecutive floats. */
export type PebbleGroundSampler = (
  x: number,
  z: number,
  out: Float32Array,
  offset: number
) => boolean;

const SIDE = PEBBLE_PATCH_RADIUS * 2 + 1;

/** One continuous grid. Its nested spacings share vertices along every join. */
function createPebbleGeometry(dx: number, dz: number) {
  const positive = [0];
  for (let cell = 0; cell < PEBBLE_PATCH_RADIUS; cell++) {
    const subdivisions = cell < 2 ? 16 : cell < 5 ? 8 : 2;
    for (let i = 1; i <= subdivisions; i++) positive.push(cell + i / subdivisions);
  }
  const axis = [
    ...positive
      .slice(1)
      .reverse()
      .map((n) => -n),
    ...positive,
  ];
  const n = axis.length;
  const position = new Float32Array(n * n * 3);
  const index = new Uint16Array((n - 1) * (n - 1) * 6);
  let k = 0;
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const a = z * n + x;
      position[3 * a] = axis[x] * dx;
      position[3 * a + 2] = axis[z] * dz;
      if (x < n - 1 && z < n - 1) {
        index[k++] = a;
        index[k++] = a + n;
        index[k++] = a + 1;
        index[k++] = a + 1;
        index[k++] = a + n;
        index[k++] = a + n + 1;
      }
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

export class PebbleSurface {
  readonly root = new Group();
  private readonly support = new Float32Array(SIDE * SIDE * 4);
  private readonly ground = new DataTexture(this.support, SIDE, SIDE, RGBAFormat, FloatType);
  private readonly eye = new Vector3();
  private readonly strength = { value: 1 };
  private readonly geometry: BufferGeometry;
  private readonly material = new MeshStandardMaterial();
  private readonly caster: ShaderMaterial;
  private revision = -1;
  private gridX = NaN;
  private gridZ = NaN;

  constructor(
    private readonly groundMaterial: MoonMaterial,
    private readonly dx: number,
    private readonly dz: number,
    private readonly sample: PebbleGroundSampler
  ) {
    this.ground.magFilter = this.ground.minFilter = NearestFilter;
    this.geometry = createPebbleGeometry(dx, dz);
    const uniforms = {
      uGroundSupport: { value: this.ground },
      uPebbleHeights: { value: getSharedPebbleHeightMap() },
      uPebbleGridStep: { value: new Vector2(dx, dz) },
      uPebbleEye: { value: this.eye },
      uPebbleStrength: this.strength,
    };
    this.material.defines = { ...groundMaterial.defines, MOON_PEBBLE_SURFACE: '' };
    this.material.onBeforeCompile = (shader, renderer) => {
      groundMaterial.onBeforeCompile(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader =
        pebbleReliefVertex +
        shader.vertexShader
          .replace(
            '#include <beginnormal_vertex>',
            'float pitch; vec2 localXZ = pebbleGridPosition(position.xz, pitch); vec4 support = pebbleSupport(localXZ); vec3 objectNormal = normalize(support.xyz);'
          )
          .replace(
            '#include <begin_vertex>',
            'vec3 transformed = pebblePosition(localXZ, support, pitch);'
          );
      shader.fragmentShader =
        'varying float vPebbleLift;\n' +
        shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          vec3 facet = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)));
          float bevel = smoothstep(0.03, 0.35, 1.0 - dot(facet, meshNormal));
          moonNormal = normalize(mix(moonNormal, facet, bevel * 0.27 * smoothstep(0.0004, 0.004, vPebbleLift)));
          normal = normalize(mat3(viewMatrix) * moonNormal);
          nonPerturbedNormal = normal;`
        );
    };
    this.material.customProgramCacheKey = () =>
      `${groundMaterial.customProgramCacheKey()}/pebble-surface`;
    const surface = new Mesh(this.geometry, this.material);
    // The CPU mesh lives at Y=0. Its actual elevations are sampled on the GPU.
    surface.frustumCulled = false;
    surface.renderOrder = -1;
    this.caster = new ShaderMaterial({
      uniforms: { ...uniforms, uWarp: { value: new Vector3() } },
      vertexShader:
        pebbleReliefVertex +
        `
        uniform vec3 uWarp;
        void main() {
          float pitch;
          vec2 xz = pebbleGridPosition(position.xz, pitch);
          vec3 local = pebblePosition(xz, pebbleSupport(xz), pitch);
          vec4 world = modelMatrix * vec4(local, 1.0);
          vec2 delta = world.xz - uWarp.xy;
          world.y -= dot(delta, delta) * uWarp.z;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader:
        'varying float vPebbleLift; void main() { ' +
        pebbleDiscard +
        ' gl_FragColor = vec4(1.0); }',
      side: BackSide,
      colorWrite: false,
    });
    this.caster.allowOverride = false;
    const shadow = new Mesh(this.geometry, this.caster);
    shadow.layers.set(NEAR_SHADOW_CASTER_LAYER);
    shadow.frustumCulled = false;
    shadow.onBeforeRender = (_renderer, scene: Scene) => {
      const override = scene.overrideMaterial as ShaderMaterial | null;
      if (override?.uniforms?.uWarp)
        this.caster.uniforms.uWarp.value.copy(override.uniforms.uWarp.value);
    };
    this.root.name = 'Raised regolith pebbles';
    this.root.add(surface, shadow);
    this.root.visible = false;
  }

  update(camera: Vector3, altitude: number, revision: number, enabled = true) {
    this.eye.copy(camera);
    const previousStrength = this.strength.value;
    this.strength.value = this.groundMaterial.getParam('pebbleHeight');
    const active =
      enabled &&
      this.groundMaterial.getParam('enableDetail') &&
      this.strength.value > 0 &&
      Math.abs(altitude) < PEBBLE_REACH + 0.8;
    const wasVisible = this.root.visible;
    if (!active) {
      this.groundMaterial.setPebbleCover(0, 0, 0, 0);
      this.root.visible = false;
      return wasVisible;
    }
    const ix = Math.round(camera.x / this.dx),
      iz = Math.round(camera.z / this.dz);
    if (ix === this.gridX && iz === this.gridZ && revision === this.revision && wasVisible)
      return previousStrength !== this.strength.value;
    this.gridX = ix;
    this.gridZ = iz;
    this.revision = revision;
    this.root.position.set(ix * this.dx, 0, iz * this.dz);
    for (let z = 0; z < SIDE; z++)
      for (let x = 0; x < SIDE; x++) {
        if (
          !this.sample(
            (ix + x - PEBBLE_PATCH_RADIUS) * this.dx,
            (iz + z - PEBBLE_PATCH_RADIUS) * this.dz,
            this.support,
            (z * SIDE + x) * 4
          )
        ) {
          this.groundMaterial.setPebbleCover(0, 0, 0, 0);
          this.root.visible = false;
          return wasVisible;
        }
      }
    this.groundMaterial.setPebbleCover(
      this.root.position.x,
      this.root.position.z,
      (PEBBLE_PATCH_RADIUS - 0.5) * this.dx,
      (PEBBLE_PATCH_RADIUS - 0.5) * this.dz
    );
    this.ground.needsUpdate = true;
    this.root.visible = true;
    return true;
  }

  dispose() {
    this.groundMaterial.setPebbleCover(0, 0, 0, 0);
    this.root.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.caster.dispose();
    this.ground.dispose();
  }
}
