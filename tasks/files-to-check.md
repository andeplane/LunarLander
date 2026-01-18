# TypeScript Files to Review

This checklist tracks progress on reviewing TypeScript source files for code quality and testing compliance.

## Root
- [x] main.ts (entry point, no tests needed)

## camera/
- [x] FlightController.ts (Three.js wrapper, DOM-dependent)

## core/
- [x] Engine.ts (Three.js wrapper, render loop)
- [x] EngineSettings.ts (constants only, no tests needed)
- [x] InputManager.ts (DOM events, no pure logic)

## environment/
- [x] CelestialSystem.ts (Three.js wrapper)
- [x] GlobalRockBatcher.ts (Three.js wrapper)
- [x] Lighting.ts (Three.js wrapper)
- [x] RockBuilder.ts (Three.js wrapper)
- [x] RockManager.ts (Three.js wrapper)
- [x] Skybox.ts (Three.js wrapper)

## shaders/
- [x] EarthMaterial.ts (Three.js ShaderMaterial)
- [x] glsl_common.ts (GLSL strings only, no JS logic)
- [x] ModifiedStandardMaterial.ts (Three.js ShaderMaterial)
- [x] MoonMaterial.ts (Three.js ShaderMaterial)
- [x] SunMaterial.ts (Three.js ShaderMaterial)
- [x] TerrainMaterial.ts (Three.js ShaderMaterial)

## terrain/
- [x] Chunk.ts (Three.js wrapper)
- [x] ChunkManager.ts (orchestration, heavy Three.js dependency)
- [x] ChunkRequestQueue.ts ✅ has tests (fixed)
- [x] ChunkWorker.ts (Web Worker, heavy Three.js dependency)
- [x] craters.ts ✅ created tests
- [x] displacements.ts (Three.js BufferGeometry manipulation)
- [x] EdgeStitcher.ts ✅ has tests
- [x] LodUtils.ts ✅ has tests
- [x] math-operators.ts ✅ created tests
- [x] noise.ts ✅ created tests
- [x] terrain.ts (terrain evaluator, uses noise/displacement)
- [x] TerrainGenerator.ts (Three.js mesh creation)

## types/
- [x] index.ts (types only, no tests needed)

## ui/
- [x] ShaderUIController.ts (DOM/UI, no pure logic)

## utils/
- [x] math.ts ✅ created tests

---

**Total files to review: 32**

**Note:** Spec files (`.spec.ts`) are excluded from this list as they are test files themselves.
