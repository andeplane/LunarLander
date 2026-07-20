import { describe, it, expect } from 'vitest';
import { ShaderChunk } from 'three';
import { CurvedStandardMaterial } from './CurvedStandardMaterial';

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
function compile(material: CurvedStandardMaterial): FakeShader {
  const shader: FakeShader = {
    uniforms: {},
    vertexShader: '#include <project_vertex>\n#include <worldpos_vertex>',
    fragmentShader: '#include <opaque_fragment>',
  };
  const onBeforeCompile = material.onBeforeCompile as unknown as (
    shader: FakeShader,
    renderer: unknown
  ) => void;
  onBeforeCompile(shader, undefined);
  return shader;
}

describe('CurvedStandardMaterial shader injection', () => {
  it('does not redeclare worldPosition when worldpos_vertex expands (shadows/envmap)', () => {
    const material = new CurvedStandardMaterial();
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

  it('supports instancing in the curvature projection code', () => {
    const material = new CurvedStandardMaterial();
    const shader = compile(material);

    expect(shader.vertexShader).toContain('#ifdef USE_INSTANCING');
    expect(shader.vertexShader).toContain('instanceMatrix');
  });
});
