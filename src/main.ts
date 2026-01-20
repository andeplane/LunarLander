import './style.css';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';
import { FlightController } from './camera/FlightController';
// Skybox is now handled as a mesh inside CelestialSystem
import { CelestialSystem } from './environment/CelestialSystem';
import { ChunkManager, type ChunkConfig } from './terrain/ChunkManager';
import { TerrainGenerator } from './terrain/TerrainGenerator';
import { RockManager } from './environment/RockManager';
import type { MoonMaterial } from './shaders/MoonMaterial';
import type { MoonMaterialParams } from './shaders/MoonMaterial';
import { LodDetailLevel } from './terrain/LodUtils';
import { ShaderUIController } from './ui/ShaderUIController';
import { LoadingManager } from './ui/LoadingManager';
import type { CameraConfig, RockGenerationConfig, CraterGenerationConfig } from './types';
import { TextureLoader, MirroredRepeatWrapping, SRGBColorSpace, type Texture, LinearMipmapLinearFilter, LinearFilter } from 'three';
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

// Initialize engine
const engine = new Engine(canvas);

// Initialize input manager
const inputManager = new InputManager();

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
  slowdownAltitude: 50, // Start slowing at this AGL (meters)
  slowdownFactor: 0.0, // Speed multiplier at minimum altitude
};

// Chunk configuration
const chunkConfig: ChunkConfig = {
  renderDistance: 10,    // Chunks to load in each direction
  chunkWidth: 400,       // World units per chunk
  chunkDepth: 400,       // World units per chunk
  lodLevels: [1024, 512, 256, 128, 64, 32, 16, 8, 4], // Resolution levels (highest to lowest)
  lodDetailLevel: LodDetailLevel.Balanced,   // Target screen-space triangle size
  workerCount: undefined, // Auto-detect from CPU cores (default: hardwareConcurrency - 1, capped at 8)
};

// Rock generation configuration (scientific lunar distribution from Rüsch et al. 2024)
// N(>D) = densityConstant * D^powerLawExponent gives rocks per m² above diameter D
const rockGeneration: RockGenerationConfig = {
  minDiameter: 0.75,           // Smallest visible rock (meters) - affects total density
  maxDiameter: 10.0,          // Largest boulders (meters)
  densityConstant: 0.0005,    // N(>1m) per m² (500 per km² for mature lunar terrain)
  powerLawExponent: -2.5,     // Size-frequency exponent (scientific lunar value)
  // LOD scaling - rocks smaller than minDiameter * scale are hidden at that LOD
  lodMinDiameterScale: [1.0, 1.0, 1.0, 2.0, 4.0, 6.0],
};

// Crater generation configuration (lunar crater size-frequency distribution)
// Based on S(D) ≈ 22,000 · D^(-2.4) craters per km² from Apollo 11 site data
const craterGeneration: CraterGenerationConfig = {
  seed: 42,                    // Deterministic seed for reproducible placement
  density: 100,                // Craters per km² (tuned for visual appeal)
  minRadius: 5,                // Smallest craters (5m radius = 10m diameter)
  maxRadius: 150,              // Largest craters (150m radius = 300m diameter)
  powerLawExponent: -2.2,      // Slightly shallower than lunar (-2.4) for more variety
  depthRatio: 0.15,            // Depth = 15% of diameter (realistic lunar depth)
  rimHeight: 0.3,              // Rim height = 30% of depth (small raised edge)
  rimWidth: 0.2,               // Rim extends 20% beyond crater radius
  floorFlatness: 0,            // Parabolic bowl shape (0 = fully curved)
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

// Initialize flight controller with chunk manager
const flightController = new FlightController(
  engine.getCamera(),
  inputManager,
  cameraConfig,
  chunkManager
);
engine.setFlightController(flightController);

// Set input manager in engine
engine.setInputManager(inputManager);

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
    }
  );
  
  // Wire up physics system
  physicsWorld.setTerrainColliderManager(terrainColliderManager);
  physicsWorld.setBallManager(ballManager);
  engine.setPhysicsWorld(physicsWorld);
  engine.setTerrainColliderManager(terrainColliderManager);
  engine.setBallManager(ballManager);
  
  console.log('[Physics] Physics system ready. Press Space to shoot balls.');
}).catch((err) => {
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

// Set up click to enable pointer lock
canvas.addEventListener('click', () => {
  inputManager.requestPointerLock();
});

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
    
    // Loading callback for Earth textures (4 textures)
    onEarthTextureLoad: () => {
      loadingManager.onTextureLoaded();
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
  }
);

// Initialize shader UI controller (after celestial system so they can be synced)
const shaderUI = new ShaderUIController(
  chunkManager.getMaterial(),
  () => engine.requestRender(),
  celestialSystem
);

// Load texture
const textureLoader = new TextureLoader();

// Configure texture settings helper
const configureTexture = (texture: Texture) => {
  texture.wrapS = MirroredRepeatWrapping;
  texture.wrapT = MirroredRepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 16; // Max anisotropic filtering for better quality at angles
  texture.minFilter = LinearMipmapLinearFilter; // Trilinear filtering for best mipmap quality
  texture.magFilter = LinearFilter; // Linear interpolation when zoomed in
  texture.generateMipmaps = true;
};

// Load high detail texture
textureLoader.load(
  `${import.meta.env.BASE_URL}textures/surface-high-detail.png`,
  (texture) => {
    configureTexture(texture);
    
    // Apply to materials
    const terrainMaterial = terrainGenerator.getMaterial();
    const rockMaterial = rockManager.getMaterial();
    
    terrainMaterial.setParam('textureHighDetail', texture);
    rockMaterial.setParam('textureHighDetail', texture);
    
    // Report texture loaded
    loadingManager.onTextureLoaded();
  }
);

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
  };
}
(window as DebugWindow).debug = {
  engine,
  getTerrainMaterial: () => {
    const mat = terrainGenerator.getMaterial();
    // Wrap setParam to auto-trigger re-render
    const originalSetParam = mat.setParam.bind(mat);
    mat.setParam = <K extends keyof MoonMaterialParams>(key: K, value: MoonMaterialParams[K]) => {
      originalSetParam(key, value);
      engine.requestRender();
    };
    return mat;
  },
  getRockMaterial: () => {
    const mat = rockManager.getMaterial();
    const originalSetParam = mat.setParam.bind(mat);
    mat.setParam = <K extends keyof MoonMaterialParams>(key: K, value: MoonMaterialParams[K]) => {
      originalSetParam(key, value);
      engine.requestRender();
    };
    return mat;
  },
  setDebugMode: (mode: number) => {
    terrainGenerator.getMaterial().setParam('debugMode', mode);
    rockManager.getMaterial().setParam('debugMode', mode);
    engine.requestRender();
    console.log(`Debug mode set to ${mode}`);
    console.log('Modes: 0=normal, 1=meshNormal, 2=microNormal, 3=worldNorm, 4=detailFade, 5=viewDir, 6=gl_FrontFacing');
  },
  render: () => engine.requestRender()
};
console.log('Debug: window.debug.setDebugMode(1-6) to visualize shader values');

// Handle cleanup on page unload
window.addEventListener('beforeunload', () => {
  shaderUI.dispose();
  engine.dispose();
});

// Log instructions to console
console.log('Lunar Explorer - Controls:');
console.log('  Click to enable mouse look');
console.log('  W/S - Forward/Backward');
console.log('  A/D - Strafe Left/Right');
console.log('  Q - Down | E - Up');
console.log('  Shift - Hold for speed boost (3x faster)');
console.log('  Mouse - Look around');
console.log('  Scroll - Adjust speed');
console.log('  Escape - Release mouse');
console.log('  O - Toggle debug wireframe (shows LOD chunks)');
console.log('  Space - Shoot ball');

// Expose setCameraPosition to window for debugging
(window as unknown as { setCameraPosition: (x: number, y: number, z: number) => void }).setCameraPosition = (x: number, y: number, z: number) => {
  engine.getCamera().position.set(x, y, z);
  console.log(`Camera position set to: (${x}, ${y}, ${z})`);
};

// Print current camera position command
const cam = engine.getCamera();
console.log(`setCameraPosition(${cam.position.x.toFixed(1)}, ${cam.position.y.toFixed(1)}, ${cam.position.z.toFixed(1)})`);
console.log('Use setCameraPosition(x, y, z) in console to set camera position');
