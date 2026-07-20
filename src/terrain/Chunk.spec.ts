import { describe, it, expect, vi } from 'vitest';
import {
  BoxGeometry,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from 'three';
import { Chunk } from './Chunk';

function makeTerrainMesh(material: MeshBasicMaterial | MeshStandardMaterial = new MeshStandardMaterial()): Mesh {
  return new Mesh(new BoxGeometry(1, 1, 1), material);
}

describe(Chunk.name, () => {
  describe('addTerrainMesh', () => {
    it('does not leak LOD.levels entries when a mesh at the same level is rebuilt', () => {
      const chunk = new Chunk('0,0', 0, 0, 3);

      const first = makeTerrainMesh();
      const second = makeTerrainMesh();

      chunk.addTerrainMesh(first, 1, 100);
      chunk.addTerrainMesh(second, 1, 100);

      expect(chunk.lod.levels.length).toBe(1);
      expect(chunk.lod.levels[0].object).toBe(second);
      expect(chunk.lod.children).not.toContain(first);
    });

    it('disposes replaced terrain geometry and per-chunk debug materials, but not shared materials', () => {
      const chunk = new Chunk('0,0', 0, 0, 3);

      const debugMaterial = new MeshBasicMaterial({ wireframe: true });
      const first = makeTerrainMesh(debugMaterial);
      const geometryDispose = vi.spyOn(first.geometry, 'dispose');
      const debugMaterialDispose = vi.spyOn(debugMaterial, 'dispose');

      chunk.addTerrainMesh(first, 0, 0);
      chunk.addTerrainMesh(makeTerrainMesh(), 0, 0);

      expect(geometryDispose).toHaveBeenCalledTimes(1);
      expect(debugMaterialDispose).toHaveBeenCalledTimes(1);

      // Shared (non-debug) material must never be disposed on replacement
      const shared = new MeshStandardMaterial();
      const third = makeTerrainMesh(shared);
      const sharedDispose = vi.spyOn(shared, 'dispose');
      chunk.addTerrainMesh(third, 0, 0);
      chunk.addTerrainMesh(makeTerrainMesh(), 0, 0);
      expect(sharedDispose).not.toHaveBeenCalled();
    });
  });

  describe('clearRockMeshes', () => {
    it('disposes instance meshes and debug materials but leaves shared geometry untouched', () => {
      const chunk = new Chunk('0,0', 0, 0, 2);

      const sharedGeometry = new BoxGeometry(1, 1, 1);
      const debugMaterial = new MeshBasicMaterial({ wireframe: true });
      const mesh = new InstancedMesh(sharedGeometry, debugMaterial, 2);

      const meshDispose = vi.spyOn(mesh, 'dispose');
      const geometryDispose = vi.spyOn(sharedGeometry, 'dispose');
      const materialDispose = vi.spyOn(debugMaterial, 'dispose');

      chunk.addRockMesh(mesh, 0);
      chunk.clearRockMeshes(0);

      expect(meshDispose).toHaveBeenCalledTimes(1);
      expect(materialDispose).toHaveBeenCalledTimes(1);
      expect(geometryDispose).not.toHaveBeenCalled();
      expect(chunk.getRockMeshes(0)).toHaveLength(0);
      expect(chunk.lod.children).not.toContain(mesh);
    });
  });

  describe('dispose', () => {
    it('disposes rock instance buffers but never the shared prototype geometry', () => {
      const chunk = new Chunk('0,0', 0, 0, 2);

      const sharedGeometry = new BoxGeometry(1, 1, 1);
      const sharedMaterial = new MeshStandardMaterial();
      const rockA = new InstancedMesh(sharedGeometry, sharedMaterial, 3);
      const rockB = new InstancedMesh(sharedGeometry, sharedMaterial, 5);

      const disposeA = vi.spyOn(rockA, 'dispose');
      const disposeB = vi.spyOn(rockB, 'dispose');
      const geometryDispose = vi.spyOn(sharedGeometry, 'dispose');
      const materialDispose = vi.spyOn(sharedMaterial, 'dispose');

      chunk.addRockMesh(rockA, 0);
      chunk.addRockMesh(rockB, 1);
      chunk.dispose();

      expect(disposeA).toHaveBeenCalledTimes(1);
      expect(disposeB).toHaveBeenCalledTimes(1);
      expect(geometryDispose).not.toHaveBeenCalled();
      expect(materialDispose).not.toHaveBeenCalled();
    });

    it('disposes terrain geometry and per-chunk debug materials and empties LOD levels', () => {
      const chunk = new Chunk('0,0', 0, 0, 2);

      const debugMaterial = new MeshBasicMaterial({ wireframe: true });
      const terrain = makeTerrainMesh(debugMaterial);
      const geometryDispose = vi.spyOn(terrain.geometry, 'dispose');
      const materialDispose = vi.spyOn(debugMaterial, 'dispose');

      chunk.addTerrainMesh(terrain, 0, 0);
      chunk.dispose();

      expect(geometryDispose).toHaveBeenCalledTimes(1);
      expect(materialDispose).toHaveBeenCalledTimes(1);
      expect(chunk.lod.levels.length).toBe(0);
    });
  });
});
