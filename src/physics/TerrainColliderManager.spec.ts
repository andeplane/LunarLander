import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { Vector3, Mesh, BufferGeometry, BufferAttribute } from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TerrainColliderManager } from './TerrainColliderManager';
import type { ChunkManager } from '../terrain/ChunkManager';
import type { Chunk } from '../terrain/Chunk';

const CHUNK_SIZE = 100;

/**
 * Build a fake chunk whose mesh is a (resolution+1)^2 vertex grid in
 * PlaneGeometry layout (row-major, col = X, row = Z), centered on the origin
 * like real chunk meshes.
 */
function makeChunk(
  gridKey: string,
  resolution: number,
  lodLevel: number,
  heightFn: (x: number, z: number) => number = () => 0
): Chunk {
  const vertexCount = resolution + 1;
  const positions = new Float32Array(vertexCount * vertexCount * 3);
  for (let row = 0; row < vertexCount; row++) {
    for (let col = 0; col < vertexCount; col++) {
      const i = (row * vertexCount + col) * 3;
      const x = (col / resolution - 0.5) * CHUNK_SIZE;
      const z = (row / resolution - 0.5) * CHUNK_SIZE;
      positions[i] = x;
      positions[i + 1] = heightFn(x, z);
      positions[i + 2] = z;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const mesh = new Mesh(geometry);

  return {
    gridKey,
    builtLevels: new Set([lodLevel]),
    getTerrainMesh: (level: number) => (level === lodLevel ? mesh : null),
  } as unknown as Chunk;
}

describe(TerrainColliderManager.name, () => {
  let world: RAPIER.World;
  let chunks: Map<string, Chunk>;
  let chunkManager: ChunkManager;

  beforeAll(async () => {
    await RAPIER.init();
  });

  beforeEach(() => {
    world = new RAPIER.World({ x: 0, y: -1.62, z: 0 });
    chunks = new Map();
    chunkManager = {
      getChunk: (gridKey: string) => chunks.get(gridKey),
    } as unknown as ChunkManager;
  });

  afterEach(() => {
    world.free();
  });

  function makeManager(lodLevels: number[], physicsRange = 1): TerrainColliderManager {
    return new TerrainColliderManager(
      world,
      chunkManager,
      CHUNK_SIZE,
      CHUNK_SIZE,
      lodLevels,
      { physicsRange }
    );
  }

  it('creates colliders for ready chunks within physics range', () => {
    chunks.set('0,0', makeChunk('0,0', 4, 0));
    chunks.set('1,0', makeChunk('1,0', 4, 0));
    chunks.set('5,5', makeChunk('5,5', 4, 0)); // outside range

    const manager = makeManager([4]);
    manager.update(new Vector3(0, 10, 0));

    expect(manager.getActiveColliderCount()).toBe(2);
    expect(world.bodies.len()).toBe(2);
    expect(world.colliders.len()).toBe(2);
  });

  it('skips chunks that have no built mesh yet', () => {
    const notReady = {
      gridKey: '0,0',
      builtLevels: new Set<number>(),
      getTerrainMesh: () => null,
    } as unknown as Chunk;
    chunks.set('0,0', notReady);

    const manager = makeManager([4]);
    manager.update(new Vector3(0, 10, 0));

    expect(manager.getActiveColliderCount()).toBe(0);
    expect(world.bodies.len()).toBe(0);
  });

  it('positions the heightfield at the chunk world location', () => {
    // Chunk (2,3) spans x in [150, 250], z in [250, 350]; flat at height 7
    chunks.set('2,3', makeChunk('2,3', 4, 0, () => 7));

    const manager = makeManager([4]);
    manager.update(new Vector3(2 * CHUNK_SIZE, 10, 3 * CHUNK_SIZE));
    expect(manager.getActiveColliderCount()).toBe(1);

    // Step once so the query pipeline picks up the new collider
    world.step();

    const ray = new RAPIER.Ray(
      { x: 2 * CHUNK_SIZE + 10, y: 50, z: 3 * CHUNK_SIZE - 10 },
      { x: 0, y: -1, z: 0 }
    );
    const hit = world.castRay(ray, 200, true);
    if (!hit) {
      throw new Error('expected the ray to hit the heightfield collider');
    }
    expect(50 - hit.toi).toBeCloseTo(7, 3);

    // Outside the chunk there is nothing to hit
    const missRay = new RAPIER.Ray({ x: 0, y: 50, z: 0 }, { x: 0, y: -1, z: 0 });
    expect(world.castRay(missRay, 200, true)).toBeNull();
  });

  it('does not rebuild the collider when the effective resolution is unchanged', () => {
    chunks.set('0,0', makeChunk('0,0', 4, 0));
    const manager = makeManager([4]);
    const camera = new Vector3(0, 10, 0);

    manager.update(camera);
    const colliderHandle = world.colliders.getAll()[0].handle;

    // Repeated updates must not remove/recreate (no WASM churn, no leaks)
    manager.update(camera);
    manager.update(camera);

    expect(world.colliders.len()).toBe(1);
    expect(world.bodies.len()).toBe(1);
    expect(world.colliders.getAll()[0].handle).toBe(colliderHandle);
  });

  it('rebuilds the collider when the physics source resolution changes', () => {
    // Two LOD levels with different resolutions (both below the physics cap,
    // so the effective physics resolution follows the source mesh)
    const lodLevels = [8, 4];
    const chunk = makeChunk('0,0', 4, 1); // only the coarse level built
    chunks.set('0,0', chunk);

    const manager = makeManager(lodLevels);
    const camera = new Vector3(0, 10, 0);
    manager.update(camera);
    const firstHandle = world.colliders.getAll()[0].handle;

    // The fine level finishes building: physics source switches to it.
    // selectPhysicsSourceLod picks the finest level when none meets the cap.
    const fineChunk = makeChunk('0,0', 8, 0);
    (fineChunk.builtLevels as Set<number>).add(1);
    chunks.set('0,0', fineChunk);

    manager.update(camera);

    expect(world.colliders.len()).toBe(1); // old one swapped out, not leaked
    expect(world.bodies.len()).toBe(1);
    expect(world.colliders.getAll()[0].handle).not.toBe(firstHandle);
  });

  it('removes colliders when chunks leave physics range', () => {
    chunks.set('0,0', makeChunk('0,0', 4, 0));
    const manager = makeManager([4]);

    manager.update(new Vector3(0, 10, 0));
    expect(manager.getActiveColliderCount()).toBe(1);

    // Fly far away: chunk leaves the physics window
    manager.update(new Vector3(50 * CHUNK_SIZE, 10, 0));

    expect(manager.getActiveColliderCount()).toBe(0);
    expect(world.bodies.len()).toBe(0);
    expect(world.colliders.len()).toBe(0);
  });

  it('rejects meshes whose vertex count does not match the LOD resolution', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Mesh built at resolution 4 but the manager expects resolution 8
    chunks.set('0,0', makeChunk('0,0', 4, 0));

    const manager = makeManager([8]);
    manager.update(new Vector3(0, 10, 0));

    expect(manager.getActiveColliderCount()).toBe(0);
    expect(world.bodies.len()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("doesn't match expected")
    );
    warnSpy.mockRestore();
  });

  it('rejects meshes containing non-finite heights without leaking a body', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    chunks.set('0,0', makeChunk('0,0', 4, 0, (x) => (x > 0 ? NaN : 0)));

    const manager = makeManager([4]);
    manager.update(new Vector3(0, 10, 0));

    expect(manager.getActiveColliderCount()).toBe(0);
    expect(world.bodies.len()).toBe(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('non-finite heights')
    );
    errorSpy.mockRestore();
  });

  it('dispose removes every collider and rigid body from the world', () => {
    chunks.set('0,0', makeChunk('0,0', 4, 0));
    chunks.set('1,1', makeChunk('1,1', 4, 0));
    const manager = makeManager([4]);
    manager.update(new Vector3(0, 10, 0));
    expect(world.bodies.len()).toBe(2);

    manager.dispose();

    expect(manager.getActiveColliderCount()).toBe(0);
    expect(world.bodies.len()).toBe(0);
    expect(world.colliders.len()).toBe(0);
  });
});
