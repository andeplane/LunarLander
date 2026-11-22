import { BufferAttribute, BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { RockBuilder } from './RockBuilder';
import {
  buildRockPrototype,
  createRockPrototypeWorkerClient,
  decodeRockPrototype,
  encodeRockPrototype,
  type RockPrototypeRequest,
  type RockPrototypeResponse,
  type RockPrototypeWorkerLike,
  rockPrototypeTransfer,
} from './rockPrototypeWorker';

/** ErrorEvent for node, which has Event but no ErrorEvent. */
class FakeErrorEvent extends Event implements ErrorEvent {
  readonly colno = 0;
  readonly error = null;
  readonly filename = '';
  readonly lineno = 0;
  constructor(readonly message: string) {
    super('error');
  }
}

/** A worker stand-in that answers on demand, on the same thread. */
class FakeWorker implements RockPrototypeWorkerLike {
  onmessage: ((event: MessageEvent<RockPrototypeResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly requests: RockPrototypeRequest[] = [];
  terminated = false;

  postMessage(message: RockPrototypeRequest): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer the oldest request by actually building it. */
  answer(): void {
    const request = this.requests.shift();
    if (request && this.onmessage) {
      this.onmessage(new MessageEvent('message', { data: buildRockPrototype(request) }));
    }
  }

  fail(message: string): void {
    this.onerror?.(new FakeErrorEvent(message));
  }
}

describe('rock prototype encoding', () => {
  it('round-trips a prototype through transferable arrays', () => {
    const original = RockBuilder.generate(3, { detail: 2 });
    const decoded = decodeRockPrototype(encodeRockPrototype(7, original));
    for (const name of ['position', 'normal', 'uv']) {
      expect(Array.from(decoded.getAttribute(name).array)).toEqual(
        Array.from(original.getAttribute(name).array)
      );
    }
    expect(Array.from(decoded.getIndex()?.array ?? [])).toEqual(
      Array.from(original.getIndex()?.array ?? [])
    );
    expect(decoded.boundingSphere?.radius).toBeCloseTo(original.boundingSphere?.radius ?? 0, 6);
    expect(decoded.boundingBox).not.toBeNull();
  });

  it('copies into buffers it owns, so transferring never detaches the source', () => {
    const original = RockBuilder.generate(1, { detail: 1 });
    const response = encodeRockPrototype(1, original);
    expect(response.position.buffer).not.toBe(original.getAttribute('position').array.buffer);
    const transfer = rockPrototypeTransfer(response);
    expect(transfer).toHaveLength(4);
    expect(transfer).toContain(response.index.buffer);
  });

  it('keeps 32-bit indices', () => {
    const geometry = RockBuilder.generate(0, { detail: 1 });
    const index = geometry.getIndex();
    geometry.setIndex(new BufferAttribute(new Uint32Array(index?.array ?? []), 1));
    expect(encodeRockPrototype(0, geometry).index).toBeInstanceOf(Uint32Array);
  });

  it('rejects geometries that are not prototypes', () => {
    const unindexed = new BufferGeometry();
    unindexed.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    expect(() => encodeRockPrototype(0, unindexed)).toThrow(/index/);

    const wrongType = RockBuilder.generate(0, { detail: 1 });
    wrongType.setAttribute('uv', new BufferAttribute(new Uint8Array(8), 2));
    expect(() => encodeRockPrototype(0, wrongType)).toThrow(/uv/);
  });

  it('builds exactly what RockBuilder.generate builds', () => {
    const response = buildRockPrototype({ id: 4, shapeId: 6, detail: 3 });
    expect(response.id).toBe(4);
    expect(Array.from(response.position)).toEqual(
      Array.from(RockBuilder.generate(6, { detail: 3 }).getAttribute('position').array)
    );
  });
});

describe(createRockPrototypeWorkerClient.name, () => {
  it('resolves each request with its own prototype', async () => {
    const worker = new FakeWorker();
    const client = createRockPrototypeWorkerClient(worker);
    const first = client.build(2, 1);
    const second = client.build(5, 2);
    expect(worker.requests.map((request) => request.shapeId)).toEqual([2, 5]);
    worker.answer();
    worker.answer();
    const [a, b] = await Promise.all([first, second]);
    expect(a.getAttribute('position').count).toBe(
      RockBuilder.generate(2, { detail: 1 }).getAttribute('position').count
    );
    expect(b.getAttribute('position').count).toBe(
      RockBuilder.generate(5, { detail: 2 }).getAttribute('position').count
    );
  });

  it('ignores answers to unknown requests', () => {
    const worker = new FakeWorker();
    createRockPrototypeWorkerClient(worker);
    expect(() =>
      worker.onmessage?.(
        new MessageEvent('message', { data: buildRockPrototype({ id: 99, shapeId: 0, detail: 1 }) })
      )
    ).not.toThrow();
  });

  it('rejects pending requests when the worker fails', async () => {
    const worker = new FakeWorker();
    const client = createRockPrototypeWorkerClient(worker);
    const pending = client.build(0, 1);
    worker.fail('boom');
    await expect(pending).rejects.toThrow(/boom/);
  });

  it('terminates the worker and rejects pending requests on dispose', async () => {
    const worker = new FakeWorker();
    const client = createRockPrototypeWorkerClient(worker);
    const pending = client.build(0, 1);
    client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow(/disposed/);
  });
});
