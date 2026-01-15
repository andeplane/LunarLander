import './style.css';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';
import { FlightController } from './camera/FlightController';
import { Skybox } from './environment/Skybox';
import { CelestialSystem } from './environment/CelestialSystem';
import { TerrainManager, TerrainConfig } from './terrain/TerrainManager';
import { LodDetailLevel } from './terrain/LodUtils';
import { ShaderUIController } from './ui/ShaderUIController';
import type { CameraConfig } from './types';

/**
 * Main entry point for Lunar Explorer
 * Initializes the Three.js scene and starts the render loop
 */

// Get canvas element
const app = document.querySelector<HTMLDivElement>('#app')!;
const canvas = document.createElement('canvas');
app.appendChild(canvas);

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

// Terrain configuration
const terrainConfig: TerrainConfig = {
  renderDistance: 30,    // Chunks to load in each direction
  chunkWidth: 100,       // World units per chunk
  chunkDepth: 100,       // World units per chunk
  lodLevels: [1024, 512, 256, 128, 64, 32, 16, 8, 4], // Resolution levels (highest to lowest)
  lodDetailLevel: LodDetailLevel.Balanced,   // Target screen-space triangle size
  workerCount: 3,        // 1 high-priority + 2 normal workers
};

// Initialize terrain manager first (needed by flight controller)
const terrainManager = new TerrainManager(engine.getScene(), terrainConfig);
terrainManager.setCamera(engine.getCamera());
engine.setTerrainManager(terrainManager);

// Initialize flight controller with terrain manager
const flightController = new FlightController(
  engine.getCamera(),
  inputManager,
  cameraConfig,
  terrainManager
);
engine.setFlightController(flightController);

// Set input manager in engine
engine.setInputManager(inputManager);

// Set initial camera position above terrain
const initialX = -3;
const initialZ = 8;
const terrainHeight = terrainManager.getHeightAt(initialX, initialZ);
if (terrainHeight !== null) {
  engine.getCamera().position.set(initialX, terrainHeight + cameraConfig.minAltitudeAGL + 5, initialZ); // Start 5m above min altitude
} else {
  engine.getCamera().position.set(initialX, 4, initialZ); // Fallback height
}
engine.getCamera().rotation.x -= 0.4;
engine.getCamera().rotation.y -= 0.2;
engine.getCamera().rotation.z -= 0.06;

// Set up click to enable pointer lock
canvas.addEventListener('click', () => {
  inputManager.requestPointerLock();
});

// Initialize skybox with Milky Way texture
const skybox = new Skybox(engine.getScene());
skybox.loadTexture('/textures/8k_stars_milky_way.jpg');

// Initialize celestial system (sun, Earth, lighting with Moon curvature)
// Only override position values - all intensity/range defaults come from CelestialSystem
const celestialSystem = new CelestialSystem(engine.getScene(), {
  // Sun position - high in the sky, slightly to the side
  sunAzimuth: Math.PI * 0.3,
  sunElevation: Math.PI * 0.35,
  
  // Earth position - visible in the lunar sky
  earthAzimuth: Math.PI * 1.15,
  earthElevation: Math.PI * 0.25,
});
// Set camera reference for spaceship light positioning
celestialSystem.setCamera(engine.getCamera());
engine.setCelestialSystem(celestialSystem);

// Initialize shader UI controller (after celestial system so they can be synced)
const shaderUI = new ShaderUIController(terrainManager.getMaterial(), celestialSystem);

// Start the render loop
engine.start();

// Handle cleanup on page unload
window.addEventListener('beforeunload', () => {
  shaderUI.dispose();
  skybox.dispose();
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
