import './style.css';
import * as THREE from 'three';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';
import { FlightController } from './camera/FlightController';
import { Skybox } from './environment/Skybox';
import { ChunkManager } from './terrain/ChunkManager';
import type { CameraConfig, ChunkConfig } from './types';

/**
 * Main entry point for Lunar Explorer
 * Initializes the Three.js scene and starts the render loop
 */

// Parse URL parameters
const urlParams = new URLSearchParams(window.location.search);
const debugMeshes = urlParams.get('debugMeshes') === 'true';

if (debugMeshes) {
  console.log('Debug mode enabled: Chunk meshes will show colored triangles');
}

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

// Chunk configuration (Minecraft-inspired)
const chunkConfig: ChunkConfig = {
  size: 64,           // 64m per chunk
  resolution: 16,     // 16x16 vertices (simple quad grid)
  viewDistance: 5,    // Load 5 chunks in each direction
  buildBudget: 2,     // Max chunks to build per frame
  disposeBuffer: 2,   // Extra chunks before disposal
  debugMeshes         // Use URL param for debug visualization
};

// Initialize flight controller
const flightController = new FlightController(
  engine.getCamera(),
  inputManager,
  cameraConfig
);
engine.setFlightController(flightController);

// Initialize chunk manager
const chunkManager = new ChunkManager(chunkConfig, engine.getScene());
engine.setChunkManager(chunkManager);

// Set initial camera position above terrain
engine.getCamera().position.set(0, 100, 0);

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

// Add subtle ambient light
const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
engine.getScene().add(ambientLight);

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
console.log('  Q/Shift - Down | E/Space - Up');
console.log('  Mouse - Look around');
console.log('  Scroll - Adjust speed');
console.log('  Escape - Release mouse');
console.log('');
console.log('URL Parameters:');
console.log('  ?debugMeshes=true - Show colored triangles for each chunk');
