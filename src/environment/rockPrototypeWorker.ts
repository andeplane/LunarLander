/**
 * Builds rock prototype meshes off the main thread.
 *
 * The near-camera meshes (up to ~46 000 triangles) take tens of
 * milliseconds each to generate, far more than an idle slice of a 60 fps
 * frame, so RockManager requests them from this worker and swaps them in
 * once they arrive. The module also runs on the main thread (encoding and
 * decoding, tests); it only registers its message handler inside an actual
 * Web Worker.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { RockBuilder } from './RockBuilder';

/** Request for one prototype. */
export interface RockPrototypeRequest {
  id: number;
  shapeId: number;
  detail: number;
}

/** The arrays of a built prototype, transferable between threads. */
export interface RockPrototypeResponse {
  id: number;
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint16Array | Uint32Array;
}

function floatArray(geometry: BufferGeometry, name: string): Float32Array {
  const array = geometry.getAttribute(name).array;
  if (!(array instanceof Float32Array)) {
    throw new Error(`Rock prototype attribute ${name} is not a Float32Array`);
  }
  // A copy owns its whole buffer, so it is safe to transfer
  return new Float32Array(array);
}

/** Flatten a prototype geometry into transferable arrays. */
export function encodeRockPrototype(id: number, geometry: BufferGeometry): RockPrototypeResponse {
  const index = geometry.getIndex()?.array;
  if (!(index instanceof Uint16Array || index instanceof Uint32Array)) {
    throw new Error('Rock prototype has no 16/32-bit index');
  }
  return {
    id,
    position: floatArray(geometry, 'position'),
    normal: floatArray(geometry, 'normal'),
    uv: floatArray(geometry, 'uv'),
    index: index instanceof Uint16Array ? new Uint16Array(index) : new Uint32Array(index),
  };
}

/** Rebuild the geometry of an encoded prototype. */
export function decodeRockPrototype(response: RockPrototypeResponse): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(response.position, 3));
  geometry.setAttribute('normal', new BufferAttribute(response.normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(response.uv, 2));
  geometry.setIndex(new BufferAttribute(response.index, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Build and encode the requested prototype. */
export function buildRockPrototype(request: RockPrototypeRequest): RockPrototypeResponse {
  return encodeRockPrototype(
    request.id,
    RockBuilder.generate(request.shapeId, { detail: request.detail })
  );
}

/** Buffers of a response, for a zero-copy postMessage. */
export function rockPrototypeTransfer(response: RockPrototypeResponse): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const array of [response.position, response.normal, response.uv, response.index]) {
    if (array.buffer instanceof ArrayBuffer) {
      buffers.push(array.buffer);
    }
  }
  return buffers;
}

/** The slice of the Worker API the client needs (tests pass a fake). */
export interface RockPrototypeWorkerLike {
  onmessage: ((event: MessageEvent<RockPrototypeResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: RockPrototypeRequest): void;
  terminate(): void;
}

/** Asynchronous prototype builder backed by a worker. */
export interface RockPrototypeWorkerClient {
  build(shapeId: number, detail: number): Promise<BufferGeometry>;
  dispose(): void;
}

/**
 * Wrap a worker in a promise-based builder. Requests are answered in order;
 * a worker error rejects every pending request.
 */
export function createRockPrototypeWorkerClient(
  worker: RockPrototypeWorkerLike
): RockPrototypeWorkerClient {
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (geometry: BufferGeometry) => void; reject: (error: Error) => void }
  >();
  worker.onmessage = (event) => {
    const entry = pending.get(event.data.id);
    if (entry) {
      pending.delete(event.data.id);
      entry.resolve(decodeRockPrototype(event.data));
    }
  };
  worker.onerror = (event) => {
    const error = new Error(`Rock prototype worker failed: ${event.message}`);
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  };
  return {
    build(shapeId: number, detail: number): Promise<BufferGeometry> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, shapeId, detail });
      });
    },
    dispose(): void {
      worker.terminate();
      const error = new Error('Rock prototype worker disposed');
      for (const entry of pending.values()) {
        entry.reject(error);
      }
      pending.clear();
    },
  };
}

// Register the message handler only inside an actual Web Worker (see
// ChunkWorker.ts for why `self` alone is not enough).
declare const WorkerGlobalScope: (new () => unknown) | undefined;
/* v8 ignore start -- only reachable inside a real worker */
if (
  typeof WorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  self.onmessage = (event: MessageEvent<RockPrototypeRequest>) => {
    const response = buildRockPrototype(event.data);
    postMessage(response, { transfer: rockPrototypeTransfer(response) });
  };
}
/* v8 ignore stop */
