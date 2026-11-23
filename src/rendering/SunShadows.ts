import {
  BackSide,
  type Camera,
  DoubleSide,
  Mesh,
  MeshDepthMaterial,
  type MeshStandardMaterial,
  type Object3D,
  DepthTexture,
  LessEqualCompare,
  LinearFilter,
  Matrix4,
  OrthographicCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { rockScreenVertex, rockViewUniforms } from '../environment/rockScreenLod';
import { NEAR_SHADOW_CASTER_LAYER, SHADOW_CASTER_LAYER } from '../core/layers';

/**
 * Cascaded sun shadows for the lunar surface.
 *
 * Three.js's built-in shadow maps re-render every caster every frame, which
 * is far too expensive for multi-million-triangle terrain. The sun barely
 * moves, so each cascade here is rendered once and reused until the camera
 * leaves its centre region, the terrain inside it changes, or the sun moves.
 * At most one cascade is rendered per frame.
 *
 * Shadows are computed in the same "curved" space the terrain is displayed
 * in: both the depth pass and the receiver lookup drop every point by
 * `distance² / 2R` around the camera position the cascade was rendered from.
 * Seen from a camera that has moved on, that fixed warp differs from the
 * current one by a shear, which is exactly (to first order) how the sun
 * direction rotates as the observer travels over the sphere - so a cached
 * cascade stays correct while the camera moves.
 *
 * Casters are drawn with back faces only. Sunlit surfaces face the light and
 * are therefore never in the depth map, so they cannot shadow themselves
 * (no acne, no slope bias); surfaces facing away from the sun are already
 * dark from N·L.
 */

export const SUN_SHADOW_CASCADES = 3;

export interface SunShadowUniforms extends ReturnType<typeof rockViewUniforms> {
  uMovingShadowMap: { value: DepthTexture };
  uMovingShadowMatrix: { value: Matrix4 };
  uMovingShadowActive: { value: number };
  uSunShadowMap0: { value: DepthTexture };
  uSunShadowMap1: { value: DepthTexture };
  uSunShadowMap2: { value: DepthTexture };
  /** World (warped) space to shadow texture space, per cascade. */
  uSunShadowMatrix: { value: Matrix4[] };
  /** Per cascade: x, y = warp centre (world x, z), z = 1 / (2 * planetRadius) or 0. */
  uSunShadowWarp: { value: Vector3[] };
  /** World-space size of one shadow texel, per cascade. */
  uSunShadowTexel: { value: Vector3 };
  /** 1 once a cascade holds a rendered map, 0 before. */
  uSunShadowActive: { value: Vector3 };
}

export interface SunShadowOptions {
  /** Shadow map edge length in texels. */
  mapSize: number;
  /** Ground half-extent of the nearest cascade at low altitude, in metres. */
  baseHalfExtent: number;
  /** Size ratio between consecutive cascades. */
  cascadeRatio: number;
  /** Largest allowed half-extent of any cascade, in metres. */
  maxHalfExtent: number;
  /** Vertical relief each cascade must contain above and below the focus, in metres. */
  relief: readonly [number, number, number];
  /** Camera travel, as a fraction of a cascade's half-extent, that triggers a recentre. */
  recenterFraction: number;
  /** Minimum frames between terrain-triggered re-renders, per cascade. */
  terrainRefreshFrames: readonly [number, number, number];
  /** Sun direction change (radians) that triggers a re-render. */
  sunTolerance: number;
  /** Distance from the cascade focus to the shadow camera, in metres. */
  lightDistance: number;
}

export const DEFAULT_SUN_SHADOW_OPTIONS: SunShadowOptions = {
  mapSize: 2048,
  baseHalfExtent: 40,
  cascadeRatio: 7,
  maxHalfExtent: 4000,
  relief: [20, 80, 300],
  recenterFraction: 0.3,
  terrainRefreshFrames: [20, 45, 90],
  sunTolerance: 0.003,
  lightDistance: 6000,
};

/** The slice of WebGLRenderer the shadow pass needs. */
export interface ShadowPassRenderer {
  getRenderTarget(): WebGLRenderTarget | null;
  setRenderTarget(target: WebGLRenderTarget | null): void;
  clear(): void;
  render(scene: Scene, camera: Camera): void;
}

export interface CascadeFrameInput {
  /** Ground point under the camera. */
  focus: Vector3;
  /** Unit vector pointing towards the sun. */
  sunDirection: Vector3;
  /** Ground half-extent to cover around the focus. */
  halfExtent: number;
  /** Relief to contain above and below the focus. */
  relief: number;
  mapSize: number;
  lightDistance: number;
  /** 1 / (2 * planetRadius), or 0 when curvature is off. */
  invTwoRadius: number;
}

export interface CascadeFrame {
  eye: Vector3;
  target: Vector3;
  up: Vector3;
  halfWidth: number;
  halfHeight: number;
}

const WORLD_UP = new Vector3(0, 1, 0);
const scratchRight = new Vector3();

/**
 * Orthographic light frame covering a ground square of `halfExtent` around
 * the focus. The frame is snapped to whole shadow texels so a recentred
 * cascade samples the same world positions and shadow edges do not crawl.
 */
export function computeCascadeFrame(input: CascadeFrameInput, out: CascadeFrame): CascadeFrame {
  const { focus, sunDirection, halfExtent, mapSize } = input;

  const right = scratchRight.crossVectors(WORLD_UP, sunDirection);
  if (right.lengthSq() < 1e-8) {
    right.set(1, 0, 0);
  } else {
    right.normalize();
  }
  out.up.crossVectors(sunDirection, right).normalize();

  // The curvature warp lowers the corners of the footprint; centre the box
  // on the middle of the lowered range so it stays inside.
  const cornerDrop = 2 * halfExtent * halfExtent * input.invTwoRadius;
  const reliefHalf = input.relief + cornerDrop / 2;

  const sinElevation = Math.abs(sunDirection.y);
  const cosElevation = Math.sqrt(Math.max(0, 1 - sinElevation * sinElevation));
  out.halfWidth = halfExtent;
  out.halfHeight = halfExtent * sinElevation + reliefHalf * cosElevation;

  out.target.set(focus.x, focus.y - cornerDrop / 2, focus.z);
  const texelWidth = (2 * out.halfWidth) / mapSize;
  const texelHeight = (2 * out.halfHeight) / mapSize;
  const alongRight = out.target.dot(right);
  const alongUp = out.target.dot(out.up);
  out.target.addScaledVector(right, Math.round(alongRight / texelWidth) * texelWidth - alongRight);
  out.target.addScaledVector(out.up, Math.round(alongUp / texelHeight) * texelHeight - alongUp);

  out.eye.copy(out.target).addScaledVector(sunDirection, input.lightDistance);
  return out;
}

/**
 * Ground half-extent of every cascade for a camera altitude. The nearest
 * cascade doubles with altitude (in steps, so it is stable while hovering)
 * to keep shadow texels roughly pixel-sized from above.
 */
export function cascadeHalfExtents(
  altitude: number,
  options: Pick<SunShadowOptions, 'baseHalfExtent' | 'cascadeRatio' | 'maxHalfExtent'>
): [number, number, number] {
  const steps = Math.min(4, Math.max(0, Math.ceil(Math.log2(Math.max(altitude, 1) / 30))));
  const near = options.baseHalfExtent * 2 ** steps;
  const clamp = (value: number): number => Math.min(value, options.maxHalfExtent);
  return [clamp(near), clamp(near * options.cascadeRatio), clamp(near * options.cascadeRatio ** 2)];
}

/**
 * Sun direction an observer sees after travelling `(dx, dz)` over the sphere,
 * to first order: the sky tilts by distance / radius, raising a sun ahead.
 */
export function transportSunDirection(
  sunDirection: Vector3,
  dx: number,
  dz: number,
  invTwoRadius: number,
  out: Vector3
): Vector3 {
  const rise = (sunDirection.x * dx + sunDirection.z * dz) * 2 * invTwoRadius;
  return out.set(sunDirection.x, sunDirection.y + rise, sunDirection.z).normalize();
}

export interface SunShadowFrameState {
  cameraPosition: Vector3;
  /** Terrain height under the camera. */
  groundHeight: number;
  /** Unit vector towards the sun as seen from the camera. */
  sunDirection: Vector3;
  /** False while the sun is below the horizon; nothing is rendered then. */
  sunVisible: boolean;
  /** Changes whenever shadow-casting geometry is added, removed or swapped. */
  terrainRevision: number;
  /** Geometry that casts only into the nearest sun shadow map. */
  nearCasterRevision: number;
  /** Planet radius of the curvature warp, or null when curvature is off. */
  planetRadius: number | null;
}

interface CascadeState {
  valid: boolean;
  halfExtent: number;
  invTwoRadius: number;
  revision: number;
  renderedFrame: number;
  cameraX: number;
  cameraZ: number;
  focusY: number;
  sun: Vector3;
}

const DEPTH_VERTEX_SHADER = /* glsl */ `
uniform vec3 uWarp;
${rockScreenVertex}
void main() {
  #ifdef USE_INSTANCING
    vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position * rockScreenScale(), 1.0);
  #else
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  #endif
  vec2 fromCenter = worldPosition.xz - uWarp.xy;
  worldPosition.y -= dot(fromCenter, fromCenter) * uWarp.z;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const DEPTH_FRAGMENT_SHADER = /* glsl */ `
void main() {
  gl_FragColor = vec4(1.0);
}
`;

/**
 * Receiver-side GLSL: declarations plus `sunShadowVisibility(worldPos, worldNormal)`.
 * Requires the `SUN_SHADOW_MAP_SIZE` define (the shadow map edge length in texels).
 */
export const SUN_SHADOW_FRAGMENT_PARS = /* glsl */ `
uniform highp sampler2DShadow uMovingShadowMap;
uniform mat4 uMovingShadowMatrix;
uniform float uMovingShadowActive;
uniform highp sampler2DShadow uSunShadowMap0;
uniform highp sampler2DShadow uSunShadowMap1;
uniform highp sampler2DShadow uSunShadowMap2;
uniform mat4 uSunShadowMatrix[3];
uniform vec3 uSunShadowWarp[3];
uniform vec3 uSunShadowTexel;
uniform vec3 uSunShadowActive;

const float SUN_SHADOW_TEXEL_UV = 1.0 / float(SUN_SHADOW_MAP_SIZE);

vec3 sunShadowCoord(mat4 shadowMatrix, vec3 warp, vec3 worldPos, vec3 worldNormal, float texel) {
  // Normal offset keeps the filter kernel off the receiver's own back faces
  vec3 p = worldPos + worldNormal * (texel * 1.5);
  vec2 fromCenter = p.xz - warp.xy;
  p.y -= dot(fromCenter, fromCenter) * warp.z;
  return (shadowMatrix * vec4(p, 1.0)).xyz;
}

// 4 hardware-filtered compare taps: a 3x3 texel tent filter
float sunShadowPcf(highp sampler2DShadow shadowMap, vec3 coord) {
  vec2 o = vec2(SUN_SHADOW_TEXEL_UV * 0.75);
  return 0.25 * (
    texture(shadowMap, vec3(coord.xy + vec2(-o.x, -o.y), coord.z)) +
    texture(shadowMap, vec3(coord.xy + vec2(o.x, -o.y), coord.z)) +
    texture(shadowMap, vec3(coord.xy + vec2(-o.x, o.y), coord.z)) +
    texture(shadowMap, vec3(coord.xy + vec2(o.x, o.y), coord.z))
  );
}

// 0 at the cascade centre, 1 at (and beyond) its border
float sunShadowEdge(vec3 coord) {
  vec2 fromCenter = abs(coord.xy - 0.5) * 2.0;
  return coord.z >= 1.0 ? 1.0 : max(fromCenter.x, fromCenter.y);
}

float sunShadowCascade2(vec3 worldPos, vec3 worldNormal) {
  if (uSunShadowActive.z < 0.5) return 1.0;
  vec3 coord = sunShadowCoord(uSunShadowMatrix[2], uSunShadowWarp[2], worldPos, worldNormal, uSunShadowTexel.z);
  float edge = sunShadowEdge(coord);
  if (edge >= 1.0) return 1.0;
  return mix(sunShadowPcf(uSunShadowMap2, coord), 1.0, smoothstep(0.85, 1.0, edge));
}

float sunShadowCascade1(vec3 worldPos, vec3 worldNormal) {
  if (uSunShadowActive.y < 0.5) return sunShadowCascade2(worldPos, worldNormal);
  vec3 coord = sunShadowCoord(uSunShadowMatrix[1], uSunShadowWarp[1], worldPos, worldNormal, uSunShadowTexel.y);
  float edge = sunShadowEdge(coord);
  if (edge >= 1.0) return sunShadowCascade2(worldPos, worldNormal);
  float visibility = sunShadowPcf(uSunShadowMap1, coord);
  if (edge > 0.85) {
    visibility = mix(visibility, sunShadowCascade2(worldPos, worldNormal), smoothstep(0.85, 1.0, edge));
  }
  return visibility;
}

/** Fraction of sunlight reaching a surface point: 0 = fully shadowed, 1 = lit. */
float terrainShadowVisibility(vec3 worldPos, vec3 worldNormal) {
  if (uSunShadowActive.x < 0.5) return sunShadowCascade1(worldPos, worldNormal);
  float nearTexel = uSunShadowTexel.x;
  #ifndef MOON_ROCK
    // Resolve contact on the ground around small stones. Restore the wider
    // terrain bias with distance, where the nearest cascade mostly sees terrain.
    vec3 toEye = worldPos - cameraPosition;
    nearTexel *= mix(0.12, 1.0, smoothstep(36.0, 400.0, dot(toEye, toEye)));
  #endif
  vec3 coord = sunShadowCoord(uSunShadowMatrix[0], uSunShadowWarp[0], worldPos, worldNormal, nearTexel);
  float edge = sunShadowEdge(coord);
  if (edge >= 1.0) return sunShadowCascade1(worldPos, worldNormal);
  float visibility = sunShadowPcf(uSunShadowMap0, coord);
  if (edge > 0.85) {
    visibility = mix(visibility, sunShadowCascade1(worldPos, worldNormal), smoothstep(0.85, 1.0, edge));
  }
  return visibility;
}

float sunShadowVisibility(vec3 worldPos, vec3 worldNormal) {
  float terrain = terrainShadowVisibility(worldPos, worldNormal);
  if (uMovingShadowActive < 0.5 || terrain <= 0.0) return terrain;
  // Half a vehicle-map texel of normal offset protects thin, two-sided parts.
  vec3 coord = (uMovingShadowMatrix * vec4(worldPos + worldNormal * 0.005, 1.0)).xyz;
  if (any(lessThanEqual(coord, vec3(0.0))) || any(greaterThanEqual(coord, vec3(1.0)))) return terrain;
  return min(terrain, texture(uMovingShadowMap, vec3(coord.xy, coord.z - 0.00002)));
}
`;

function shadowTarget(size: number): WebGLRenderTarget {
  const depthTexture = new DepthTexture(size, size, UnsignedIntType);
  depthTexture.compareFunction = LessEqualCompare;
  depthTexture.magFilter = depthTexture.minFilter = LinearFilter;
  return new WebGLRenderTarget(size, size, {
    depthTexture, depthBuffer: true, stencilBuffer: false, format: RedFormat,
    type: UnsignedByteType, generateMipmaps: false,
  });
}

// The camera translates with the chassis. A mark on a slowly moving panel
// stays on the same shadow texel; wheel and suspension poses still update.
class MovingShadow {
  readonly target = shadowTarget(512);
  readonly camera = new OrthographicCamera(-2.6, 2.6, 2.6, -2.6, 0.1, 128);
  private readonly scene = new Scene();
  private readonly focus = new Vector3();
  private readonly meshes: { source: Mesh; depth: Mesh }[] = [];
  private readonly materials = new Map<MeshStandardMaterial, MeshDepthMaterial>();

  constructor(private readonly root: Object3D) {
    root.traverse(source => {
      if (!(source instanceof Mesh)) return;
      const surface = source.material as MeshStandardMaterial;
      let material = this.materials.get(surface);
      if (!material) {
        material = new MeshDepthMaterial({
          side: DoubleSide, colorWrite: false,
          alphaMap: surface.alphaMap, alphaTest: surface.alphaTest,
        });
        this.materials.set(surface, material);
      }
      const depth = new Mesh(source.geometry, material);
      depth.matrixAutoUpdate = false;
      this.scene.add(depth);
      this.meshes.push({ source, depth });
    });
  }

  render(renderer: ShadowPassRenderer, sun: Vector3): void {
    this.root.updateWorldMatrix(true, true);
    this.focus.setFromMatrixPosition(this.root.matrixWorld);
    this.focus.y += 0.55;
    this.camera.position.copy(this.focus).addScaledVector(sun, 5);
    this.camera.up.set(0, 1, 0);
    if (Math.abs(sun.y) > 0.9999) this.camera.up.set(0, 0, 1);
    this.camera.lookAt(this.focus);
    this.camera.updateMatrixWorld();
    for (const { source, depth } of this.meshes) {
      depth.matrix.copy(source.matrixWorld);
      depth.matrixWorldNeedsUpdate = true;
    }
    const previous = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(this.target);
      renderer.clear();
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setRenderTarget(previous);
    }
  }

  dispose(): void {
    this.target.dispose();
    for (const material of this.materials.values()) material.dispose();
  }
}

export class SunShadows {
  readonly uniforms: SunShadowUniforms;
  readonly options: SunShadowOptions;

  private readonly renderer: ShadowPassRenderer;
  private readonly targets: WebGLRenderTarget[] = [];
  private readonly camera: OrthographicCamera;
  private readonly depthMaterial: ShaderMaterial;
  private readonly cascades: CascadeState[] = [];
  private readonly frame: CascadeFrame = {
    eye: new Vector3(),
    target: new Vector3(),
    up: new Vector3(),
    halfWidth: 1,
    halfHeight: 1,
  };
  private readonly focus = new Vector3();
  private readonly expectedSun = new Vector3();
  private readonly biasMatrix = new Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1
  );

  private frameIndex = 0;
  private pendingCascade = -1;
  private pendingState: SunShadowFrameState | null = null;
  private pendingHalfExtent = 0;
  private renderedNearCasterRevision = -1;
  private movingShadow: MovingShadow | null = null;
  private movingPassPending = false;
  private readonly movingSun = new Vector3();
  private renderCount = 0;

  setMovingCaster(root: Object3D | null): void {
    this.movingShadow?.dispose();
    this.movingShadow = root ? new MovingShadow(root) : null;
    this.movingPassPending = false;
    this.uniforms.uMovingShadowActive.value = 0;
    this.uniforms.uMovingShadowMap.value = this.movingShadow?.target.depthTexture ?? this.uniforms.uSunShadowMap0.value;
  }

  constructor(renderer: ShadowPassRenderer, options: Partial<SunShadowOptions> = {}) {
    this.renderer = renderer;
    this.options = { ...DEFAULT_SUN_SHADOW_OPTIONS, ...options };
    const { mapSize, lightDistance } = this.options;

    for (let i = 0; i < SUN_SHADOW_CASCADES; i++) {
      this.targets.push(shadowTarget(mapSize));
      this.cascades.push({
        valid: false,
        halfExtent: 0,
        invTwoRadius: 0,
        revision: -1,
        renderedFrame: -Infinity,
        cameraX: 0,
        cameraZ: 0,
        focusY: 0,
        sun: new Vector3(0, 1, 0),
      });
    }

    this.camera = new OrthographicCamera(-1, 1, 1, -1, 1, lightDistance * 2);
    this.camera.layers.set(SHADOW_CASTER_LAYER);
    this.camera.matrixAutoUpdate = true;

    const rockView = rockViewUniforms();
    this.depthMaterial = new ShaderMaterial({
      vertexShader: DEPTH_VERTEX_SHADER,
      fragmentShader: DEPTH_FRAGMENT_SHADER,
      uniforms: { uWarp: { value: new Vector3() }, ...rockView },
      side: BackSide,
      colorWrite: false,
    });

    const depthTextures = this.targets.map((target) => target.depthTexture as DepthTexture);
    this.uniforms = {
      ...rockView,
      uMovingShadowMap: { value: depthTextures[0] },
      uMovingShadowMatrix: { value: new Matrix4() },
      uMovingShadowActive: { value: 0 },
      uSunShadowMap0: { value: depthTextures[0] },
      uSunShadowMap1: { value: depthTextures[1] },
      uSunShadowMap2: { value: depthTextures[2] },
      uSunShadowMatrix: { value: [new Matrix4(), new Matrix4(), new Matrix4()] },
      uSunShadowWarp: { value: [new Vector3(), new Vector3(), new Vector3()] },
      uSunShadowTexel: { value: new Vector3(1, 1, 1) },
      uSunShadowActive: { value: new Vector3(0, 0, 0) },
    };
  }

  /** Number of cascade renders performed so far (for stats and tests). */
  getRenderCount(): number {
    return this.renderCount;
  }

  /**
   * Decide whether a cascade must be re-rendered this frame. Cheap; call once
   * per frame. Returns true when `renderPending()` has work to do.
   */
  plan(state: SunShadowFrameState): boolean {
    this.frameIndex++;
    this.pendingCascade = -1;
    this.pendingState = null;
    this.movingPassPending = this.movingShadow !== null && state.sunVisible;
    if (this.movingPassPending) this.movingSun.copy(state.sunDirection);
    else this.uniforms.uMovingShadowActive.value = 0;
    if (!state.sunVisible) return false;

    const { options } = this;
    const altitude = state.cameraPosition.y - state.groundHeight;
    const extents = cascadeHalfExtents(altitude, options);
    const invTwoRadius = state.planetRadius ? 1 / (2 * state.planetRadius) : 0;

    let chosen = -1;
    for (let i = 0; i < SUN_SHADOW_CASCADES; i++) {
      const cascade = this.cascades[i];
      const halfExtent = extents[i];
      let stale = !cascade.valid || cascade.halfExtent !== halfExtent || cascade.invTwoRadius !== invTwoRadius;
      if (!stale) {
        const dx = state.cameraPosition.x - cascade.cameraX;
        const dz = state.cameraPosition.z - cascade.cameraZ;
        const travelled = Math.sqrt(dx * dx + dz * dz);
        const expected = transportSunDirection(cascade.sun, dx, dz, invTwoRadius, this.expectedSun);
        stale =
          travelled > options.recenterFraction * halfExtent ||
          Math.abs(state.groundHeight - cascade.focusY) > options.relief[i] * 0.5 ||
          expected.angleTo(state.sunDirection) > options.sunTolerance;
      }
      if (stale) {
        // Geometry-independent staleness always wins: nearest cascade first
        chosen = i;
        break;
      }
      const geometryChanged =
        cascade.revision !== state.terrainRevision ||
        (i === 0 && this.renderedNearCasterRevision !== state.nearCasterRevision);
      const refreshDue =
        geometryChanged &&
        this.frameIndex - cascade.renderedFrame >= options.terrainRefreshFrames[i];
      if (refreshDue && chosen < 0) chosen = i;
    }

    if (chosen < 0) return this.movingPassPending;
    this.pendingCascade = chosen;
    this.pendingState = state;
    this.pendingHalfExtent = extents[chosen];
    return true;
  }

  /**
   * Render the cascade chosen by the last `plan()` call, if any. Restores the
   * renderer's target and the scene's override material afterwards.
   */
  renderPending(scene: Scene): boolean {
    const index = this.pendingCascade;
    const state = this.pendingState;
    this.pendingCascade = -1;
    this.pendingState = null;
    const moving = this.movingShadow;
    const drawMoving = this.movingPassPending && moving !== null;
    this.movingPassPending = false;
    if (drawMoving) {
      moving.render(this.renderer, this.movingSun);
      this.uniforms.uMovingShadowMatrix.value.copy(this.biasMatrix)
        .multiply(moving.camera.projectionMatrix).multiply(moving.camera.matrixWorldInverse);
      this.uniforms.uMovingShadowActive.value = 1;
    }
    if (index < 0 || !state) return drawMoving;

    const { options } = this;
    const cascade = this.cascades[index];
    const invTwoRadius = state.planetRadius ? 1 / (2 * state.planetRadius) : 0;
    this.focus.set(state.cameraPosition.x, state.groundHeight, state.cameraPosition.z);

    const frame = computeCascadeFrame(
      {
        focus: this.focus,
        sunDirection: state.sunDirection,
        halfExtent: this.pendingHalfExtent,
        relief: options.relief[index],
        mapSize: options.mapSize,
        lightDistance: options.lightDistance,
        invTwoRadius,
      },
      this.frame
    );

    const camera = this.camera;
    if (index === 0) camera.layers.enable(NEAR_SHADOW_CASTER_LAYER);
    else camera.layers.disable(NEAR_SHADOW_CASTER_LAYER);
    camera.left = -frame.halfWidth;
    camera.right = frame.halfWidth;
    camera.top = frame.halfHeight;
    camera.bottom = -frame.halfHeight;
    camera.updateProjectionMatrix();
    camera.position.copy(frame.eye);
    camera.up.copy(frame.up);
    camera.lookAt(frame.target);
    camera.updateMatrixWorld(true);

    const warp = this.depthMaterial.uniforms.uWarp.value as Vector3;
    warp.set(state.cameraPosition.x, state.cameraPosition.z, invTwoRadius);

    const previousTarget = this.renderer.getRenderTarget();
    const previousOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.depthMaterial;
    this.renderer.setRenderTarget(this.targets[index]);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(previousTarget);
    scene.overrideMaterial = previousOverride;

    this.uniforms.uSunShadowMatrix.value[index]
      .copy(this.biasMatrix)
      .multiply(camera.projectionMatrix)
      .multiply(camera.matrixWorldInverse);
    this.uniforms.uSunShadowWarp.value[index].copy(warp);
    this.uniforms.uSunShadowTexel.value.setComponent(index, (2 * frame.halfWidth) / options.mapSize);
    this.uniforms.uSunShadowActive.value.setComponent(index, 1);

    cascade.valid = true;
    cascade.halfExtent = this.pendingHalfExtent;
    cascade.invTwoRadius = invTwoRadius;
    cascade.revision = state.terrainRevision;
    if (index === 0) {
      this.renderedNearCasterRevision = state.nearCasterRevision;
    }
    cascade.renderedFrame = this.frameIndex;
    cascade.cameraX = state.cameraPosition.x;
    cascade.cameraZ = state.cameraPosition.z;
    cascade.focusY = state.groundHeight;
    cascade.sun.copy(state.sunDirection);
    this.renderCount++;
    return true;
  }

  /** Forget every rendered cascade (e.g. after a teleport or settings change). */
  invalidate(): void {
    for (const cascade of this.cascades) cascade.valid = false;
    this.uniforms.uSunShadowActive.value.set(0, 0, 0);
  }

  dispose(): void {
    this.setMovingCaster(null);
    for (const target of this.targets) {
      target.depthTexture?.dispose();
      target.dispose();
    }
    this.depthMaterial.dispose();
  }
}
