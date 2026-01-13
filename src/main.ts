import './style.css';
import * as THREE from 'three';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';
import { FlightController } from './camera/FlightController';
import { Skybox } from './environment/Skybox';
import { TerrainManager, TerrainConfig } from './terrain/TerrainManager';
import { LodDetailLevel } from './terrain/LodUtils';
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
  mouseSensitivity: 0.002
};

// Terrain configuration
const terrainConfig: TerrainConfig = {
  renderDistance: 20,    // Chunks to load in each direction
  chunkWidth: 50,       // World units per chunk
  chunkDepth: 50,       // World units per chunk
  lodLevels: [1024, 512, 256, 128, 64, 32, 16, 4], // Resolution levels (highest to lowest)
  lodDetailLevel: LodDetailLevel.Balanced,   // Target screen-space triangle size
};

// Initialize flight controller
const flightController = new FlightController(
  engine.getCamera(),
  inputManager,
  cameraConfig
);
engine.setFlightController(flightController);

// Initialize terrain manager
const terrainManager = new TerrainManager(engine.getScene(), terrainConfig);
terrainManager.setCamera(engine.getCamera());
engine.setTerrainManager(terrainManager);

// Set input manager in engine
engine.setInputManager(inputManager);

// Set initial camera position above terrain
engine.getCamera().position.set(-3, 4, 8);
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

// Add directional light (sun)
const sunLight = new THREE.DirectionalLight(0xffffff, 2);
sunLight.position.set(100, 100, 50);
engine.getScene().add(sunLight);

// Subtle ambient light
const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
engine.getScene().add(ambientLight);

// Add fog for depth
engine.getScene().fog = new THREE.Fog(0xd3dde2, 4, terrainConfig.renderDistance * terrainConfig.chunkWidth - 2);

// Start the render loop
engine.start();

// Handle cleanup on page unload
window.addEventListener('beforeunload', () => {
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
