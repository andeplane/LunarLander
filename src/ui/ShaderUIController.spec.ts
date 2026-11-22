import { describe, it, expect, vi } from 'vitest';
import { createLiveMaterialParams, type MaterialParamAccess } from './ShaderUIController';
import type { MoonMaterialParams } from '../shaders/MoonMaterial';

/** Minimal in-memory stand-in for MoonMaterial's param store. */
function makeStubMaterial(initial: Partial<MoonMaterialParams>): MaterialParamAccess & {
  store: Partial<MoonMaterialParams>;
} {
  const store: Partial<MoonMaterialParams> = { ...initial };
  return {
    store,
    getParam: <K extends keyof MoonMaterialParams>(key: K) =>
      store[key] as MoonMaterialParams[K],
    setParam: <K extends keyof MoonMaterialParams>(key: K, value: MoonMaterialParams[K]) => {
      store[key] = value;
    },
  };
}

describe(createLiveMaterialParams.name, () => {
  it('reads always reflect the material, not a snapshot', () => {
    const material = makeStubMaterial({ brightnessBoost: 1.5 });
    const params = createLiveMaterialParams(material);

    expect(params.brightnessBoost).toBe(1.5);

    // External change (e.g. console setParam via window.debug)
    material.setParam('brightnessBoost', 3.0);
    expect(params.brightnessBoost).toBe(3.0);
  });

  it('writes go straight to the material and trigger onSet', () => {
    const material = makeStubMaterial({ enableCurvature: true });
    const onSet = vi.fn();
    const params = createLiveMaterialParams(material, onSet);

    params.enableCurvature = false;

    expect(material.store.enableCurvature).toBe(false);
    expect(onSet).toHaveBeenCalledTimes(1);
  });

  it('does not re-apply stale values after an external change (the GUI snap-back bug)', () => {
    const material = makeStubMaterial({ detailStrength: 6 });
    const params = createLiveMaterialParams(material);

    // GUI reads 6, then the console sets 12 behind its back
    expect(params.detailStrength).toBe(6);
    material.setParam('detailStrength', 12);

    // Touching an unrelated slider writes ITS current value; with a snapshot
    // object this would also have reverted detailStrength to 6 on next write.
    params.brightnessBoost = 2.0;

    expect(material.store.detailStrength).toBe(12);
    expect(params.detailStrength).toBe(12);
  });

  it('reports presence of defined params via the in operator', () => {
    const material = makeStubMaterial({ detailContrast: 0.5 });
    const params = createLiveMaterialParams(material);

    expect('detailContrast' in params).toBe(true);
    expect('ambientFill' in params).toBe(false);
  });
});
