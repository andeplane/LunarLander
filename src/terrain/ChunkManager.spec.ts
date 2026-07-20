import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Vector3, Mesh, BufferGeometry, BoxGeometry, InstancedMesh, MeshBasicMaterial } from 'three';
import { ChunkManager, type ChunkConfig } from './ChunkManager';
import type { TerrainGenerator } from './TerrainGenerator';
import type { RockManager } from '../environment/RockManager';
import type { ChunkWorkerResult, RockPlacement } from './ChunkWorker';
import type { RockGenerationConfig, CraterGenerationConfig } from '../types';
import { LodDetailLevel } from './LodUtils';

/**
 * Message posted to a chunk worker (subset relevant for these tests)
 */
interface PostedMessage {
  gridKey: string;
  lodLevel: number;
  terrainArgs: { resolution: number };
}

/**
 * Fake worker that records posted messages so tests can complete builds
 * deterministically by firing onmessage.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((e: MessageEvent<ChunkWorkerResult>) => void) | null = null;
  posted: PostedMessage[] = [];
  pending: PostedMessage[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(msg: PostedMessage): void {
    this.posted.push(msg);
    this.pending.push(msg);
  }

  terminate(): void {
    // no-op
  }

  emitResult(result: ChunkWorkerResult): void {
    this.onmessage?.({ data: result } as MessageEvent<ChunkWorkerResult>);
  }
}

function makeResult(
  gridKey: string,
  lodLevel: number,
  resolution: number,
  rockPlacements: RockPlacement[] = []
): ChunkWorkerResult {
  return {
    positions: new Float32Array(9),
    normals: new Float32Array(9),
    rockPlacements,
    gridKey,
    lodLevel,
    resolution,
  };
}

describe(ChunkManager.name, () => {
  const rockConfig: RockGenerationConfig = {
    minDiameter: 0.5,
    maxDiameter: 4,
    densityConstant: 0.01,
    powerLawExponent: -2.5,
    lodMinDiameterScale: [1, 1, 1],
  };

  const craterConfig: CraterGenerationConfig = {
    seed: 1,
    density: 1,
    minRadius: 1,
    maxRadius: 10,
    powerLawExponent: -2.4,
    depthRatio: 0.2,
    rimHeight: 0.04,
    rimWidth: 0.1,
    floorFlatness: 0.3,
  };

  const sharedRockGeometry = new BoxGeometry(1, 1, 1);

  let scene: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  let terrainMeshesByKey: Map<string, Mesh>;
  let raycastHeight: ReturnType<typeof vi.fn>;
  let terrainGenerator: TerrainGenerator;
  let rockManager: RockManager;

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('window', { innerHeight: 1080 });

    scene = { add: vi.fn(), remove: vi.fn() };

    terrainMeshesByKey = new Map();
    raycastHeight = vi.fn(() => 42);

    const fakeMaterial = {
      getParam: vi.fn(() => 0),
      setParam: vi.fn(),
    };

    terrainGenerator = {
      createTerrainMesh: vi.fn((result: ChunkWorkerResult) => {
        const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
        terrainMeshesByKey.set(`${result.gridKey}:${result.lodLevel}`, mesh);
        return mesh;
      }),
      storeOriginalIndices: vi.fn(),
      applyEdgeStitching: vi.fn(),
      clearStitchingData: vi.fn(),
      raycastHeight,
      getMaterial: vi.fn(() => fakeMaterial),
      setSunDirection: vi.fn(),
      setSunHorizonFade: vi.fn(),
      dispose: vi.fn(),
    } as unknown as TerrainGenerator;

    rockManager = {
      createRockMeshes: vi.fn((placements: RockPlacement[]) =>
        placements.map(
          () => new InstancedMesh(sharedRockGeometry, new MeshBasicMaterial(), 1)
        )
      ),
      getStableAxesForDetail: vi.fn(() => undefined),
      getLibrarySize: vi.fn(() => 1),
      getMaterial: vi.fn(() => fakeMaterial),
      setSunDirection: vi.fn(),
      setSunHorizonFade: vi.fn(),
      updateCullingBounds: vi.fn(),
      dispose: vi.fn(),
    } as unknown as RockManager;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createManager(configOverrides: Partial<ChunkConfig> = {}): ChunkManager {
    const config: ChunkConfig = {
      renderDistance: 1,
      chunkWidth: 100,
      chunkDepth: 100,
      lodLevels: [64, 32],
      lodDetailLevel: LodDetailLevel.Balanced,
      workerCount: 2,
      ...configOverrides,
    };

    return new ChunkManager(
      scene as never,
      config,
      terrainGenerator,
      rockManager,
      rockConfig,
      craterConfig,
      vi.fn()
    );
  }

  /** Complete all pending worker builds (including any dispatched as a result). */
  function drainWorkers(): void {
    let progress = true;
    while (progress) {
      progress = false;
      for (const worker of FakeWorker.instances) {
        while (worker.pending.length > 0) {
          const msg = worker.pending.shift();
          if (!msg) break;
          worker.emitResult(makeResult(msg.gridKey, msg.lodLevel, msg.terrainArgs.resolution));
          progress = true;
        }
      }
    }
  }

  function allPostedKeys(): string[] {
    return FakeWorker.instances.flatMap((w) =>
      w.posted.map((msg) => `${msg.gridKey}:${msg.lodLevel}`)
    );
  }

  function handleWorkerResult(manager: ChunkManager, result: ChunkWorkerResult): void {
    (
      manager as unknown as {
        handleWorkerResult(result: ChunkWorkerResult, workerIndex: number): void;
      }
    ).handleWorkerResult(result, 0);
  }

  describe('request/dispatch lifecycle', () => {
    it('never dispatches the same chunk LOD build twice', () => {
      const manager = createManager();
      const origin = new Vector3(0, 50, 0);

      // First update queues and dispatches builds; second update runs while
      // those builds are still in flight and must not re-queue them.
      manager.update(origin);
      manager.update(origin);

      // Completing builds triggers dispatch of anything still queued
      // (including duplicates under the old behavior).
      drainWorkers();

      manager.update(origin);
      drainWorkers();

      const keys = allPostedKeys();
      expect(keys.length).toBeGreaterThan(0);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('does not dispatch queued requests whose LOD was already built', () => {
      const manager = createManager();
      const origin = new Vector3(0, 50, 0);

      manager.update(origin);

      // Complete the in-flight builds one at a time, interleaved with updates,
      // so any stale queued duplicate would get a chance to dispatch.
      let safety = 100;
      while (safety-- > 0) {
        const worker = FakeWorker.instances.find((w) => w.pending.length > 0);
        if (!worker) break;
        const msg = worker.pending.shift();
        if (!msg) continue;
        worker.emitResult(makeResult(msg.gridKey, msg.lodLevel, msg.terrainArgs.resolution));
        manager.update(origin);
      }

      const keys = allPostedKeys();
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('zombie chunks', () => {
    it('ignores worker results for chunks that were pruned while in flight', () => {
      const manager = createManager();

      manager.update(new Vector3(0, 50, 0));
      expect(manager.getChunk('0,0')).toBeDefined();

      const staleBuilds = FakeWorker.instances.flatMap((w) => w.pending.splice(0));
      expect(staleBuilds.length).toBeGreaterThan(0);

      // Move far away so the original chunks are removed
      manager.update(new Vector3(10000, 50, 0));
      expect(manager.getChunk('0,0')).toBeUndefined();
      const chunkCountAfterMove = manager.getActiveChunkCount();

      // Stale results arrive after pruning - they must not resurrect chunks
      for (const [i, msg] of staleBuilds.entries()) {
        FakeWorker.instances[i % FakeWorker.instances.length].emitResult(
          makeResult(msg.gridKey, msg.lodLevel, msg.terrainArgs.resolution)
        );
      }

      expect(manager.getChunk('0,0')).toBeUndefined();
      expect(manager.getActiveChunkCount()).toBe(chunkCountAfterMove);
    });
  });

  describe('rock meshes', () => {
    it('does not duplicate rock meshes when a LOD result is applied twice', () => {
      const manager = createManager();
      manager.update(new Vector3(0, 50, 0));

      const placements: RockPlacement[] = [
        { prototypeId: 0, matrices: new Float32Array(16) },
      ];

      handleWorkerResult(manager, makeResult('0,0', 1, 32, placements));
      handleWorkerResult(manager, makeResult('0,0', 1, 32, placements));

      const chunk = manager.getChunk('0,0');
      expect(chunk).toBeDefined();
      const rockMeshes = chunk?.getRockMeshes(1) ?? [];
      expect(rockMeshes.length).toBe(1);

      // The replaced mesh must also be gone from the rendered LOD group
      const rockChildren = chunk?.lod.children.filter((c) => c instanceof InstancedMesh) ?? [];
      expect(rockChildren.length).toBe(1);
      expect(rockChildren[0]).toBe(rockMeshes[0]);
    });

    it('disposes rock instance buffers but never the shared prototype geometry when a chunk is pruned', () => {
      const manager = createManager();
      manager.update(new Vector3(0, 50, 0));

      const placements: RockPlacement[] = [
        { prototypeId: 0, matrices: new Float32Array(16) },
      ];
      handleWorkerResult(manager, makeResult('0,0', 1, 32, placements));

      const chunk = manager.getChunk('0,0');
      const rockMesh = chunk?.getRockMeshes(1)[0];
      expect(rockMesh).toBeDefined();
      if (!rockMesh) return;

      const meshDispose = vi.spyOn(rockMesh, 'dispose');
      const geometryDispose = vi.spyOn(sharedRockGeometry, 'dispose');

      // Move far away so the chunk is pruned and disposed
      manager.update(new Vector3(10000, 50, 0));
      expect(manager.getChunk('0,0')).toBeUndefined();

      expect(meshDispose).toHaveBeenCalledTimes(1);
      expect(geometryDispose).not.toHaveBeenCalled();

      geometryDispose.mockRestore();
    });
  });

  describe('getHeightAt', () => {
    it('falls back to the finest available LOD mesh when collision LOD is missing', () => {
      // lodLevels [64, 32, 16]: collision LOD is index 1 (closest to 32)
      const manager = createManager({ lodLevels: [64, 32, 16] });
      manager.update(new Vector3(0, 50, 0));

      // Build only LODs 0 (finest) and 2 (coarsest); collision LOD 1 missing
      handleWorkerResult(manager, makeResult('0,0', 0, 64));
      handleWorkerResult(manager, makeResult('0,0', 2, 16));

      const height = manager.getHeightAt(0, 0);

      expect(height).toBe(42);
      expect(raycastHeight).toHaveBeenCalledTimes(1);
      expect(raycastHeight).toHaveBeenCalledWith(0, 0, terrainMeshesByKey.get('0,0:0'));
    });

    it('uses the collision LOD mesh when available', () => {
      const manager = createManager({ lodLevels: [64, 32, 16] });
      manager.update(new Vector3(0, 50, 0));

      handleWorkerResult(manager, makeResult('0,0', 0, 64));
      handleWorkerResult(manager, makeResult('0,0', 1, 32));

      manager.getHeightAt(0, 0);

      expect(raycastHeight).toHaveBeenCalledWith(0, 0, terrainMeshesByKey.get('0,0:1'));
    });
  });
});
