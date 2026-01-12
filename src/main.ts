import './style.css';
import * as THREE from 'three';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';

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

// Set up click to enable pointer lock
canvas.addEventListener('click', () => {
  inputManager.requestPointerLock();
});

// Add a simple test object to verify the scene works
const geometry = new THREE.BoxGeometry(10, 10, 10);
const material = new THREE.MeshStandardMaterial({ color: 0x888888 });
const testCube = new THREE.Mesh(geometry, material);
testCube.position.set(0, 5, 0);
engine.getScene().add(testCube);

// Add a light so we can see the cube
const light = new THREE.DirectionalLight(0xffffff, 1);
light.position.set(10, 10, 10);
engine.getScene().add(light);

// Start the render loop
engine.start();

// Handle cleanup on page unload
window.addEventListener('beforeunload', () => {
  engine.dispose();
});
