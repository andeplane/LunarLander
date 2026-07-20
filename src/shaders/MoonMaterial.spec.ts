import { describe, it, expect } from 'vitest';
import { ShaderChunk } from 'three';
import { MoonMaterial } from './MoonMaterial';

interface FakeShader {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
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
    fragmentShader: '#include <color_fragment>\n#include <opaque_fragment>',
  };
  const onBeforeCompile = material.onBeforeCompile as unknown as (
    shader: FakeShader,
    renderer: unknown
  ) => void;
  onBeforeCompile(shader, undefined);
  return shader;
}

describe('MoonMaterial param handling', () => {
  it('allows numeric params to be set to 0 after compile (?? instead of ||)', () => {
    const material = new MoonMaterial();
    const shader = compile(material);

    material.setParam('hexPatchScale', 0); // documented debug bypass
    material.setParam('specularStrength', 0);
    material.setParam('fresnelRimStrength', 0);
    material.setParam('microDetailStrength', 0);
    material.setParam('fresnelRimColor', [0, 0, 0]);

    expect(shader.uniforms.uHexPatchScale.value).toBe(0);
    expect(shader.uniforms.uSpecularStrength.value).toBe(0);
    expect(shader.uniforms.uFresnelRimStrength.value).toBe(0);
    expect(shader.uniforms.uMicroDetailStrength.value).toBe(0);
    const rim = shader.uniforms.uFresnelRimColor.value as { x: number; y: number; z: number };
    expect([rim.x, rim.y, rim.z]).toEqual([0, 0, 0]);
  });

  it('initializes uniforms from params set to 0 before compile', () => {
    const material = new MoonMaterial();
    material.setParam('hexPatchScale', 0);
    material.setParam('specularPower', 0);

    const shader = compile(material);

    expect(shader.uniforms.uHexPatchScale.value).toBe(0);
    expect(shader.uniforms.uSpecularPower.value).toBe(0);
  });

  it('falls back to defaults only for undefined params', () => {
    const material = new MoonMaterial();
    const shader = compile(material);

    material.setParam('hexPatchScale', undefined);
    expect(shader.uniforms.uHexPatchScale.value).toBe(6.0);
  });

  it('does not trigger a shader recompile when uniform values change', () => {
    const material = new MoonMaterial();
    compile(material);

    const versionBefore = material.version;
    material.setParam('hexPatchScale', 3.0);
    material.setParams({ specularStrength: 0.5, enableSpecular: false });

    // needsUpdate = true would bump material.version, forcing getProgram to re-run
    expect(material.version).toBe(versionBefore);
    expect(material.getParam('hexPatchScale')).toBe(3.0);
    expect(material.getParam('specularStrength')).toBe(0.5);
  });

  it('setParam is a no-op when the value is unchanged', () => {
    const material = new MoonMaterial();
    const shader = compile(material);

    // Poison the uniform: if updateUniforms ran, it would overwrite this
    shader.uniforms.uHexPatchScale.value = -1;
    material.setParam('hexPatchScale', material.getParam('hexPatchScale'));
    expect(shader.uniforms.uHexPatchScale.value).toBe(-1);

    // A real change refreshes the uniform
    material.setParam('hexPatchScale', 2.0);
    expect(shader.uniforms.uHexPatchScale.value).toBe(2.0);
  });

  it('setParams is a no-op when no value changed', () => {
    const material = new MoonMaterial();
    const shader = compile(material);

    shader.uniforms.uSpecularPower.value = -1;
    material.setParams({
      specularPower: material.getParam('specularPower'),
      enableSpecular: material.getParam('enableSpecular'),
    });
    expect(shader.uniforms.uSpecularPower.value).toBe(-1);
  });

  it('does not redeclare worldPosition when worldpos_vertex expands (shadows/envmap)', () => {
    const material = new MoonMaterial();
    const shader = compile(material);

    // The <worldpos_vertex> include must survive so Three.js can expand it
    expect(shader.vertexShader).toContain('#include <worldpos_vertex>');

    // Simulate Three.js expanding the chunk. With USE_SHADOWMAP/USE_ENVMAP/etc.
    // enabled, worldpos_vertex declares its own `vec4 worldPosition`; our
    // injected code must not declare a second one (GLSL redeclaration error).
    const expanded = shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      ShaderChunk.worldpos_vertex
    );
    const declarations = expanded.match(/vec4\s+worldPosition\b/g) ?? [];
    expect(declarations).toHaveLength(1);
  });

  it('does not create the removed texture-LOD uniforms', () => {
    const material = new MoonMaterial();
    const shader = compile(material);

    expect(shader.uniforms).not.toHaveProperty('uTextureLowDetail');
    expect(shader.uniforms).not.toHaveProperty('uTextureLodDistance');
    expect(shader.uniforms).not.toHaveProperty('uTextureUvScale');
    expect(shader.fragmentShader).not.toContain('uTextureLowDetail');
    expect(shader.fragmentShader).not.toContain('uTextureLodDistance');
    expect(shader.fragmentShader).not.toContain('uTextureUvScale');
  });
});
