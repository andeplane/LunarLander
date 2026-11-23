import { type Camera, Group, InstancedMesh, Matrix4, Mesh, type OrthographicCamera, Scene, Vector3, type WebGLRenderTarget } from 'three';
import { describe, expect, it } from 'vitest';
import { NEAR_SHADOW_CASTER_LAYER, SHADOW_CASTER_LAYER } from '../core/layers';
import {
  type CascadeFrame,
  cascadeHalfExtents,
  computeCascadeFrame,
  DEFAULT_SUN_SHADOW_OPTIONS,
  type ShadowPassRenderer,
  SUN_SHADOW_CASCADES,
  SUN_SHADOW_FRAGMENT_PARS,
  type SunShadowFrameState,
  SunShadows,
  transportSunDirection,
} from './SunShadows';

interface RecordedPass {
  target: WebGLRenderTarget | null;
  overrideWasSet: boolean;
  camera: Camera;
}

class FakeRenderer implements ShadowPassRenderer {
  current: WebGLRenderTarget | null = null;
  clears = 0;
  readonly passes: RecordedPass[] = [];

  getRenderTarget(): WebGLRenderTarget | null {
    return this.current;
  }
  setRenderTarget(target: WebGLRenderTarget | null): void {
    this.current = target;
  }
  clear(): void {
    this.clears++;
  }
  render(scene: Scene, camera: Camera): void {
    this.passes.push({ target: this.current, overrideWasSet: scene.overrideMaterial !== null, camera });
  }
}

function emptyFrame(): CascadeFrame {
  return { eye: new Vector3(), target: new Vector3(), up: new Vector3(), halfWidth: 0, halfHeight: 0 };
}

function makeState(overrides: Partial<SunShadowFrameState> = {}): SunShadowFrameState {
  return {
    cameraPosition: new Vector3(0, 2, 0),
    groundHeight: 0,
    sunDirection: new Vector3(1, 1, 0).normalize(),
    sunVisible: true,
    terrainRevision: 1,
    nearCasterRevision: 0,
    planetRadius: null,
    ...overrides,
  };
}

/** Run frames until nothing is pending; returns the number of cascade renders. */
function settle(shadows: SunShadows, scene: Scene, state: SunShadowFrameState, maxFrames = 10): number {
  let renders = 0;
  for (let i = 0; i < maxFrames; i++) {
    if (!shadows.plan(state)) break;
    if (shadows.renderPending(scene)) renders++;
  }
  return renders;
}

describe('computeCascadeFrame', () => {
  const base = {
    focus: new Vector3(10, 5, -20),
    halfExtent: 40,
    relief: 20,
    mapSize: 1024,
    lightDistance: 6000,
    invTwoRadius: 0,
  };

  it('looks down the sun direction from lightDistance away', () => {
    const sun = new Vector3(1, 1, 0).normalize();
    const frame = computeCascadeFrame({ ...base, sunDirection: sun }, emptyFrame());

    const toEye = frame.eye.clone().sub(frame.target);
    expect(toEye.length()).toBeCloseTo(6000);
    expect(toEye.normalize().dot(sun)).toBeCloseTo(1);
    expect(frame.up.dot(sun)).toBeCloseTo(0);
    expect(frame.up.length()).toBeCloseTo(1);
  });

  it('covers the ground square and the relief at the given sun elevation', () => {
    const sun = new Vector3(Math.cos(0.2), Math.sin(0.2), 0);
    const frame = computeCascadeFrame({ ...base, sunDirection: sun }, emptyFrame());

    expect(frame.halfWidth).toBe(40);
    expect(frame.halfHeight).toBeCloseTo(40 * Math.sin(0.2) + 20 * Math.cos(0.2));
  });

  it('snaps the target to whole texels so recentring does not crawl', () => {
    const sun = new Vector3(0.3, 0.8, 0.5).normalize();
    const frame = computeCascadeFrame({ ...base, sunDirection: sun }, emptyFrame());
    const right = new Vector3().crossVectors(new Vector3(0, 1, 0), sun).normalize();

    const texel = (2 * frame.halfWidth) / base.mapSize;
    const along = frame.target.dot(right) / texel;
    expect(along).toBeCloseTo(Math.round(along), 5);
    expect(frame.target.distanceTo(base.focus)).toBeLessThan(texel * 2);
  });

  it('handles a sun straight overhead', () => {
    const frame = computeCascadeFrame({ ...base, sunDirection: new Vector3(0, 1, 0) }, emptyFrame());
    expect(frame.up.length()).toBeCloseTo(1);
    expect(frame.halfHeight).toBeCloseTo(40);
  });

  it('lowers and deepens the box to contain the curvature drop', () => {
    const sun = new Vector3(1, 0, 0);
    const flat = computeCascadeFrame({ ...base, sunDirection: sun }, emptyFrame());
    const curved = computeCascadeFrame({ ...base, sunDirection: sun, invTwoRadius: 1 / 2000 }, emptyFrame());

    const cornerDrop = 2 * 40 * 40 * (1 / 2000);
    expect(curved.halfHeight).toBeCloseTo(flat.halfHeight + cornerDrop / 2);
    expect(curved.target.y).toBeLessThan(flat.target.y);
  });
});

describe('cascadeHalfExtents', () => {
  it('uses the base extent near the ground', () => {
    expect(cascadeHalfExtents(2, DEFAULT_SUN_SHADOW_OPTIONS)).toEqual([40, 280, 1960]);
    expect(cascadeHalfExtents(-5, DEFAULT_SUN_SHADOW_OPTIONS)).toEqual([40, 280, 1960]);
  });

  it('doubles the near cascade in steps with altitude and clamps', () => {
    expect(cascadeHalfExtents(50, DEFAULT_SUN_SHADOW_OPTIONS)[0]).toBe(80);
    expect(cascadeHalfExtents(100, DEFAULT_SUN_SHADOW_OPTIONS)[0]).toBe(160);
    const high = cascadeHalfExtents(100000, DEFAULT_SUN_SHADOW_OPTIONS);
    expect(high[0]).toBe(640);
    expect(high[1]).toBe(4000);
    expect(high[2]).toBe(4000);
  });
});

describe('transportSunDirection', () => {
  it('leaves the sun alone without curvature or travel', () => {
    const sun = new Vector3(0.6, 0.8, 0);
    expect(transportSunDirection(sun, 100, 50, 0, new Vector3()).distanceTo(sun)).toBeCloseTo(0);
    expect(transportSunDirection(sun, 0, 0, 1 / 10000, new Vector3()).distanceTo(sun)).toBeCloseTo(0);
  });

  it('raises a sun the observer travels towards and lowers one left behind', () => {
    const sun = new Vector3(0.8, 0.6, 0);
    const towards = transportSunDirection(sun, 500, 0, 1 / 10000, new Vector3());
    const away = transportSunDirection(sun, -500, 0, 1 / 10000, new Vector3());

    expect(towards.y).toBeGreaterThan(sun.y);
    expect(away.y).toBeLessThan(sun.y);
    expect(towards.length()).toBeCloseTo(1);
  });
});

describe('SunShadows', () => {
  function setup(): { shadows: SunShadows; renderer: FakeRenderer; scene: Scene } {
    const renderer = new FakeRenderer();
    const shadows = new SunShadows(renderer, { mapSize: 64 });
    return { shadows, renderer, scene: new Scene() };
  }

  it('exposes one depth texture per cascade and starts inactive', () => {
    const { shadows } = setup();
    const { uniforms } = shadows;

    expect(SUN_SHADOW_CASCADES).toBe(3);
    expect(uniforms.uSunShadowMap0.value.isDepthTexture).toBe(true);
    expect(new Set([uniforms.uSunShadowMap0.value, uniforms.uSunShadowMap1.value, uniforms.uSunShadowMap2.value]).size).toBe(3);
    expect(uniforms.uSunShadowActive.value.toArray()).toEqual([0, 0, 0]);
    expect(shadows.options.mapSize).toBe(64);
    expect(shadows.options.cascadeRatio).toBe(DEFAULT_SUN_SHADOW_OPTIONS.cascadeRatio);
    shadows.dispose();
  });

  it('renders one cascade per frame, nearest first, then goes idle', () => {
    const { shadows, renderer, scene } = setup();
    const state = makeState();

    expect(settle(shadows, scene, state)).toBe(3);
    expect(shadows.getRenderCount()).toBe(3);
    expect(shadows.uniforms.uSunShadowActive.value.toArray()).toEqual([1, 1, 1]);
    expect(shadows.uniforms.uSunShadowTexel.value.x).toBeCloseTo(80 / 64);
    expect(shadows.uniforms.uSunShadowTexel.value.y).toBeCloseTo(560 / 64);
    expect(shadows.plan(state)).toBe(false);
    expect(shadows.renderPending(scene)).toBe(false);
    expect(renderer.clears).toBe(3);
  });

  it('renders shadow casters only, with the depth override, and restores state', () => {
    const { shadows, renderer, scene } = setup();
    const previousTarget = shadows.uniforms.uSunShadowMap0.value;
    expect(previousTarget).toBeDefined();
    scene.overrideMaterial = null;

    shadows.plan(makeState());
    shadows.renderPending(scene);

    const pass = renderer.passes[0];
    expect(pass.overrideWasSet).toBe(true);
    expect(pass.target?.depthTexture).toBe(shadows.uniforms.uSunShadowMap0.value);
    expect(scene.overrideMaterial).toBeNull();
    expect(renderer.current).toBeNull();

    const caster = new Mesh();
    caster.layers.enable(SHADOW_CASTER_LAYER);
    expect(pass.camera.layers.test(caster.layers)).toBe(true);
    expect(pass.camera.layers.test(new Mesh().layers)).toBe(false);
    expect(pass.camera.layers.test(new InstancedMesh(undefined, undefined, 1).layers)).toBe(false);
    expect(pass.camera.layers.isEnabled(NEAR_SHADOW_CASTER_LAYER)).toBe(true);
    shadows.plan(makeState());
    shadows.renderPending(scene);
    expect(renderer.passes[1].camera.layers.isEnabled(NEAR_SHADOW_CASTER_LAYER)).toBe(false);
  });

  it('tracks submillimetre caster motion every frame while terrain shadows stay cached', () => {
    const { shadows, renderer, scene } = setup();
    const state = makeState();
    settle(shadows, scene, state);
    const rover = new Group();
    rover.add(new Mesh());
    shadows.setMovingCaster(rover);
    for (let frame = 1; frame <= 120; frame++) {
      rover.position.z += 0.2 / 3.6 / 60;
      expect(shadows.plan(state)).toBe(true);
      expect(shadows.renderPending(scene)).toBe(true);
      const center = rover.position.clone().add(new Vector3(0, 0.55, 0))
        .applyMatrix4(shadows.uniforms.uMovingShadowMatrix.value);
      expect(center.x).toBeCloseTo(0.5, 8);
      expect(center.y).toBeCloseTo(0.5, 8);
      expect(renderer.passes[renderer.passes.length - 1].target?.depthTexture).toBe(shadows.uniforms.uMovingShadowMap.value);
    }
    expect(shadows.getRenderCount()).toBe(3);
    expect(shadows.uniforms.uMovingShadowActive.value).toBe(1);
    shadows.setMovingCaster(null);
    expect(shadows.uniforms.uMovingShadowActive.value).toBe(0);
    expect(shadows.plan(state)).toBe(false);
    shadows.dispose();
  });

  it('resizes the live rover target and uses the selected resolution on the next drive', () => {
    const { shadows, scene, renderer } = setup();
    shadows.setMovingCaster(new Mesh());
    for (const [quality, size] of [['high', 2048], ['balanced', 1024], ['performance', 512]] as const) {
      shadows.setRoverShadowQuality(quality);
      shadows.plan(makeState());
      renderer.passes.length = 0;
      shadows.renderPending(scene);
      expect(renderer.passes[0].target?.width).toBe(size);
      expect(shadows.uniforms.uMovingShadowTexelUV.value).toBe(1 / size);
    }
    shadows.setMovingCaster(null);
    shadows.setMovingCaster(new Mesh());
    expect(shadows.uniforms.uMovingShadowMap.value.image.width).toBe(512);
    shadows.dispose();
  });

  it('maps the focus to the centre of the shadow map', () => {
    const { shadows, scene } = setup();
    const state = makeState({ cameraPosition: new Vector3(120, 9, -45), groundHeight: 7 });
    shadows.plan(state);
    shadows.renderPending(scene);

    const coord = new Vector3(120, 7, -45).applyMatrix4(shadows.uniforms.uSunShadowMatrix.value[0]);
    expect(coord.x).toBeCloseTo(0.5, 1);
    expect(coord.y).toBeCloseTo(0.5, 1);
    expect(coord.z).toBeGreaterThan(0);
    expect(coord.z).toBeLessThan(1);
    expect(shadows.uniforms.uSunShadowMatrix.value[1].equals(new Matrix4())).toBe(true);
  });

  it('stores the curvature warp used for the render', () => {
    const { shadows, scene } = setup();
    shadows.plan(makeState({ cameraPosition: new Vector3(30, 2, 40), planetRadius: 5000 }));
    shadows.renderPending(scene);

    const warp = shadows.uniforms.uSunShadowWarp.value[0];
    expect(warp.x).toBe(30);
    expect(warp.y).toBe(40);
    expect(warp.z).toBeCloseTo(1 / 10000);
  });

  it('does nothing while the sun is down', () => {
    const { shadows, scene } = setup();
    expect(shadows.plan(makeState({ sunVisible: false }))).toBe(false);
    expect(shadows.renderPending(scene)).toBe(false);
    expect(shadows.getRenderCount()).toBe(0);
  });

  it('recentres only the cascades the camera has outrun', () => {
    const { shadows, scene } = setup();
    settle(shadows, scene, makeState());

    // 20 m: beyond 30% of the 40 m cascade, well inside the larger ones
    const moved = makeState({ cameraPosition: new Vector3(20, 2, 0) });
    expect(settle(shadows, scene, moved)).toBe(1);

    const near = makeState({ cameraPosition: new Vector3(22, 2, 0) });
    expect(settle(shadows, scene, near)).toBe(0);
  });

  it('keeps cascades while moving over a curved planet (the sun shift is expected)', () => {
    const { shadows, scene } = setup();
    const radius = 5000;
    const sun = new Vector3(0.8, 0.6, 0);
    settle(shadows, scene, makeState({ planetRadius: radius, sunDirection: sun.clone() }));

    const transported = transportSunDirection(sun, 8, 0, 1 / (2 * radius), new Vector3());
    const moved = makeState({ planetRadius: radius, cameraPosition: new Vector3(8, 2, 0), sunDirection: transported });
    expect(settle(shadows, scene, moved)).toBe(0);
  });

  it('re-renders everything when the sun really moves', () => {
    const { shadows, scene } = setup();
    settle(shadows, scene, makeState());
    expect(settle(shadows, scene, makeState({ sunDirection: new Vector3(1, 0.5, 0).normalize() }))).toBe(3);
  });

  it('re-renders when altitude changes the cascade extents or the ground moves', () => {
    const { shadows, scene } = setup();
    settle(shadows, scene, makeState());

    expect(settle(shadows, scene, makeState({ cameraPosition: new Vector3(0, 200, 0) }))).toBe(3);
    expect(shadows.uniforms.uSunShadowTexel.value.x).toBeCloseTo(640 / 64);

    const climbed = makeState({ cameraPosition: new Vector3(0, 215, 0), groundHeight: 15 });
    expect(settle(shadows, scene, climbed)).toBeGreaterThanOrEqual(1);
  });

  it('rate-limits terrain-triggered refreshes per cascade', () => {
    const renderer = new FakeRenderer();
    const shadows = new SunShadows(renderer, { mapSize: 64, terrainRefreshFrames: [3, 6, 9] });
    const scene = new Scene();
    settle(shadows, scene, makeState());
    const before = shadows.getRenderCount();

    const changed = makeState({ terrainRevision: 2 });
    let renders = 0;
    for (let frame = 0; frame < 12; frame++) {
      if (shadows.plan(changed) && shadows.renderPending(scene)) renders++;
    }

    // Every cascade refreshes exactly once, each after its own delay
    expect(renders).toBe(3);
    expect(shadows.getRenderCount()).toBe(before + 3);
    expect(shadows.plan(changed)).toBe(false);
  });

  it('refreshes only the nearest map when close pebbles move', () => {
    const renderer = new FakeRenderer();
    const shadows = new SunShadows(renderer, { mapSize: 64, terrainRefreshFrames: [1, 1, 1] });
    const scene = new Scene();
    expect(settle(shadows, scene, makeState())).toBe(3);

    expect(settle(shadows, scene, makeState({ nearCasterRevision: 1 }))).toBe(1);
    expect(renderer.passes[3].target).toBe(renderer.passes[0].target);
  });

  it('invalidate() forces a full re-render and hides stale maps', () => {
    const { shadows, scene } = setup();
    const state = makeState();
    settle(shadows, scene, state);

    shadows.invalidate();
    expect(shadows.uniforms.uSunShadowActive.value.toArray()).toEqual([0, 0, 0]);
    expect(settle(shadows, scene, state)).toBe(3);
  });

  it('configures the shadow camera frustum from the cascade frame', () => {
    const { shadows, renderer, scene } = setup();
    shadows.plan(makeState());
    shadows.renderPending(scene);

    const camera = renderer.passes[0].camera as OrthographicCamera;
    expect(camera.right).toBe(40);
    expect(camera.left).toBe(-40);
    expect(camera.top).toBeGreaterThan(0);
    expect(camera.position.length()).toBeGreaterThan(5000);
  });
});

describe('SUN_SHADOW_FRAGMENT_PARS', () => {
  it('declares the receiver entry point and depends on the map size define', () => {
    expect(SUN_SHADOW_FRAGMENT_PARS).toContain('float sunShadowVisibility(vec3 worldPos, vec3 worldNormal)');
    expect(SUN_SHADOW_FRAGMENT_PARS).toContain('SUN_SHADOW_MAP_SIZE');
    expect(SUN_SHADOW_FRAGMENT_PARS).toContain('sampler2DShadow uSunShadowMap2');
  });
});
