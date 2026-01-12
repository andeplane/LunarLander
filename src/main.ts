import './style.css';
import * as THREE from 'three';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';
import { FlightController } from './camera/FlightController';
import { Skybox } from './environment/Skybox';
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

// Initialize flight controller
const flightController = new FlightController(
  engine.getCamera(),
  inputManager,
  cameraConfig
);
engine.setFlightController(flightController);

// Set up click to enable pointer lock
canvas.addEventListener('click', () => {
  inputManager.requestPointerLock();
});

// Initialize skybox with Milky Way texture
const skybox = new Skybox(engine.getScene());
skybox.loadTexture('/textures/8k_stars_milky_way.jpg');

// Add a test sphere for visual reference
const sphereGeometry = new THREE.SphereGeometry(20, 32, 32);
const sphereMaterial = new THREE.MeshStandardMaterial({ 
  color: 0x888888,
  roughness: 0.8,
  metalness: 0.2
});
const testSphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
testSphere.position.set(0, 0, 0);
engine.getScene().add(testSphere);

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
