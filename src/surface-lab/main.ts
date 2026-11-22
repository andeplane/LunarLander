import { createSurfaceScene } from './scene';
import { distanceLabel, type LabView, readView, viewHash } from './view';

function element<T extends HTMLElement>(id: string) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing surface lab element ${id}`);
  return node as T;
}

const view = readView(location.hash);
const stage = element('stage');
const canvas = element<HTMLCanvasElement>('ground');
const status = element('stage-status');
const height = element<HTMLInputElement>('height');
const sun = element<HTMLInputElement>('sun');
const relief = element<HTMLInputElement>('relief');
const angle = element<HTMLSelectElement>('angle');
const channel = element<HTMLSelectElement>('channel');
const variant = element<HTMLSelectElement>('variant');
const measure = element<HTMLButtonElement>('measure');
const timing = element('timing');
const copy = element<HTMLButtonElement>('copy');
const modeButtons = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
const presets = document.querySelectorAll<HTMLButtonElement>('[data-height]');
let scene: Awaited<ReturnType<typeof createSurfaceScene>> | undefined;
let saveTimer: number;
let copyTimer: number;

function saveView() {
  clearTimeout(saveTimer);
  history.replaceState(null, '', `#${viewHash(view)}`);
}

function syncControls() {
  stage.dataset.mode = view.mode;
  variant.value = view.variant;
  element('solo-label').textContent = view.variant === 'hybrid' ? 'Hybrid' : 'Procedural';
  element('candidate-label').textContent =
    view.variant === 'hybrid' ? 'Hybrid grain' : 'World-space procedural';
  for (const button of modeButtons) button.checked = button.value === view.mode;
  for (const button of presets) {
    button.setAttribute(
      'aria-pressed',
      String(Math.abs(Number(button.dataset.height) - view.height) < 0.001)
    );
  }
  height.value = String(Math.log2(view.height));
  height.setAttribute('aria-valuetext', distanceLabel(view.height));
  element('height-value').textContent = distanceLabel(view.height);
  element('position').textContent = `X ${view.x.toFixed(2)} m   Z ${view.z.toFixed(2)} m`;
  element('sun-value').textContent = `${view.sun}°`;
  element('relief-value').textContent = `${view.relief.toFixed(2)}×`;
  sun.value = String(view.sun);
  relief.value = String(view.relief);
  relief.disabled = view.mode === 'game';
  angle.value = view.angle;
  channel.value = view.channel;
}

function changed(moveCamera = false) {
  scene?.cancelTiming();
  timing.textContent = 'Median of 7 draws each at 512 × 512.';
  if (moveCamera) scene?.updateCamera();
  else scene?.invalidate();
  syncControls();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveView, 180);
}

for (const button of modeButtons)
  button.addEventListener('change', () => {
    view.mode = button.value as LabView['mode'];
    changed();
  });
for (const button of presets)
  button.addEventListener('click', () => {
    view.height = Number(button.dataset.height);
    changed(true);
  });
height.addEventListener('input', () => {
  view.height = 2 ** Number(height.value);
  changed(true);
});
sun.addEventListener('input', () => {
  view.sun = Number(sun.value);
  changed();
});
relief.addEventListener('input', () => {
  view.relief = Number(relief.value);
  changed();
});
angle.addEventListener('change', () => {
  view.angle = angle.value as LabView['angle'];
  changed(true);
});
variant.addEventListener('change', () => {
  view.variant = variant.value as LabView['variant'];
  if (view.mode === 'game') view.mode = 'compare';
  changed();
});
channel.addEventListener('change', () => {
  view.channel = channel.value as LabView['channel'];
  changed();
});
window.addEventListener('hashchange', () => {
  Object.assign(view, readView(location.hash));
  changed(true);
});

copy.addEventListener('click', async () => {
  saveView();
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(location.href);
    copy.textContent = 'Link copied';
  } catch {
    copy.textContent = 'Copy the address bar';
  }
  copyTimer = window.setTimeout(() => {
    copy.textContent = 'Copy view link';
  }, 2400);
});
measure.addEventListener('click', async () => {
  if (!scene) return;
  measure.disabled = true;
  timing.textContent = 'Timing both materials…';
  try {
    const result = await scene.measure();
    timing.textContent = `Game ${result.game.toFixed(2)} ms · ${view.variant === 'hybrid' ? 'Hybrid' : 'Procedural'} ${result.procedural.toFixed(2)} ms. ${result.method}, median at 512 × 512.`;
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      timing.textContent = error instanceof Error ? error.message : 'Timing unavailable.';
    }
  } finally {
    measure.disabled = false;
  }
});

syncControls();
createSurfaceScene(
  canvas,
  view,
  () => changed(),
  ({ metres, pixels }) => {
    element('scale-label').textContent = distanceLabel(metres);
    element('scale').style.width = `${pixels + 14}px`;
  }
)
  .then((ready) => {
    scene = ready;
    measure.disabled = false;
    status.hidden = true;
    canvas.addEventListener('webglcontextlost', () => {
      scene?.cancelTiming();
      measure.disabled = true;
      status.hidden = false;
      status.textContent = 'WebGL context lost. Reload to restore the surface.';
    });
  })
  .catch((error: unknown) => {
    status.textContent = `Surface lab could not start. ${error instanceof Error ? error.message : 'Check WebGL 2 support and reload.'}`;
  });
