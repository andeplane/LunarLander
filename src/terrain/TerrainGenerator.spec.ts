import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Mesh, BufferGeometry, BufferAttribute, MeshBasicMaterial, Object3D, type Sphere, Vector3 } from 'three';
import { TerrainGenerator } from './TerrainGenerator';
import { generateGridIndices, clearStitchCache } from './EdgeStitcher';
import type { NeighborLods } from './LodUtils';

describe(`${TerrainGenerator.name}.applyEdgeStitching`, () => {
  const gridKey = '0,0';
  const lodLevels = [4, 2, 1];
  const resolution = 4;

  let generator: TerrainGenerator;
  let originalIndices: Uint32Array;
  let mesh: Mesh;
  let setIndexSpy: ReturnType<typeof vi.spyOn>;

  function lods(overrides: Partial<NeighborLods> = {}, base = 0): NeighborLods {
    return { north: base, south: base, east: base, west: base, ...overrides };
  }

  beforeEach(() => {
    clearStitchCache();

    generator = new TerrainGenerator({
      chunkWidth: 100,
      chunkDepth: 100,
      renderDistance: 1,
      planetRadius: 1_000_000,
    });

    // Mimic what createTerrainMesh + storeOriginalIndices do for a new chunk:
    // the mesh starts out with its original (unstitched) grid indices.
    originalIndices = generateGridIndices(resolution);
    const geometry = new BufferGeometry();
    geometry.setIndex(new BufferAttribute(originalIndices.slice(), 1));
    mesh = new Mesh(geometry, new MeshBasicMaterial());
    generator.storeOriginalIndices(gridKey, 0, originalIndices);

    setIndexSpy = vi.spyOn(mesh.geometry, 'setIndex');
  });

  it('does not touch the index buffer when no stitching is needed', () => {
    const before = mesh.geometry.index;

    generator.applyEdgeStitching(gridKey, mesh, 0, lods(), lodLevels);
    generator.applyEdgeStitching(gridKey, mesh, 0, lods(), lodLevels);

    expect(setIndexSpy).not.toHaveBeenCalled();
    expect(mesh.geometry.index).toBe(before);
  });

  it('applies stitched indices once and skips re-upload while the signature is unchanged', () => {
    const neighborLods = lods({ north: 1 });

    generator.applyEdgeStitching(gridKey, mesh, 0, neighborLods, lodLevels);
    expect(setIndexSpy).toHaveBeenCalledTimes(1);

    const stitchedAttribute = mesh.geometry.index;
    expect(stitchedAttribute).not.toBeNull();

    // Same configuration on subsequent frames must be a no-op
    generator.applyEdgeStitching(gridKey, mesh, 0, neighborLods, lodLevels);
    generator.applyEdgeStitching(gridKey, mesh, 0, { ...neighborLods }, lodLevels);

    expect(setIndexSpy).toHaveBeenCalledTimes(1);
    expect(mesh.geometry.index).toBe(stitchedAttribute);
  });

  it('rebuilds indices when the neighbor-LOD signature changes', () => {
    generator.applyEdgeStitching(gridKey, mesh, 0, lods({ north: 1 }), lodLevels);
    const firstAttribute = mesh.geometry.index;

    generator.applyEdgeStitching(gridKey, mesh, 0, lods({ north: 2 }), lodLevels);

    expect(setIndexSpy).toHaveBeenCalledTimes(2);
    expect(mesh.geometry.index).not.toBe(firstAttribute);
  });

  it('restores original indices exactly once when stitching is no longer needed', () => {
    generator.applyEdgeStitching(gridKey, mesh, 0, lods({ north: 1 }), lodLevels);
    expect(setIndexSpy).toHaveBeenCalledTimes(1);

    // Neighbor caught up - restore originals (one upload)
    generator.applyEdgeStitching(gridKey, mesh, 0, lods(), lodLevels);
    expect(setIndexSpy).toHaveBeenCalledTimes(2);
    expect(mesh.geometry.index?.array).toEqual(originalIndices);

    // Further frames with the same configuration must not re-upload
    generator.applyEdgeStitching(gridKey, mesh, 0, lods(), lodLevels);
    expect(setIndexSpy).toHaveBeenCalledTimes(2);
  });

  it('treats finer neighbors like same-LOD neighbors (no spurious rebuilds)', () => {
    const geometry = new BufferGeometry();
    geometry.setIndex(new BufferAttribute(generateGridIndices(2), 1));
    const coarseMesh = new Mesh(geometry, new MeshBasicMaterial());
    const coarseSpy = vi.spyOn(coarseMesh.geometry, 'setIndex');
    generator.storeOriginalIndices(gridKey, 1, generateGridIndices(2));

    // Chunk at LOD 1 with neighbors at the same LOD, then at a finer LOD.
    // Neither needs stitching, so neither should touch the index buffer.
    generator.applyEdgeStitching(gridKey, coarseMesh, 1, lods({}, 1), lodLevels);
    generator.applyEdgeStitching(gridKey, coarseMesh, 1, lods({}, 0), lodLevels);

    expect(coarseSpy).not.toHaveBeenCalled();
  });

  it('re-applies stitching to a replacement mesh with no stitch history', () => {
    const neighborLods = lods({ east: 1 });
    generator.applyEdgeStitching(gridKey, mesh, 0, neighborLods, lodLevels);
    expect(setIndexSpy).toHaveBeenCalledTimes(1);

    // A rebuilt chunk mesh starts fresh (no userData.stitchKey), so stitching
    // must be applied to it even though the configuration did not change.
    const replacementGeometry = new BufferGeometry();
    replacementGeometry.setIndex(new BufferAttribute(originalIndices.slice(), 1));
    const replacementMesh = new Mesh(replacementGeometry, new MeshBasicMaterial());
    const replacementSpy = vi.spyOn(replacementMesh.geometry, 'setIndex');

    generator.applyEdgeStitching(gridKey, replacementMesh, 0, neighborLods, lodLevels);
    expect(replacementSpy).toHaveBeenCalledTimes(1);
  });
});

describe(`${TerrainGenerator.name}.updateCullingBounds`, () => {
  const planetRadius = 5000;
  const chunkWidth = 400;

  function makeGenerator(): TerrainGenerator {
    return new TerrainGenerator({
      chunkWidth,
      chunkDepth: chunkWidth,
      renderDistance: 10,
      planetRadius,
    });
  }

  /** A flat 400 m quad centred on the chunk origin, as the worker would emit. */
  function makeMesh(generator: TerrainGenerator): Mesh {
    const h = chunkWidth / 2;
    const positions = new Float32Array([-h, 0, -h, h, 0, -h, h, 0, h, -h, 0, h]);
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const index = new Uint32Array([0, 1, 2, 0, 2, 3]);
    return generator.createTerrainMesh(
      { positions, normals, index, rockPlacements: [], gridKey: '3,0', lodLevel: 0, resolution: 1 },
      false,
      '3,0'
    );
  }

  it('starts with the conservative lifetime bound and remembers the base sphere', () => {
    const generator = makeGenerator();
    const mesh = makeMesh(generator);
    const base = mesh.userData.baseBoundingSphere as Sphere;
    const sphere = mesh.geometry.boundingSphere as Sphere;

    expect(base.radius).toBeCloseTo((Math.SQRT2 * chunkWidth) / 2, 3);
    // Lifetime bound at render distance 10 inflates by roughly a kilometre
    expect(sphere.radius).toBeGreaterThan(1000);
  });

  it('tightens the sphere to nearly the base sphere when the camera is over the chunk', () => {
    const generator = makeGenerator();
    const mesh = makeMesh(generator);
    const parent = new Object3D();
    parent.position.set(3 * chunkWidth, 0, 0);
    parent.add(mesh);
    const base = mesh.userData.baseBoundingSphere as Sphere;
    const sphere = mesh.geometry.boundingSphere as Sphere;

    generator.updateCullingBounds(mesh, new Vector3(3 * chunkWidth, 50, 0));

    // Max drop inside the chunk is r²/(2R) = 283²/10000 ≈ 8 m
    expect(sphere.radius).toBeLessThan(base.radius + 10);
    expect(sphere.radius).toBeGreaterThanOrEqual(base.radius);
  });

  it('still contains the dropped geometry when the camera is far away', () => {
    const generator = makeGenerator();
    const mesh = makeMesh(generator);
    const parent = new Object3D();
    parent.position.set(3 * chunkWidth, 0, 0);
    parent.add(mesh);
    const base = mesh.userData.baseBoundingSphere as Sphere;
    const sphere = mesh.geometry.boundingSphere as Sphere;

    const cameraX = 3 * chunkWidth + 3000;
    generator.updateCullingBounds(mesh, new Vector3(cameraX, 50, 0));

    // Farthest and nearest points of the chunk from the camera (XZ)
    for (const dist of [3000 - base.radius, 3000 + base.radius]) {
      const drop = (dist * dist) / (2 * planetRadius);
      const localX = cameraX - dist - parent.position.x;
      const dropped = new Vector3(localX, -drop, 0);
      expect(sphere.containsPoint(dropped)).toBe(true);
    }
    // ...but is far tighter than the lifetime bound
    expect(sphere.radius).toBeLessThan(1000);
  });

  it('restores the exact base sphere when curvature is disabled', () => {
    const generator = makeGenerator();
    const mesh = makeMesh(generator);
    const base = mesh.userData.baseBoundingSphere as Sphere;
    const sphere = mesh.geometry.boundingSphere as Sphere;

    generator.getMaterial().setParam('enableCurvature', false);
    generator.updateCullingBounds(mesh, new Vector3(5000, 50, 0));

    expect(sphere.radius).toBeCloseTo(base.radius, 6);
    expect(sphere.center.distanceTo(base.center)).toBeCloseTo(0, 6);
  });
});
