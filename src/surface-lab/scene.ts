import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  MathUtils,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { SunShadows } from '../rendering/SunShadows';
import { PebbleSurface } from '../terrain/PebbleSurface';
import { createLabMaterials } from './materials';
import { TIMING_SIZE, timeMaterials } from './timing';
import { CHANNELS, type LabView, MAX_ALTITUDE, MIN_ALTITUDE, scaleBar } from './view';

export async function createSurfaceScene(
  canvas: HTMLCanvasElement,
  view: LabView,
  onNavigate: () => void,
  onScale: (scale: ReturnType<typeof scaleBar>) => void
) {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.toneMapping = ACESFilmicToneMapping;
  const materials = await createLabMaterials(renderer.capabilities.getMaxAnisotropy());
  const scene = new Scene();
  const shadows = new SunShadows(renderer, {
    mapSize: 1024,
    baseHalfExtent: 10,
    relief: [2, 4, 12],
    terrainRefreshFrames: [1, 1, 1],
  });
  materials.flight.setSunShadows(shadows.uniforms, shadows.options.mapSize);
  let shadowRevision = 0;
  const pebbles = new PebbleSurface(
    materials.flight,
    (_x, _z, out, i) => {
      out[i] = 0;
      out[i + 1] = 1;
      out[i + 2] = 0;
      out[i + 3] = 0;
      return true;
    },
    invalidate
  );
  scene.add(pebbles.root);
  let patchReady = false;
  const camera = new PerspectiveCamera(46, 1, 0.015, 50000);
  const surface = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), materials.reference);
  const sun = new DirectionalLight(0xffffff, 3.4);
  const sunDirection = materials.sunDirection.value;
  scene.add(surface, sun, new AmbientLight(0xffffff, 0.08));
  const controls = new MapControls(camera, canvas);
  controls.enableRotate = false;
  controls.screenSpacePanning = false;
  controls.mouseButtons.RIGHT = controls.mouseButtons.LEFT;
  controls.listenToKeyEvents(canvas);
  let applyingView = false;
  let pendingFrame = 0;
  let materialTiming: AbortController | undefined;

  function candidateMaterial() {
    return view.variant === 'flight' || view.variant === 'pebbles'
      ? materials.flight
      : materials.procedural;
  }

  function selectMaterial(showCandidate: boolean) {
    surface.material = showCandidate
      ? candidateMaterial()
      : view.variant === 'pebbles'
        ? materials.shadedFlight
        : materials.reference;
    pebbles.root.visible = patchReady && showCandidate && surface.material === materials.flight;
  }

  function preparePebbles(viewCamera: PerspectiveCamera, viewportHeight: number) {
    if (
      pebbles.update(
        viewCamera.position,
        viewCamera.position.y,
        0,
        candidateMaterial() === materials.flight,
        viewCamera,
        viewportHeight,
        0,
        0
      )
    )
      shadowRevision++;
    patchReady = pebbles.root.visible;
    const shadowState = {
      cameraPosition: viewCamera.position,
      groundHeight: 0,
      sunDirection,
      sunVisible: true,
      terrainRevision: 0,
      nearCasterRevision: shadowRevision,
      planetRadius: null,
    };
    // The lab renders on demand. Initialise all three depth samplers in the same frame.
    for (let i = 0; i < 3 && shadows.plan(shadowState); i++) shadows.renderPending(scene);
  }

  function render() {
    pendingFrame = 0;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr))
      renderer.setSize(w, h, false);
    const elevation = MathUtils.degToRad(view.sun);
    sunDirection.set(-0.8 * Math.cos(elevation), Math.sin(elevation), -0.6 * Math.cos(elevation));
    sun.position.copy(sunDirection);
    materials.channel.value = CHANNELS.indexOf(view.channel);
    materials.relief.value = view.relief;
    materials.flight.setParam('detailStrength', view.variant === 'pebbles' ? 1 : view.relief);
    materials.flight.setParam('pebbleHeight', view.variant === 'pebbles' ? view.relief : 1);
    camera.aspect = (view.mode === 'compare' ? w / 2 : w) / h;
    camera.updateProjectionMatrix();
    preparePebbles(camera, canvas.height);
    materials.hybrid.value = view.variant === 'hybrid';
    // A moving piece of flat geometry covers the frustum. The shader samples
    // its world position, so dragging or resizing the plane cannot move a grain.
    const extent =
      Math.max(view.angle === 'grazing' ? 120 : 0, view.height * 24) * Math.max(1, w / h);
    surface.scale.set(extent, 1, extent);
    surface.position.copy(controls.target);
    function draw(x: number, width: number, showCandidate: boolean) {
      camera.aspect = width / h;
      camera.updateProjectionMatrix();
      renderer.setViewport(x, 0, width, h);
      renderer.setScissor(x, 0, width, h);
      selectMaterial(showCandidate);
      renderer.render(scene, camera);
    }
    renderer.setScissorTest(true);
    const split = Math.floor(w / 2);
    if (view.mode === 'compare') {
      draw(0, split, false);
      draw(split, w - split, true);
    } else {
      draw(0, w, view.mode === 'candidate');
    }
    const metresPerPixel =
      (2 *
        camera.position.distanceTo(controls.target) *
        Math.tan(MathUtils.degToRad(camera.fov / 2))) /
      h;
    onScale(scaleBar(metresPerPixel, Math.min(112, (view.mode === 'compare' ? split : w) * 0.36)));
  }
  function invalidate() {
    if (!pendingFrame) pendingFrame = requestAnimationFrame(render);
  }
  function renderNow() {
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    render();
  }
  function updateCamera() {
    applyingView = true;
    const tilt = MathUtils.degToRad(
      view.angle === 'grazing' ? 75 : view.angle === 'oblique' ? 52 : 0.0001
    );
    controls.minDistance = MIN_ALTITUDE / Math.cos(tilt);
    controls.maxDistance = MAX_ALTITUDE / Math.cos(tilt);
    controls.target.set(view.x, 0, view.z);
    camera.position.set(view.x, view.height, view.z + view.height * Math.tan(tilt));
    controls.update();
    applyingView = false;
    invalidate();
  }
  controls.addEventListener('change', () => {
    if (applyingView) return;
    view.height = camera.position.y;
    view.x = controls.target.x;
    view.z = controls.target.z;
    onNavigate();
    invalidate();
  });
  new ResizeObserver(invalidate).observe(canvas);
  updateCamera();
  renderNow();
  await pebbles.ready();
  renderNow();
  return {
    updateCamera,
    invalidate,
    cancelTiming() {
      materialTiming?.abort();
    },
    async measure() {
      materialTiming?.abort();
      const timing = new AbortController();
      materialTiming = timing;
      renderNow();
      await pebbles.ready();
      timing.signal.throwIfAborted();
      renderNow();
      const square = camera.clone();
      square.aspect = 1;
      square.updateProjectionMatrix();
      preparePebbles(square, TIMING_SIZE);
      try {
        return await timeMaterials(
          renderer,
          (showCandidate) => {
            selectMaterial(showCandidate);
            renderer.render(scene, square);
          },
          timing.signal
        );
      } finally {
        invalidate();
      }
    },
  };
}
