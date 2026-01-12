import * as THREE from 'three';
import { FlightController } from '../camera/FlightController';

/**
 * Main engine class responsible for:
 * - Renderer setup and initialization
 * - Main render loop with deltaTime tracking
 * - Scene management
 * - FlightController updates
 */
export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private animationId: number | null = null;
  private flightController: FlightController | null = null;
  
  // Time tracking
  private clock: THREE.Clock = new THREE.Clock();
  private lastTime: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    // Initialize renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Initialize scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);

    // Initialize camera
    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      100000
    );
    this.camera.position.set(0, 100, 200);

    // Handle window resize
    window.addEventListener('resize', () => this.handleResize());
  }

  /**
   * Set the flight controller for camera updates
   */
  setFlightController(controller: FlightController): void {
    this.flightController = controller;
  }

  /**
   * Get the Three.js scene
   */
  getScene(): THREE.Scene {
    return this.scene;
  }

  /**
   * Get the camera
   */
  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  /**
   * Get the renderer
   */
  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  /**
   * Start the render loop
   */
  start(): void {
    this.clock.start();
    this.lastTime = this.clock.getElapsedTime();
    
    const animate = () => {
      this.animationId = requestAnimationFrame(animate);
      
      // Calculate delta time
      const currentTime = this.clock.getElapsedTime();
      const deltaTime = currentTime - this.lastTime;
      this.lastTime = currentTime;
      
      this.update(deltaTime);
      this.render();
    };
    animate();
  }

  /**
   * Stop the render loop
   */
  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  /**
   * Update loop (called every frame)
   */
  private update(deltaTime: number): void {
    // Update flight controller
    if (this.flightController) {
      this.flightController.update(deltaTime);
    }
  }

  /**
   * Render loop (called every frame)
   */
  private render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Handle window resize
   */
  private handleResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.stop();
    this.renderer.dispose();
  }
}
