import * as THREE from 'three';
import { FlightController } from '../camera/FlightController';
import { TerrainManager } from '../terrain/TerrainManager';
import { InputManager } from './InputManager';

/**
 * Main engine class responsible for:
 * - Renderer setup and initialization
 * - Main render loop with deltaTime tracking
 * - Scene management
 * - FlightController updates
 * - TerrainManager updates
 * - Stats display (FPS, draw calls, triangles)
 */
export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private animationId: number | null = null;
  private flightController: FlightController | null = null;
  private terrainManager: TerrainManager | null = null;
  private inputManager: InputManager | null = null;
  
  // Time tracking
  private clock: THREE.Clock = new THREE.Clock();
  private lastTime: number = 0;
  
  // Stats display
  private statsElement: HTMLDivElement | null = null;
  private frameCount: number = 0;
  private fpsUpdateTime: number = 0;
  private currentFPS: number = 0;
  private lastTriangleCount: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    // Initialize renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.AgXToneMapping;

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
    
    // Create stats display
    this.createStatsDisplay();
  }

  /**
   * Create the stats overlay UI
   */
  private createStatsDisplay(): void {
    this.statsElement = document.createElement('div');
    this.statsElement.id = 'stats-display';
    this.statsElement.style.cssText = `
      position: fixed;
      top: 10px;
      left: 10px;
      background: rgba(0, 0, 0, 0.7);
      color: #0f0;
      font-family: 'Monaco', 'Consolas', monospace;
      font-size: 12px;
      padding: 10px;
      border-radius: 4px;
      z-index: 1000;
      pointer-events: none;
      line-height: 1.5;
    `;
    document.body.appendChild(this.statsElement);
  }

  /**
   * Update the stats display
   */
  private updateStatsDisplay(deltaTime: number): void {
    if (!this.statsElement) return;
    
    // Update FPS counter (every 500ms)
    this.frameCount++;
    this.fpsUpdateTime += deltaTime;
    if (this.fpsUpdateTime >= 0.5) {
      this.currentFPS = Math.round(this.frameCount / this.fpsUpdateTime);
      this.frameCount = 0;
      this.fpsUpdateTime = 0;
    }
    
    const info = this.renderer.info;
    const memory = info.memory;
    const render = info.render;
    
    const chunks = this.terrainManager?.getActiveChunkCount() ?? 0;
    const buildQueue = this.terrainManager?.getBuildQueueLength() ?? 0;
    const workerCount = this.terrainManager?.getWorkerCount() ?? 0;
    const activeWorkers = this.terrainManager?.getActiveWorkerCount() ?? 0;
    
    const cameraPos = this.camera.position;
    const terrainHeight = this.terrainManager?.getHeightAt(cameraPos.x, cameraPos.z) ?? null;
    const agl = terrainHeight !== null ? (cameraPos.y - terrainHeight).toFixed(2) : 'N/A';
    const terrainH = terrainHeight !== null ? terrainHeight.toFixed(2) : 'N/A';
    
    this.statsElement.innerHTML = `
      <strong>Render Stats</strong><br>
      FPS: ${this.currentFPS}<br>
      Draw Calls: ${render.calls}<br>
      Triangles: ${this.lastTriangleCount.toLocaleString()}<br>
      <br>
      <strong>Memory</strong><br>
      Geometries: ${memory.geometries}<br>
      Textures: ${memory.textures}<br>
      <br>
      <strong>Terrain</strong><br>
      Active Chunks: ${chunks}<br>
      Build Queue: ${buildQueue}<br>
      Workers: ${activeWorkers} / ${workerCount}<br>
      Cam Y: ${cameraPos.y.toFixed(2)}m<br>
      Terrain Y: ${terrainH}m<br>
      Altitude AGL: ${agl}m
    `;
  }

  /**
   * Set the flight controller for camera updates
   */
  setFlightController(controller: FlightController): void {
    this.flightController = controller;
  }

  /**
   * Set the terrain manager for terrain updates
   */
  setTerrainManager(manager: TerrainManager): void {
    this.terrainManager = manager;
  }

  /**
   * Set the input manager for input handling
   */
  setInputManager(manager: InputManager): void {
    this.inputManager = manager;
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
    // Check for debug toggle (O key)
    if (this.inputManager?.isKeyJustPressed('o') && this.terrainManager) {
      this.terrainManager.toggleDebugMode();
    }

    // Check for chunk distance/LOD debug (I key)
    if (this.inputManager?.isKeyJustPressed('i') && this.terrainManager) {
      this.terrainManager.logChunkDistancesAndLods(this.camera.position);
    }

    // Check for camera position debug (C key)
    if (this.inputManager?.isKeyJustPressed('c')) {
      const pos = this.camera.position;
      const rot = this.camera.rotation;
      console.log(`Camera Position: x=${pos.x.toFixed(2)}, y=${pos.y.toFixed(2)}, z=${pos.z.toFixed(2)}`);
      console.log(`Camera Rotation: x=${rot.x.toFixed(4)}, y=${rot.y.toFixed(4)}, z=${rot.z.toFixed(4)}`);
    }

    // Update flight controller
    if (this.flightController) {
      this.flightController.update(deltaTime);
    }

    // Update terrain manager with camera position
    if (this.terrainManager) {
      this.terrainManager.update(this.camera.position);
    }

    // Update input manager (clear just-pressed keys)
    if (this.inputManager) {
      this.inputManager.update();
    }
    
    // Update stats display
    this.updateStatsDisplay(deltaTime);
  }

  /**
   * Render loop (called every frame)
   */
  private render(): void {
    this.renderer.render(this.scene, this.camera);
    // Read triangle count after rendering (renderer.info is populated during render)
    // In wireframe mode, Three.js counts lines instead of triangles.
    // We add render.lines / 3 to account for triangles rendered as wireframes.
    this.lastTriangleCount = Math.round(this.renderer.info.render.triangles + this.renderer.info.render.lines / 3);
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
    if (this.terrainManager) {
      this.terrainManager.dispose();
    }
    if (this.statsElement) {
      this.statsElement.remove();
    }
    this.renderer.dispose();
  }
}
