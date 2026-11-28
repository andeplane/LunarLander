import { GameMenu } from './ui/GameMenu';
import { PlayerSettings } from './core/PlayerSettings';
import { LanderAudio } from './lander/LanderAudio';
import './style.css';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';
import { FlightController } from './camera/FlightController';
import { ModeManager } from './modes/ModeManager';
import { MenuMode } from './modes/MenuMode';
import { ExploreMode } from './modes/ExploreMode';
import { RoverMode } from './modes/RoverMode';
import { LanderMode } from './modes/LanderMode';
// Skybox is now handled as a mesh inside CelestialSystem
import { CelestialSystem } from './environment/CelestialSystem';
import { ChunkManager, type ChunkConfig } from './terrain/ChunkManager';
import { TerrainGenerator } from './terrain/TerrainGenerator';
import { RockManager } from './environment/RockManager';
import type { MoonMaterial } from './shaders/MoonMaterial';
import type { MoonMaterialParams } from './shaders/MoonMaterial';
import { DEFAULT_LOD_LEVELS, LodDetailLevel } from './terrain/LodUtils';
import { ShaderUIController } from './ui/ShaderUIController';
import { LoadingManager } from './ui/LoadingManager';
import { TouchControls } from './ui/TouchControls';
import { isTouchDevice } from './utils/mobile';
import type { CameraConfig, RockGenerationConfig, CraterGenerationConfig } from './types';
import { DEFAULT_PLANET_RADIUS } from './core/EngineSettings';
import { PhysicsWorld } from './physics/PhysicsWorld';
import { TerrainColliderManager } from './physics/TerrainColliderManager';
import { BallManager } from './physics/BallManager';

/**
 * Main entry point for Lunar Explorer
 * Initializes the Three.js scene and starts the render loop
 */

// Get canvas element
const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Could not find #app element');
}
const canvas = document.createElement('canvas');
app.appendChild(canvas);

// Initialize loading manager early
const loadingManager = new LoadingManager();
// Track: surface-high-detail + skybox + 4 Earth textures
loadingManager.registerTextures(5);

// Camera configuration (from PRD section 9.2)
const cameraConfig: CameraConfig = {
  fov: 70,
  near: 0.1,
  far: 100000,
  baseSpeed: 50,        // 50 m/s default
  minSpeed: 1,          // 1 m/s minimum
  maxSpeed: 1000,       // 1000 m/s maximum
  acceleration: 5.0,    // Smoothing factor
  mouseSensitivity: 0.002,
  minAltitudeAGL: 0.5,    // Minimum altitude above ground (meters)
};

// Initialize engine (camera frustum comes from cameraConfig)
const engine = new Engine(canvas, cameraConfig);
// Debug stats stay hidden until Explore mode is entered (onModeChange below)
engine.setStatsVisible(false);

// Initialize input manager
const inputManager = new InputManager();

// Chunk configuration
const chunkConfig: ChunkConfig = {
  renderDistance: 10,    // Chunks to load in each direction
  chunkWidth: 400,       // World units per chunk
  chunkDepth: 400,       // World units per chunk
  lodLevels: [...DEFAULT_LOD_LEVELS], // Resolution levels (highest to lowest)
  lodDetailLevel: LodDetailLevel.Balanced,   // Target screen-space triangle size
  workerCount: undefined, // Auto-detect from CPU cores (default: hardwareConcurrency - 1, capped at 8)
};

// Rock generation configuration: N(>D) = densityConstant * D^powerLawExponent
// rocks per m² above diameter D on average, gathered into boulder fields
// (see rockPlacement.ts). About 790 rocks per 400 m chunk at LOD 0, between
// ~260 on open plains and ~1700 in the middle of a boulder field.
const rockGeneration: RockGenerationConfig = {
  minDiameter: 0.33,          // Smallest rock (meters) - sets the total count
  maxDiameter: 12.0,          // Largest boulders (meters)
  densityConstant: 0.00048,   // N(>1m) per m² averaged over fields and plains
  powerLawExponent: -2.1,     // Size-frequency exponent (shallower than the -2.5 of block fields: keeps house-size boulders in view)
  // Diameter bands streamed ahead of the camera as their rocks grow on screen.
  lodMinDiameterScale: [1.0, 1.5, 2.5, 4.5, 9.0, 18.0, 40.0],
};

// Crater generation configuration, matched to counts on the lunar maria
// (Minton et al. 2019, Apollo 15 site): equilibrium N(>r) = 8400 r^-2 per km²
// up to r = 150 m and the steeper production slope above. Per 400 m chunk
// that is ~1340 craters with r >= 1 m and ~13 with r >= 10 m; an r >= 250 m
// crater turns up about every 12 km².
const craterGeneration: CraterGenerationConfig = {
  seed: 42,                    // Deterministic seed for reproducible placement
  density: 8400,               // Craters per km² with radius >= 1 m
  minRadius: 1,                // Smallest craters (2 m diameter)
  maxRadius: 1000,             // Largest craters (2 km diameter)
  powerLawExponent: -2,        // Equilibrium size-frequency slope
  breakRadius: 150,            // Equilibrium ends here ...
  steepExponent: -3.2,         // ... and the production slope takes over
  depthRatio: 0.2,             // Fresh rim-to-floor depth = 20% of diameter (12% below 50 m)
  rimHeight: 0.036,            // Fresh crater rim = 3.6% of diameter (Pike 1977)
  rimWidth: 1.5,               // Ejecta blanket reaches 2.5 radii from the center
  floorFlatness: 0,            // No extra flattening (large craters flatten on their own)
  degradedDepthRatio: 0.05,    // Oldest craters still countable: depth = 5% of diameter
  freshnessExponent: 3,        // Ages spread evenly up to erasure
};

// Initialize terrain generator and rock manager
const terrainGenerator = new TerrainGenerator({
  chunkWidth: chunkConfig.chunkWidth,
  chunkDepth: chunkConfig.chunkDepth,
  renderDistance: chunkConfig.renderDistance,
  planetRadius: DEFAULT_PLANET_RADIUS,
});
const rockManager = new RockManager(
  30, // 30 rock prototypes per LOD
  chunkConfig.chunkWidth,
  chunkConfig.chunkDepth,
  chunkConfig.lodLevels,
  chunkConfig.renderDistance,
  DEFAULT_PLANET_RADIUS
);

// Initialize chunk manager (orchestrates terrain + rocks + craters)
const chunkManager = new ChunkManager(
  engine.getScene(),
  chunkConfig,
  terrainGenerator,
  rockManager,
  rockGeneration,
  craterGeneration,
  () => engine.requestRender()
);
chunkManager.setCamera(engine.getCamera());
engine.setChunkManager(chunkManager);
chunkManager.enablePebbleRelief();

// Initialize flight controller with chunk manager
const flightController = new FlightController(
  engine.getCamera(),
  inputManager,
  cameraConfig,
  chunkManager
);

// Set input manager in engine
engine.setInputManager(inputManager);

// Initialize touch controls early so modes can toggle their visibility
// (touch-capable devices only); hidden until Explore mode is entered
let touchControls: TouchControls | null = null;
if (isTouchDevice()) {
  touchControls = new TouchControls(inputManager);
  touchControls.setFlightController(flightController);
  touchControls.setVisible(false);
}

// Debug tools require ?debug=true
const debugEnabled =
  new URLSearchParams(window.location.search).get('debug') === 'true';

// --- Game modes (ADR-0001): Menu, Explore, Lander and Rover share one world ---
let drivingColliders: TerrainColliderManager | undefined;
const modeManager = new ModeManager(inputManager, (mode) => {
  const isExplore = mode === exploreMode;
  if (drivingColliders) drivingColliders.surfaceDriving = mode instanceof RoverMode;
  // Debug UI and the O/I/C debug keys all require ?debug=true
  engine.setStatsVisible(debugEnabled && isExplore);
  engine.setDebugKeysEnabled(debugEnabled && mode !== landerMode && !(mode instanceof RoverMode));
  shaderUI.setVisible(debugEnabled && isExplore);
});
engine.setModeManager(modeManager);

const settings = new PlayerSettings();
const audio = new LanderAudio();
function applyVideoSettings(): void {
  terrainGenerator.getMaterial().setParams({
    groundTextureLayers: settings.groundTexture,
    rockBump: settings.rockBump,
  });
  rockManager.getMaterial().setParam('rockBump', settings.rockBump);
  engine.getSunShadows().setRoverShadowQuality(settings.shadowQuality);
  engine.setRenderScale(settings.renderScale);
  engine.requestRender();
}
applyVideoSettings();
const gameMenu = new GameMenu(settings, {
  canPause: () => modeManager.getActiveMode() !== null && modeManager.getActiveMode() !== menuMode,
  setPaused: paused => {
    modeManager.setPaused(paused);
    inputManager.resetAll();
    audio.setPaused(paused);
  },
  resume: () => {
    if (modeManager.getActiveMode() === exploreMode) exploreMode.resumeMouseLook();
    const mode = modeManager.getActiveMode();
    if (mode instanceof RoverMode) mode.refreshCameraHint();
  },
  mainMenu: () => modeManager.switchTo(menuMode),
  applyVideo: applyVideoSettings,
  isMuted: () => audio.isMuted(),
  mute: muted => audio.setMuted(muted),
});

const exploreMode = new ExploreMode({
  camera: engine.getCamera(),
  flightController,
  inputManager,
  touchControls,
  canvas,
  requestRender: () => engine.requestRender(),
  onPause: () => gameMenu.pause(),
});

const landerMode = new LanderMode({
  camera: engine.getCamera(),
  scene: engine.getScene(),
  inputManager,
  chunkManager,
  rockConfig: rockGeneration,
  rockLibrarySize: 30, // must match the RockManager prototype count above
  requestRender: () => engine.requestRender(),
  onExitToMenu: () => modeManager.switchTo(menuMode),
  onPause: () => gameMenu.pause(),
  audio,
});

const roverOptions = {
  camera: engine.getCamera(),
  canvas,
  scene: engine.getScene(),
  input: inputManager,
  chunks: chunkManager,
  rocks: rockManager,
  shadows: engine.getSunShadows(),
  onPause: () => gameMenu.pause(),
  settings,
  requestRender: () => engine.requestRender(),
};
const roverMode = new RoverMode(roverOptions);
const huntMode = new RoverMode(roverOptions, rockGeneration);

const menuMode = new MenuMode(engine.getCamera(), {
  onSettings: () => gameMenu.showSettings(),
  onSelectExplore: () => modeManager.switchTo(exploreMode),
  onSelectHunt: () => modeManager.switchTo(huntMode),
  onSelectRover: () => modeManager.switchTo(roverMode),
  onSelectLander: () => modeManager.switchTo(landerMode),
  getSurfaceLabHref: debugEnabled
    ? () => {
        const { x, y, z } = engine.getCamera().position;
        const patch = new URLSearchParams({ x: String(x), z: String(z) });
        const ground = chunkManager.getHeightAt(x, z);
        if (ground !== null) patch.set('d', String(y - ground));
        return `./surface-lab.html#${patch}`;
      }
    : undefined,
  requestRender: () => engine.requestRender(),
});

// Show the main menu once loading completes
loadingManager.setOnComplete(() => {
  modeManager.switchTo(menuMode);
});

// Initialize physics system (async)
const physicsWorld = new PhysicsWorld();
physicsWorld.initialize().then(() => {
  console.log('[Physics] Rapier initialized');
  
  // Create terrain collider manager
  const terrainColliderManager = new TerrainColliderManager(
    physicsWorld.getWorld(),
    chunkManager,
    chunkConfig.chunkWidth,
    chunkConfig.chunkDepth,
    chunkConfig.lodLevels,
    { physicsRange: 2 }
  );
  
  drivingColliders = terrainColliderManager;
  drivingColliders.surfaceDriving = modeManager.getActiveMode() instanceof RoverMode;

  // Create ball manager
  const ballManager = new BallManager(
    physicsWorld.getWorld(),
    engine.getScene(),
    {
      ballRadius: 0.3,
      shootSpeed: 20,
      maxBalls: 100,
      restitution: 0.7,
      friction: 0.3,
      ballColor: 0xff4444,
    },
    // Height sampler: prevents balls from spawning beneath the terrain
    (x, z) => chunkManager.getHeightAt(x, z)
  );
  
  // Wire up physics system
  physicsWorld.setTerrainColliderManager(terrainColliderManager);
  physicsWorld.addPhysicsStepListener(ballManager);
  engine.setPhysicsWorld(physicsWorld);
  engine.setTerrainColliderManager(terrainColliderManager);

  // Late injection into modes (they exist before physics is ready)
  exploreMode.setBallManager(ballManager);
  roverMode.setPhysics(physicsWorld);
  huntMode.setPhysics(physicsWorld);
  landerMode.setPhysics(physicsWorld, ballManager);

  console.log('[Physics] Physics system ready. Press Space to shoot balls (Explore mode).');
}).catch((err) => {
  roverMode.reportPhysicsFailure();
  huntMode.reportPhysicsFailure();
  console.error('[Physics] Failed to initialize:', err);
});

// Set initial camera position above terrain
const initialX = -3;
const initialZ = 8;
const terrainHeight = chunkManager.getHeightAt(initialX, initialZ);
if (terrainHeight !== null) {
  engine.getCamera().position.set(initialX, terrainHeight + cameraConfig.minAltitudeAGL + 5, initialZ); // Start 5m above min altitude
} else {
  engine.getCamera().position.set(initialX, 4, initialZ); // Fallback height
}
engine.getCamera().rotation.x -= 0.4;
engine.getCamera().rotation.y -= 0.2;
engine.getCamera().rotation.z -= 0.06;

// Force initial render after camera position is set
engine.requestRender();

// Pointer-lock acquisition, the ESC hint, and touch-control visibility are
// owned by ExploreMode (ADR-0001 §5)

// Initialize celestial system (sun, Earth, skybox, lighting with Moon curvature)
// Only override position values - all intensity/range defaults come from CelestialSystem
const celestialSystem = new CelestialSystem(
  engine.getScene(),
  () => engine.requestRender(),
  {
    // Sun position - high in the sky, slightly to the side
    sunAzimuth: Math.PI * 0.3,
    sunElevation: Math.PI * 0.35,
    
    // Earth position - visible in the lunar sky
    earthAzimuth: Math.PI * 1.15,
    earthElevation: Math.PI * 0.25,
    
    // Loading callbacks for Earth textures (4 textures)
    onEarthTextureLoad: () => {
      loadingManager.onTextureLoaded();
    },
    onEarthTextureError: (path) => {
      loadingManager.onTextureError(path);
    },
  }
);
// Set camera reference for spaceship light positioning
celestialSystem.setCamera(engine.getCamera());
engine.setCelestialSystem(celestialSystem);

// Load skybox texture (now handled by CelestialSystem as a mesh)
celestialSystem.loadSkyboxTexture(
  `${import.meta.env.BASE_URL}textures/8k_stars_milky_way.jpg`,
  () => {
    loadingManager.onTextureLoaded();
  },
  () => {
    loadingManager.onTextureError('skybox');
  }
);

// Initialize shader UI controller (after celestial system so they can be synced)
const shaderUI = new ShaderUIController(
  chunkManager.getMaterial(),
  () => engine.requestRender(),
  celestialSystem
);
// Shader panel stays hidden until Explore mode is entered (onModeChange)
shaderUI.setVisible(false);

// Start the render loop
engine.start();

// Poll for chunk readiness (check every frame until nearest chunk has max LOD)
const checkChunkReady = () => {
  if (loadingManager.isLoadingComplete()) {
    return; // Already complete, stop checking
  }
  
  const camera = engine.getCamera();
  const cameraX = camera.position.x;
  const cameraZ = camera.position.z;
  
  // Check if chunk at camera position has max LOD (level 0)
  if (chunkManager.hasMaxLodAt(cameraX, cameraZ)) {
    loadingManager.onChunkReady();
  }
  
  // Continue checking until loading is complete
  requestAnimationFrame(checkChunkReady);
};

// Start checking for chunk readiness after a brief delay to allow initial chunk generation
setTimeout(() => {
  checkChunkReady();
}, 100);

// Expose for debugging (access via window.debug in console)
interface DebugWindow extends Window {
  debug?: {
    engine: typeof engine;
    getTerrainMaterial: () => MoonMaterial;
    getRockMaterial: () => MoonMaterial;
    setDebugMode: (mode: number) => void;
    render: () => void;
    celestialSystem: typeof celestialSystem;
    chunkManager: typeof chunkManager;
    flightController: typeof flightController;
  };
}
// Wrap a live material's setParam to auto-trigger re-render and keep the GUI
// in sync. Idempotent: materials are wrapped at most once, so repeated
// window.debug.get*Material() calls don't nest wrappers without bound.
const debugWrappedMaterials = new WeakSet<MoonMaterial>();
const wrapMaterialForDebug = (mat: MoonMaterial): MoonMaterial => {
  if (debugWrappedMaterials.has(mat)) {
    return mat;
  }
  debugWrappedMaterials.add(mat);
  const originalSetParam = mat.setParam.bind(mat);
  mat.setParam = <K extends keyof MoonMaterialParams>(key: K, value: MoonMaterialParams[K]) => {
    originalSetParam(key, value);
    engine.requestRender();
    // Reflect console tweaks in the shader GUI sliders
    shaderUI.refreshDisplay();
  };
  return mat;
};

(window as DebugWindow).debug = {
  engine,
  getTerrainMaterial: () => wrapMaterialForDebug(terrainGenerator.getMaterial()),
  getRockMaterial: () => wrapMaterialForDebug(rockManager.getMaterial()),
  setDebugMode: (mode: number) => {
    terrainGenerator.getMaterial().setParam('debugMode', mode);
    rockManager.getMaterial().setParam('debugMode', mode);
    // Disable all post-processing in debug mode (bloom, tone mapping wash out colors)
    engine.setPostProcessingEnabled(mode === 0);
    engine.requestRender();
    console.log(`Debug mode set to ${mode}`);
    console.log('Modes: 0=normal, 1=meshNormal, 2=detailNormal, 3=sunVisibility, 4=albedo, 5=lighting');
  },
  render: () => engine.requestRender(),
  celestialSystem,
  chunkManager,
  flightController,
};
console.log('Debug: window.debug.setDebugMode(1-5) to visualize shader values');

// Handle cleanup on page unload
window.addEventListener('beforeunload', () => {
  shaderUI.dispose();
  if (touchControls) {
    touchControls.dispose();
  }
  engine.dispose();
});

// Log instructions to console
if (isTouchDevice()) {
  console.log('Lunar Explorer - Mobile Controls:');
  console.log('  Left joystick - Move forward/backward/strafe');
  console.log('  Right side drag - Look around');
  console.log('  Up/Down buttons - Move up/down');
  console.log('  Speed button (top right) - Tap to cycle speed');
  console.log('  O - Toggle debug wireframe (shows LOD chunks)');
  console.log('  Space - Shoot ball (Explore mode)');
} else {
  console.log('Lunar Explorer - Desktop Controls:');
  console.log('  Click to enable mouse look');
  console.log('  W/S - Forward/Backward');
  console.log('  A/D - Strafe Left/Right');
  console.log('  Q - Down | E - Up');
  console.log('  Shift - Hold for speed boost (3x faster)');
  console.log('  Mouse - Look around');
  console.log('  Scroll - Adjust speed');
  console.log('  Escape - Pause');
  console.log('  O - Toggle debug wireframe (shows LOD chunks)');
  console.log('  Space - Shoot ball (Explore mode)');
}

// Expose setCameraPosition to window for debugging
(window as unknown as { setCameraPosition: (x: number, y: number, z: number) => void }).setCameraPosition = (x: number, y: number, z: number) => {
  if (modeManager.getActiveMode() === landerMode) {
    console.warn('setCameraPosition is disabled in Lander mode (camera is driven by the lander rig)');
    return;
  }
  engine.getCamera().position.set(x, y, z);
  flightController.syncFromCamera();
  console.log(`Camera position set to: (${x}, ${y}, ${z})`);
};

// Print current camera position command
const cam = engine.getCamera();
console.log(`setCameraPosition(${cam.position.x.toFixed(1)}, ${cam.position.y.toFixed(1)}, ${cam.position.z.toFixed(1)})`);
console.log('Use setCameraPosition(x, y, z) in console to set camera position');
