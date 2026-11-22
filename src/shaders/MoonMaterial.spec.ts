import { DataTexture, ShaderChunk, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { type ShadowPassRenderer, SunShadows } from '../rendering/SunShadows';
import {
  DIRECTIONAL_LIGHT_ANCHOR,
  getSharedRegolithDetailMap,
  MoonMaterial,
  type MoonMaterialOptions,
} from './MoonMaterial';

interface FakeShader {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
}

const detailMap = new DataTexture(new Uint8Array(4), 1, 1);

const idleRenderer: ShadowPassRenderer = {
  getRenderTarget: () => null,
  setRenderTarget: () => {},
  clear: () => {},
  render: () => {},
};

function createMaterial(options: MoonMaterialOptions = {}): MoonMaterial {
  return new MoonMaterial({ detailMap, ...options });
}

/**
 * Simulate Three.js compiling the material by invoking onBeforeCompile
 * with a minimal fake shader object. This is pure string/object manipulation,
 * so no WebGL context is needed.
 */
function compile(material: MoonMaterial): FakeShader {
  const shader: FakeShader = {
    uniforms: {},
    vertexShader: '#include <uv_vertex>\n#include <worldpos_vertex>\n#include <project_vertex>',
    fragmentShader:
      '#include <color_fragment>\n#include <normal_fragment_begin>\n#include <lights_fragment_begin>\n#include <opaque_fragment>',
  };
  const onBeforeCompile = material.onBeforeCompile as unknown as (
    shader: FakeShader,
    renderer: unknown
  ) => void;
  onBeforeCompile(shader, undefined);
  return shader;
}

describe('MoonMaterial param handling', () => {
  it('pushes params to uniforms, including zero values', () => {
    const material = createMaterial();
    const shader = compile(material);

    material.setParam('detailStrength', 0);
    material.setParam('backscatter', 0);
    material.setParam('craterletStrength', 0);
    material.setParam('ambientFill', 0);
    material.setParam('enableColorVariation', false);
    material.setParam('enableCurvature', false);

    expect(shader.uniforms.uDetailStrength.value).toBe(0);
    expect(shader.uniforms.uBackscatter.value).toBe(0);
    expect(shader.uniforms.uCraterletStrength.value).toBe(0);
    expect(shader.uniforms.uAmbientFill.value).toBe(0);
    expect(shader.uniforms.uEnableColorVariation.value).toBe(0);
    expect(shader.uniforms.uEnableCurvature.value).toBe(0);
  });

  it('keeps values set before the first compile', () => {
    const material = createMaterial();
    material.setParam('brightnessBoost', 1.7);
    material.setSunDirection(new Vector3(0, 0, 1));

    const shader = compile(material);

    expect(shader.uniforms.uBrightnessBoost.value).toBe(1.7);
    expect(shader.uniforms.uSunDirection.value).toEqual(new Vector3(0, 0, 1));
  });

  it('shares uniform objects between program variants (mesh and instanced)', () => {
    const material = createMaterial();
    const first = compile(material);
    const second = compile(material);

    material.setParam('planetRadius', 9000);

    expect(first.uniforms.uPlanetRadius).toBe(second.uniforms.uPlanetRadius);
    expect(first.uniforms.uPlanetRadius.value).toBe(9000);
  });

  it('switches the detail branch off with a negative strength', () => {
    const material = createMaterial();
    const shader = compile(material);

    material.setParam('enableDetail', false);
    expect(shader.uniforms.uDetailStrength.value).toBe(-1);

    material.setParam('enableDetail', true);
    expect(shader.uniforms.uDetailStrength.value).toBe(1);
  });

  it('does not trigger a shader recompile when uniform values change', () => {
    const material = createMaterial();
    compile(material);

    const versionBefore = material.version;
    material.setParam('detailContrast', 3.0);
    material.setParams({ oppositionSurge: 0.5, shadowStrength: 0.2 });
    material.setSunHorizonFade(0.25);

    // needsUpdate = true would bump material.version, forcing getProgram to re-run
    expect(material.version).toBe(versionBefore);
    expect(material.getParam('detailContrast')).toBe(3.0);
    expect(material.getParams().oppositionSurge).toBe(0.5);
    expect(material.getParam('sunHorizonFade')).toBe(0.25);
  });

  it('setParam is a no-op when the value is unchanged', () => {
    const material = createMaterial();
    const shader = compile(material);

    // Poison the uniform: if updateUniforms ran, it would overwrite this
    shader.uniforms.uDetailContrast.value = -1;
    material.setParam('detailContrast', material.getParam('detailContrast'));
    expect(shader.uniforms.uDetailContrast.value).toBe(-1);

    // A real change refreshes the uniform
    material.setParam('detailContrast', 2.0);
    expect(shader.uniforms.uDetailContrast.value).toBe(2.0);
  });

  it('setParams is a no-op when no value changed', () => {
    const material = createMaterial();
    const shader = compile(material);

    shader.uniforms.uBackscatter.value = -1;
    material.setParams({
      backscatter: material.getParam('backscatter'),
      debugMode: material.getParam('debugMode'),
    });
    expect(shader.uniforms.uBackscatter.value).toBe(-1);

    material.setParams({ debugMode: 3 });
    expect(shader.uniforms.uDebugMode.value).toBe(3);
  });
});

describe('MoonMaterial shader injection', () => {
  it('does not redeclare worldPosition when worldpos_vertex expands (shadows/envmap)', () => {
    const material = createMaterial();
    const shader = compile(material);

    // The <worldpos_vertex> include must survive so Three.js can expand it
    expect(shader.vertexShader).toContain('#include <worldpos_vertex>');

    // Simulate Three.js expanding the chunk. With USE_SHADOWMAP/USE_ENVMAP/etc.
    // enabled, worldpos_vertex declares its own `vec4 worldPosition`; our
    // injected code must not declare a second one (GLSL redeclaration error).
    const expanded = shader.vertexShader.replace('#include <worldpos_vertex>', ShaderChunk.worldpos_vertex);
    const declarations = expanded.match(/vec4\s+worldPosition\b/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it('finds the directional light anchor in the installed three version', () => {
    expect(ShaderChunk.lights_fragment_begin).toContain(DIRECTIONAL_LIGHT_ANCHOR);
  });

  it('injects the regolith response and sun visibility into the light loop', () => {
    const shader = compile(createMaterial());

    expect(shader.fragmentShader).not.toContain('#include <lights_fragment_begin>');
    expect(shader.fragmentShader).toContain('directLight.color *= moonRegolithResponse');
    expect(shader.fragmentShader).toContain('moonSunVisibility');
    expect(shader.fragmentShader).toContain('outgoingLight = totalDiffuse + totalEmissiveRadiance;');
    expect(shader.fragmentShader).toContain('#include <opaque_fragment>');
  });

  it('overrides the shading normal in view space', () => {
    const shader = compile(createMaterial());
    expect(shader.fragmentShader).toContain('normal = normalize(mat3(viewMatrix) * moonNormal);');
  });

  it('uses the rock variant define only for rocks', () => {
    expect(createMaterial().defines).not.toHaveProperty('MOON_ROCK');
    const rock = createMaterial({ variant: 'rock' });
    expect(rock.variant).toBe('rock');
    expect(rock.defines).toHaveProperty('MOON_ROCK');
  });

  it('uses world-space broad relief on flight terrain and keeps the atlas reference available for the lab', () => {
    const flight = createMaterial();
    expect(flight.defines).not.toHaveProperty('MOON_ATLAS_BROAD');
    expect(compile(flight).fragmentShader).toContain('moonBroadSoil(groundPos, widestPixel)');
    expect(createMaterial({ broadRelief: 'atlas' }).defines).toHaveProperty('MOON_ATLAS_BROAD');
    expect(createMaterial({ variant: 'rock', broadRelief: 'atlas' }).defines).not.toHaveProperty('MOON_ATLAS_BROAD');
  });

  it('never samples the tiled detail map periodically on the terrain', () => {
    const shader = compile(createMaterial());
    const terrain = shader.fragmentShader.split('#ifdef MOON_ROCK')[0];

    // Every terrain lookup goes through the randomised copies of moonDetail,
    // which need explicit gradients because their uv is discontinuous
    expect(shader.fragmentShader).toContain('textureGrad(uDetailMap');
    expect(shader.fragmentShader).toContain('moonDetail(groundPos * 0.3448');
    expect(shader.fragmentShader).toContain('moonMottle(groundPos, footprint)');
    expect(terrain).not.toContain('texture2D(uDetailMap');
    expect(shader.fragmentShader).not.toContain(String.fromCharCode(96));
  });

  it('defaults to the shared generated detail map', () => {
    const shader = compile(new MoonMaterial());
    expect(shader.uniforms.uDetailMap.value).toBe(getSharedRegolithDetailMap());
  });
});

describe('MoonMaterial sun shadows', () => {
  it('has no shadow uniforms until shadows are attached', () => {
    const material = createMaterial();
    const shader = compile(material);

    expect(material.defines).not.toHaveProperty('USE_SUN_SHADOWS');
    expect(shader.uniforms).not.toHaveProperty('uSunShadowMatrix');
  });

  it('attaches the shared cascade uniforms and recompiles once', () => {
    const material = createMaterial({ variant: 'rock' });
    const shadows = new SunShadows(idleRenderer, { mapSize: 256 });
    const versionBefore = material.version;

    material.setSunShadows(shadows.uniforms, 256);
    const shader = compile(material);

    expect(material.version).toBe(versionBefore + 1);
    expect(material.defines).toMatchObject({ USE_SUN_SHADOWS: '', SUN_SHADOW_MAP_SIZE: 256, MOON_ROCK: '' });
    expect(shader.uniforms.uSunShadowMatrix).toBe(shadows.uniforms.uSunShadowMatrix);
    expect(shader.uniforms.uSunShadowMap0).toBe(shadows.uniforms.uSunShadowMap0);

    shadows.dispose();
  });
});
