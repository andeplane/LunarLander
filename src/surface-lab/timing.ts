import { type WebGLRenderer, WebGLRenderTarget } from 'three';

const SIZE = 512;
const SAMPLES = 7;
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Times two warmed materials on the same fixed-size target and camera. */
export async function timeMaterials(
  renderer: WebGLRenderer,
  render: (candidate: boolean) => void,
  signal: AbortSignal
) {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const isSoftware =
    info &&
    /swiftshader|llvmpipe|softpipe|software/i.test(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  const target = new WebGLRenderTarget(SIZE, SIZE);
  const pixel = new Uint8Array(4);
  function draw(candidate: boolean, readBack: boolean) {
    renderer.setRenderTarget(target);
    try {
      render(candidate);
      if (readBack) renderer.readRenderTargetPixels(target, SIZE / 2, SIZE / 2, 1, 1, pixel);
    } finally {
      renderer.setRenderTarget(null);
    }
  }
  async function sample(candidate: boolean) {
    await frame();
    signal.throwIfAborted();
    if (gl.isContextLost()) throw new Error('WebGL context lost. Reload the lab to try again.');
    if (!timer) {
      const start = performance.now();
      draw(candidate, true);
      return performance.now() - start;
    }
    const query = gl.createQuery();
    if (!query) throw new Error('The GPU timer is unavailable.');
    try {
      gl.beginQuery(timer.TIME_ELAPSED_EXT, query);
      try {
        draw(candidate, false);
      } finally {
        gl.endQuery(timer.TIME_ELAPSED_EXT);
      }
      gl.flush();
      const start = performance.now();
      do {
        await frame();
        signal.throwIfAborted();
        if (gl.getParameter(timer.GPU_DISJOINT_EXT) || gl.isContextLost()) {
          throw new Error('GPU timing was interrupted. Run the comparison again.');
        }
        if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
          return Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
        }
      } while (performance.now() - start < 4000);
      throw new Error('The GPU timer timed out. Run the comparison again.');
    } finally {
      gl.deleteQuery(query);
    }
  }
  try {
    // Finish the warm-up, including shader compilation, before collecting times.
    draw(false, true);
    draw(true, true);
    if (timer) gl.getParameter(timer.GPU_DISJOINT_EXT);
    const times: [number[], number[]] = [[], []];
    for (let i = 0; i < SAMPLES; i++) {
      for (const index of i % 2 === 0 ? [0, 1] : [1, 0]) {
        times[index].push(await sample(index === 1));
      }
    }
    const median = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(SAMPLES / 2)];
    return {
      reference: median(times[0]),
      candidate: median(times[1]),
      method: timer ? (isSoftware ? 'Software renderer timer' : 'GPU timer') : 'Draw + readback',
    };
  } finally {
    target.dispose();
  }
}
