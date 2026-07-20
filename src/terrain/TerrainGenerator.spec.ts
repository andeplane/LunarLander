import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Mesh, BufferGeometry, BufferAttribute, MeshBasicMaterial } from 'three';
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
