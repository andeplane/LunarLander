import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FlightController } from '../camera/FlightController';
import { ChunkManager } from '../terrain/ChunkManager';
import { CelestialSystem } from '../environment/CelestialSystem';
import { InputManager } from './InputManager';
import { DEFAULT_PLANET_RADIUS } from './EngineSettings';

/**
 * Main engine class responsible for:
 * - Renderer setup and initialization
 * - Main render loop with deltaTime tracking
 * - Scene management
 * - FlightController updates
 * - ChunkManager updates
 * - Stats display (FPS, draw calls, triangles)
 */
export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private animationId: number | null = null;
  private flightController: FlightController | null = null;
  private chunkManager: ChunkManager | null = null;
  private celestialSystem: CelestialSystem | null = null;
  private inputManager: InputManager | null = null;
  
  // Post-processing
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  
  // Time tracking
  private clock: THREE.Clock = new THREE.Clock();
  private lastTime: number = 0;
  private deltaTime: number = 0;
  
  // Stats display
  private statsElement: HTMLDivElement | null = null;
  private frameCount: number = 0;
  private fpsUpdateTime: number = 0;
  private currentFPS: number = 0;
  private lastTriangleCount: number | null = null; // null means not yet measured
  private lastDrawCalls: number | null = null; // null means not yet measured
  private statsUpdateCounter: number = 0;
  private readonly STATS_UPDATE_INTERVAL: number = 30; // Update stats every 30 frames
  
  // Offscreen render target for stats collection (prevents visual glitches)
  private statsRenderTarget: THREE.WebGLRenderTarget;

  constructor(canvas: HTMLCanvasElement) {
    // Initialize renderer
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

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

    // Initialize post-processing
    this.composer = new EffectComposer(this.renderer);
    
    // Render pass - renders the scene
    const renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(renderPass);
    
    // Bloom pass - creates glow effect on bright objects
    const resolution = new THREE.Vector2(window.innerWidth, window.innerHeight);
    this.bloomPass = new UnrealBloomPass(
      resolution,
      0.5,   // strength - intensity of bloom
      0.4,   // radius - spread of bloom
      0.85   // threshold - brightness cutoff for bloom
    );
    this.composer.addPass(this.bloomPass);
    
    // Output pass - applies tone mapping and color space conversion
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    // Initialize offscreen render target for stats collection
    // This prevents visual glitches when collecting stats
    this.statsRenderTarget = new THREE.WebGLRenderTarget(
      window.innerWidth,
      window.innerHeight
    );

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
    
    const chunks = this.chunkManager?.getActiveChunkCount() ?? 0;
    const buildQueue = this.chunkManager?.getBuildQueueLength() ?? 0;
    const busyWorkers = this.chunkManager?.getActiveWorkerCount() ?? 0;
    const totalWorkers = this.chunkManager?.getWorkerCount() ?? 0;
    const idleWorkers = totalWorkers - busyWorkers;
    
    const cameraPos = this.camera.position;
    const terrainHeight = this.chunkManager?.getHeightAt(cameraPos.x, cameraPos.z) ?? null;
    const agl = terrainHeight !== null ? (cameraPos.y - terrainHeight).toFixed(2) : 'N/A';
    const terrainH = terrainHeight !== null ? terrainHeight.toFixed(2) : 'N/A';
    
    // Curvature debug info
    const planetRadius = this.celestialSystem?.getPlanetRadius() ?? DEFAULT_PLANET_RADIUS;
    const d = Math.sqrt(cameraPos.x * cameraPos.x + cameraPos.z * cameraPos.z);
    const theta = d / planetRadius;
    const thetaDeg = (theta * 180 / Math.PI).toFixed(1);
    const phi = Math.atan2(cameraPos.z, cameraPos.x);
    const phiDeg = (phi * 180 / Math.PI).toFixed(1);
    
    this.statsElement.innerHTML = `
      <strong>Camera Position</strong><br>
      X: ${cameraPos.x.toFixed(1)}m<br>
      Y: ${cameraPos.y.toFixed(1)}m<br>
      Z: ${cameraPos.z.toFixed(1)}m<br>
      <br>
      <strong>Curvature</strong><br>
      Distance: ${d.toFixed(1)}m<br>
      θ (tilt): ${thetaDeg}°<br>
      φ (dir): ${phiDeg}°<br>
      Radius: ${planetRadius}m<br>
      <br>
      <strong>Render</strong><br>
      FPS: ${this.currentFPS}<br>
      Draw Calls: ${this.lastDrawCalls !== null ? this.lastDrawCalls : '...'}<br>
      Triangles: ${this.lastTriangleCount !== null ? this.lastTriangleCount.toLocaleString() : '...'}<br>
      <br>
      <strong>Terrain</strong><br>
      Chunks: ${chunks} (queue: ${buildQueue})<br>
      Workers: ${idleWorkers}/${totalWorkers}<br>
      Terrain Y: ${terrainH}m<br>
      AGL: ${agl}m
    `;
  }

  /**
   * Set the flight controller for camera updates
   */
  setFlightController(controller: FlightController): void {
    this.flightController = controller;
  }

  /**
   * Set the chunk manager for terrain/rock updates
   */
  setChunkManager(manager: ChunkManager): void {
    this.chunkManager = manager;
  }

  /**
   * Set the celestial system for sun/Earth updates
   */
  setCelestialSystem(system: CelestialSystem): void {
    this.celestialSystem = system;
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
    this.deltaTime = deltaTime;
    
    // Check for debug toggle (O key)
    if (this.inputManager?.isKeyJustPressed('o') && this.chunkManager) {
      this.chunkManager.toggleDebugMode();
    }

    // Check for chunk distance/LOD debug (I key)
    if (this.inputManager?.isKeyJustPressed('i') && this.chunkManager) {
      this.chunkManager.logChunkDistancesAndLods(this.camera.position);
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

    // Update chunk manager with camera position
    if (this.chunkManager) {
      this.chunkManager.update(this.camera.position);
    }

    // Update celestial system (sun, Earth, curvature)
    if (this.celestialSystem) {
      this.celestialSystem.update(this.camera.position, deltaTime);
    }

    // Update input manager (clear just-pressed keys)
    if (this.inputManager) {
      this.inputManager.update();
    }
    
    // Update stats display
    this.updateStatsDisplay(deltaTime);
    
    // Increment frame counter
    this.frameCount++;
  }

  /**
   * Render loop (called every frame)
   */
  private render(): void {
    // Update stats periodically (every N frames) to avoid double rendering every frame
    // EffectComposer uses render targets which don't update renderer.info correctly,
    // so we need to render directly occasionally to get accurate stats
    this.statsUpdateCounter++;
    if (this.statsUpdateCounter >= this.STATS_UPDATE_INTERVAL) {
      this.statsUpdateCounter = 0;
      
      // Reset renderer info and render to offscreen target to get accurate stats
      // This prevents visual glitches since we're not rendering to the main canvas
      this.renderer.info.reset();
      
      // Save current render target
      const previousRenderTarget = this.renderer.getRenderTarget();
      
      // Render to offscreen target for stats collection
      this.renderer.setRenderTarget(this.statsRenderTarget);
      this.renderer.render(this.scene, this.camera);
      
      // Restore previous render target (null = main canvas)
      this.renderer.setRenderTarget(previousRenderTarget);
      
      // Read render stats after offscreen rendering
      // In wireframe mode, Three.js counts lines instead of triangles.
      // We add render.lines / 3 to account for triangles rendered as wireframes.
      this.lastDrawCalls = this.renderer.info.render.calls;
      this.lastTriangleCount = Math.round(this.renderer.info.render.triangles + this.renderer.info.render.lines / 3);
    }
    
    // Render with post-processing composer for final output (every frame)
    this.composer.render(this.deltaTime);
  }

  /**
   * Handle window resize
   */
  private handleResize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    
    // Update bloom pass resolution
    this.bloomPass.resolution.set(width, height);
    
    // Update stats render target size
    this.statsRenderTarget.setSize(width, height);
  }

  /**
   * Cleanup resources
   */
  dispose(): void {
    this.stop();
    if (this.chunkManager) {
      this.chunkManager.dispose();
    }
    if (this.celestialSystem) {
      this.celestialSystem.dispose();
    }
    if (this.statsElement) {
      this.statsElement.remove();
    }
    this.statsRenderTarget.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
