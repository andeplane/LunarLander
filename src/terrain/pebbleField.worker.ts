import { PebbleField, type PebbleRequest } from './pebbleField';

let field: PebbleField;
self.onmessage = ({ data }: MessageEvent<PebbleRequest>) => {
  if (data.stamps) field = new PebbleField(data.stamps);
  const result = field.window(data.view);
  const buffers = [result.stones.buffer];
  for (const mesh of result.shapes ?? [])
    buffers.push(mesh.position.buffer, mesh.normal.buffer, mesh.index.buffer);
  self.postMessage(result, { transfer: buffers as ArrayBuffer[] });
};
