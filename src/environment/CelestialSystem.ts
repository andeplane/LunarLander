import * as THREE from 'three';
import { EarthMaterial } from '../shaders/EarthMaterial';
import { SunMaterial } from '../shaders/SunMaterial';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';

/**
 * CelestialSystem manages the sun, Earth, starfield, and directional lighting
 * with Moon curvature simulation.
 * 
 * Key features:
 * - Sun: Glowing sphere that drives directional light
 * - Earth: Realistic day/night cycle based on sun direction
 * - Curvature: As player moves, the entire sky (sun, Earth, stars) rotates
 *              to simulate traveling on a curved planetary surface
 * 
 * LIGHTING ARCHITECTURE:
 * Three light sources, all respecting curvature rotation:
 * 1. Sun Light (DirectionalLight): Main light from sun's world position
 * 2. Earth Light (DirectionalLight): Weak bluish earthshine from Earth's world position
 * 3. Spaceship Light (PointLight): Local illumination attached to camera
 * 
 * IMPORTANT: Sun and Earth lights use getWorldPosition() to get positions
 * AFTER curvature rotation is applied to the celestialContainer. This ensures
 * lighting direction matches the visual positions of celestial objects.
 * 
 * The curvature uses the same formula as the terrain shader:
 * - θ (theta) = distance / planetRadius (rotation angle)
 * - φ (phi) = atan2(z, x) (direction of travel)
 * 
 * Flying a full circumference (2πR) brings the sky back to its original position.
 */

export interface CelestialConfig {
  // Sun configuration
  sunDistance?: number;      // Distance from camera (visual only)
  sunSize?: number;          // Visual size of sun sphere
  sunIntensity?: number;     // Light intensity
  
  // Earth configuration
  earthDistance?: number;    // Distance from camera (visual only)
  earthSize?: number;        // Visual size of Earth sphere
  
  // Earthshine (reflected light from Earth)
  earthshineMultiplier?: number;  // Multiplier of sun intensity (0-1)
  
  // Spaceship light (local illumination)
  spaceshipLightIntensity?: number;
  spaceshipLightRange?: number;   // Range in meters
  
  // Flashlight (directional cone pointing where camera looks)
  flashlightIntensity?: number;
  flashlightRange?: number;       // Range in meters
  flashlightAngle?: number;       // Cone angle in radians
  flashlightPenumbra?: number;    // Edge softness (0-1)
  
  // Initial positions (angles in radians)
  // Measured from the reference "up" at origin
  sunAzimuth?: number;       // Horizontal angle
  sunElevation?: number;     // Vertical angle above horizon
  earthAzimuth?: number;
  earthElevation?: number;
}

const DEFAULT_CONFIG: Required<CelestialConfig> = {
  sunDistance: 50000,    // Far enough to look like skybox object
  sunSize: 500,          // Visual size
  sunIntensity: 5.0,
  earthDistance: 40000,
  earthSize: 1500,       // Earth appears ~4x larger than sun from Moon
  earthshineMultiplier: 0.15,
  spaceshipLightIntensity: 5,     // Default intensity
  spaceshipLightRange: 200,        // 200m range
  flashlightIntensity: 10,         // Default intensity
  flashlightRange: 500,            // 500m range
  flashlightAngle: Math.PI / 8,    // ~22.5 degree cone
  flashlightPenumbra: 0.3,         // Soft edges
  sunAzimuth: Math.PI * 0.25,      // 45 degrees from north
  sunElevation: Math.PI * 0.35,    // 63 degrees above horizon
  earthAzimuth: Math.PI * 1.2,     // Opposite-ish from sun
  earthElevation: Math.PI * 0.3,   // 54 degrees above horizon
};

export class CelestialSystem {
  private scene: THREE.Scene;
  private config: Required<CelestialConfig>;
  
  // Planet radius for curvature (synced with terrain shader)
  private planetRadius: number;
  
  // Celestial objects
  private sunMesh!: THREE.Mesh;
  private sunMaterial!: SunMaterial;
  private earthMesh!: THREE.Mesh;
  private earthMaterial!: EarthMaterial;
  
  // Lighting - four sources
  private sunLight!: THREE.DirectionalLight;      // Main directional light from sun
  private earthLight!: THREE.DirectionalLight;    // Weak bluish earthshine
  private spaceshipLight!: THREE.PointLight;      // Local illumination on camera
  private flashlight!: THREE.SpotLight;           // Directional cone pointing where camera looks
  private flashlightTarget: THREE.Object3D;       // Target for flashlight direction
  
  // Camera reference for spaceship light positioning
  private camera: THREE.Camera | null = null;
  
  // Render request callback
  private requestRender: () => void;
  
  // Container that rotates with curvature
  private celestialContainer: THREE.Group;
  
  // Base skybox rotation (set by Skybox class - Milky Way overhead)
  private readonly baseSkyboxRotation = new THREE.Euler(Math.PI / 2, 0, 0);
  private readonly baseSkyboxQuaternion = new THREE.Quaternion();
  
  // Reusable objects for calculations (avoid per-frame allocations)
  private readonly sunDirection = new THREE.Vector3();
  private readonly curvatureQuaternion = new THREE.Quaternion();
  private readonly rotationAxis = new THREE.Vector3();
  
  // Reusable vectors for world position calculations
  private readonly sunWorldPos = new THREE.Vector3();
  private readonly earthWorldPos = new THREE.Vector3();
  
  constructor(scene: THREE.Scene, requestRender: () => void, config: CelestialConfig = {}) {
    this.scene = scene;
    this.requestRender = requestRender;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.planetRadius = DEFAULT_PLANET_RADIUS;
    this.celestialContainer = new THREE.Group();
    this.celestialContainer.name = 'CelestialSystem';
    
    // Create flashlight target (SpotLight needs a target to point at)
    this.flashlightTarget = new THREE.Object3D();
    this.flashlightTarget.name = 'FlashlightTarget';
    
    // Store base skybox rotation as quaternion for composition
    this.baseSkyboxQuaternion.setFromEuler(this.baseSkyboxRotation);
    
    this.initializeSun();
    this.initializeEarth();
    this.initializeLighting();
    
    this.scene.add(this.celestialContainer);
    
    // Initial update to position everything
    this.updateSunDirection();
  }
  
  /**
   * Set camera reference for spaceship light positioning
   */
  setCamera(camera: THREE.Camera): void {
    this.camera = camera;
  }
  
  /**
   * Create the sun mesh
   */
  private initializeSun(): void {
    const geometry = new THREE.SphereGeometry(this.config.sunSize, 32, 32);
    this.sunMaterial = new SunMaterial({
      color: 0xffffee,
      intensity: 3.0,
    });
    
    this.sunMesh = new THREE.Mesh(geometry, this.sunMaterial);
    this.sunMesh.name = 'Sun';
    
    // Position sun based on azimuth and elevation
    this.positionCelestialBody(
      this.sunMesh,
      this.config.sunAzimuth,
      this.config.sunElevation,
      this.config.sunDistance
    );
    
    // Put sun on bloom layer
    this.sunMesh.layers.enable(1);
    
    this.celestialContainer.add(this.sunMesh);
  }
  
  /**
   * Create the Earth mesh with realistic shader
   */
  private initializeEarth(): void {
    const geometry = new THREE.SphereGeometry(this.config.earthSize, 64, 64);
    this.earthMaterial = new EarthMaterial({
      dayMapPath: '/textures/8k_earth_daymap.jpg',
      nightMapPath: '/textures/8k_earth_nightmap.jpg',
      cloudsMapPath: '/textures/8k_earth_clouds.jpg',
      specularMapPath: '/textures/8k_earth_specular_map.jpg',
    });
    
    this.earthMesh = new THREE.Mesh(geometry, this.earthMaterial);
    this.earthMesh.name = 'Earth';
    
    // Position Earth based on azimuth and elevation
    this.positionCelestialBody(
      this.earthMesh,
      this.config.earthAzimuth,
      this.config.earthElevation,
      this.config.earthDistance
    );
    
    // Tilt Earth's axis (23.5 degrees)
    this.earthMesh.rotation.z = THREE.MathUtils.degToRad(23.5);
    
    this.celestialContainer.add(this.earthMesh);
  }
  
  /**
   * Initialize the three light sources:
   * 1. Sun Light - main directional light from sun's world position
   * 2. Earth Light - weak bluish earthshine from Earth's world position
   * 3. Spaceship Light - point light attached to camera
   * 
   * IMPORTANT: Sun and Earth light positions are updated each frame using
   * getWorldPosition() AFTER curvature rotation. This ensures light direction
   * matches the visual position of celestial objects in the sky.
   */
  private initializeLighting(): void {
    // 1. Main directional light from sun
    this.sunLight = new THREE.DirectionalLight(0xffffff, this.config.sunIntensity);
    this.sunLight.name = 'SunLight';
    
    // Shadow configuration for sun
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.width = 2048;
    this.sunLight.shadow.mapSize.height = 2048;
    this.sunLight.shadow.camera.near = 0.5;
    this.sunLight.shadow.camera.far = 5000;
    this.sunLight.shadow.camera.left = -2000;
    this.sunLight.shadow.camera.right = 2000;
    this.sunLight.shadow.camera.top = 2000;
    this.sunLight.shadow.camera.bottom = -2000;
    
    // Light is positioned at scene root (not in container)
    // Position will be updated each frame from sun's world position
    this.scene.add(this.sunLight);
    
    // 2. Earthshine - weak reflected light from Earth
    // Subtle blue-gray tint (less saturated than before), much weaker than sunlight
    const earthshineIntensity = this.config.sunIntensity * this.config.earthshineMultiplier;
    this.earthLight = new THREE.DirectionalLight(0xaabbcc, earthshineIntensity);
    this.earthLight.name = 'EarthLight';
    // Position will be updated each frame from Earth's world position
    this.scene.add(this.earthLight);
    
    // 3. Spaceship light - local point light attached to camera
    this.spaceshipLight = new THREE.PointLight(
      0xffffff,
      this.config.spaceshipLightIntensity,
      this.config.spaceshipLightRange,
      2 // Quadratic decay for realistic falloff
    );
    this.spaceshipLight.name = 'SpaceshipLight';
    // Position will be updated each frame to match camera
    this.scene.add(this.spaceshipLight);
    
    // 4. Flashlight - SpotLight that points where camera looks
    this.flashlight = new THREE.SpotLight(
      0xffffff,
      this.config.flashlightIntensity,
      this.config.flashlightRange,
      this.config.flashlightAngle,
      this.config.flashlightPenumbra,
      2 // Quadratic decay
    );
    this.flashlight.name = 'Flashlight';
    this.flashlight.target = this.flashlightTarget;
    // Position and target will be updated each frame based on camera
    this.scene.add(this.flashlight);
    this.scene.add(this.flashlightTarget);
  }
  
  /**
   * Position a celestial body using spherical coordinates
   */
  private positionCelestialBody(
    mesh: THREE.Mesh,
    azimuth: number,
    elevation: number,
    distance: number
  ): void {
    // Convert spherical to cartesian
    // Azimuth is rotation around Y axis
    // Elevation is angle above XZ plane
    const cosElevation = Math.cos(elevation);
    mesh.position.set(
      Math.sin(azimuth) * cosElevation * distance,
      Math.sin(elevation) * distance,
      Math.cos(azimuth) * cosElevation * distance
    );
  }
  
  /**
   * Calculate curvature rotation based on camera position
   * Uses the same formula as terrain shader: θ = d / R
   * 
   * @param cameraPosition Camera world position
   */
  private calculateCurvatureRotation(cameraPosition: THREE.Vector3): void {
    const x = cameraPosition.x;
    const z = cameraPosition.z;
    
    // Horizontal distance from origin
    const d = Math.sqrt(x * x + z * z);
    
    // Rotation angle (same formula as shader)
    // θ = d / R where R is planetRadius
    // At d = 2πR, θ = 2π (full circle, back to start)
    const theta = d / this.planetRadius;
    
    if (theta < 0.0001) {
      // At origin, no rotation needed
      this.curvatureQuaternion.identity();
      return;
    }
    
    // Direction of travel (azimuth angle)
    const phi = Math.atan2(z, x);
    
    // The rotation axis is perpendicular to the travel direction
    // If traveling in direction phi, we tilt around axis at phi + 90°
    // This axis lies in the XZ plane
    this.rotationAxis.set(-Math.sin(phi), 0, Math.cos(phi));
    
    // Create rotation: tilt by theta around the perpendicular axis
    this.curvatureQuaternion.setFromAxisAngle(this.rotationAxis, theta);
  }
  
  /**
   * Update sun direction uniform for Earth shader and light positions
   * 
   * CRITICAL: Uses getWorldPosition() to get positions AFTER curvature
   * rotation is applied to celestialContainer. This ensures:
   * - Earth shader receives correct sun direction for day/night cycle
   * - DirectionalLight comes FROM the visual sun position
   * - Earthshine comes FROM the visual Earth position
   */
  private updateSunDirection(): void {
    // Get positions in WORLD SPACE (after container rotation)
    // This is critical for correct lighting direction after curvature rotation
    this.sunMesh.getWorldPosition(this.sunWorldPos);
    this.earthMesh.getWorldPosition(this.earthWorldPos);
    
    // Calculate direction FROM Earth TO Sun (for Earth shader)
    // Earth's day/night depends on which side faces the sun
    this.sunDirection.copy(this.sunWorldPos).sub(this.earthWorldPos).normalize();
    
    // Update Earth material with world-space sun direction
    this.earthMaterial.setSunDirection(this.sunDirection);
    
    // Update sun directional light position
    // Light should come FROM the sun's world position
    this.sunLight.position.copy(this.sunWorldPos);
    
    // Update earth directional light position
    // Earthshine comes FROM Earth's world position
    this.earthLight.position.copy(this.earthWorldPos);
  }
  
  /**
   * Update the celestial system
   * Call this every frame with the camera position
   * 
   * @param cameraPosition Camera world position
   * @param deltaTime Time since last frame (seconds)
   */
  update(cameraPosition: THREE.Vector3, deltaTime: number = 0.016): void {
    // Calculate curvature rotation based on position
    this.calculateCurvatureRotation(cameraPosition);
    
    // Apply curvature rotation to celestial container
    this.celestialContainer.quaternion.copy(this.curvatureQuaternion);
    
    // Move container to follow camera (celestial objects are at "infinity")
    this.celestialContainer.position.copy(cameraPosition);
    
    // Apply curvature rotation to skybox (stars)
    // Compute Euler angles directly instead of quaternion composition
    // Base rotation: PI/2 around X (Milky Way overhead)
    // Curvature tilt: decompose into X and Z components based on travel direction (phi)
    const x = cameraPosition.x;
    const z = cameraPosition.z;
    const d = Math.sqrt(x * x + z * z);
    const theta = d / this.planetRadius;
    const phi = d > 0.001 ? Math.atan2(z, x) : 0;
    
    // Decompose tilt into X and Z rotations
    // Moving in +X (phi=0): tilt around Z axis
    // Moving in +Z (phi=90°): tilt around -X axis
    const tiltX = -theta * Math.sin(phi);
    const tiltZ = theta * Math.cos(phi);
    
    // Apply to background rotation (base X rotation + tilt components)
    // Note: This is an approximation that works for small-ish theta
    this.scene.backgroundRotation.set(
      Math.PI / 2 + tiltX,  // Base + X tilt
      0,                     // No Y rotation
      tiltZ                  // Z tilt
    );
    
    // Update sun direction for Earth lighting and directional light positions
    // Must be called AFTER curvature rotation is applied to container
    this.updateSunDirection();
    
    // Calculate sun elevation relative to local horizon and fade light intensity
    // This prevents light from reaching terrain when sun is below the virtual curved surface
    const sunLength = this.sunWorldPos.length();
    if (sunLength > 0.001) {
      // Calculate elevation angle: y component normalized by distance
      // Positive = above horizon, negative = below horizon
      const sunElevation = this.sunWorldPos.y / sunLength;
      
      // Smooth fade from -0.1 (fully below) to 0.1 (fully above horizon)
      // THREE.MathUtils.smoothstep signature is (x, min, max)
      const horizonFade = THREE.MathUtils.smoothstep(sunElevation, -0.1, 0.1);
      
      // Apply fade to sun light intensity only
      this.sunLight.intensity = this.config.sunIntensity * horizonFade;
      
      // DON'T fade earthshine with sun - Earth is a separate light source
      // that may still be above the horizon when the sun is below
      // Earthshine intensity remains constant based on config
    }
    
    // Update spaceship light to follow camera
    if (this.camera) {
      this.spaceshipLight.position.copy(this.camera.position);
      
      // Update flashlight position and direction
      this.flashlight.position.copy(this.camera.position);
      // Get camera forward direction and place target 100m ahead
      const forward = new THREE.Vector3(0, 0, -1);
      forward.applyQuaternion(this.camera.quaternion);
      this.flashlightTarget.position.copy(this.camera.position).add(forward.multiplyScalar(100));
    }
    
    // Slowly rotate Earth (one rotation per ~24 hours scaled down)
    this.earthMesh.rotation.y += deltaTime * 0.01;
  }
  
  /**
   * Set the planet radius for curvature calculation
   * Should match the terrain shader's planetRadius
   * 
   * @param radius Planet radius in meters
   */
  setPlanetRadius(radius: number): void {
    this.planetRadius = radius;
    this.requestRender();
  }
  
  /**
   * Get the current planet radius
   */
  getPlanetRadius(): number {
    return this.planetRadius;
  }
  
  // ============================================
  // Light intensity getters/setters for UI control
  // ============================================
  
  /**
   * Get sun light intensity
   */
  get sunIntensity(): number {
    return this.sunLight.intensity;
  }
  
  /**
   * Set sun light intensity
   */
  set sunIntensity(value: number) {
    this.config.sunIntensity = value;
    // sunLight.intensity will be updated in update() with horizon fade applied
    // Update earthshine based on base config value (not affected by horizon fade)
    this.earthLight.intensity = value * this.config.earthshineMultiplier;
    this.requestRender();
  }
  
  /**
   * Get earthshine multiplier (relative to sun)
   */
  get earthshineMultiplier(): number {
    return this.config.earthshineMultiplier;
  }
  
  /**
   * Set earthshine multiplier (relative to sun)
   */
  set earthshineMultiplier(value: number) {
    this.config.earthshineMultiplier = value;
    // Use config.sunIntensity (base value) not sunLight.intensity (which is modified by horizon fade)
    // Earthshine is proportional to base sunlight regardless of sun's position/visibility
    this.earthLight.intensity = this.config.sunIntensity * value;
    this.requestRender();
  }
  
  /**
   * Get spaceship light intensity
   */
  get spaceshipLightIntensity(): number {
    return this.spaceshipLight.intensity;
  }
  
  /**
   * Set spaceship light intensity
   */
  set spaceshipLightIntensity(value: number) {
    this.spaceshipLight.intensity = value;
    this.requestRender();
  }
  
  /**
   * Get spaceship light range
   */
  get spaceshipLightRange(): number {
    return this.spaceshipLight.distance;
  }
  
  /**
   * Set spaceship light range
   */
  set spaceshipLightRange(value: number) {
    this.spaceshipLight.distance = value;
    this.requestRender();
  }
  
  /**
   * Get flashlight intensity
   */
  get flashlightIntensity(): number {
    return this.flashlight.intensity;
  }
  
  /**
   * Set flashlight intensity
   */
  set flashlightIntensity(value: number) {
    this.flashlight.intensity = value;
    this.requestRender();
  }
  
  /**
   * Get flashlight range
   */
  get flashlightRange(): number {
    return this.flashlight.distance;
  }
  
  /**
   * Set flashlight range
   */
  set flashlightRange(value: number) {
    this.flashlight.distance = value;
    this.requestRender();
  }
  
  /**
   * Get flashlight angle (cone width in radians)
   */
  get flashlightAngle(): number {
    return this.flashlight.angle;
  }
  
  /**
   * Set flashlight angle (cone width in radians)
   */
  set flashlightAngle(value: number) {
    this.flashlight.angle = value;
    this.requestRender();
  }
  
  /**
   * Get the sun mesh (for bloom layer configuration)
   */
  getSunMesh(): THREE.Mesh {
    return this.sunMesh;
  }
  
  /**
   * Get the Earth mesh
   */
  getEarthMesh(): THREE.Mesh {
    return this.earthMesh;
  }
  
  /**
   * Get the directional light (sun)
   */
  getSunLight(): THREE.DirectionalLight {
    return this.sunLight;
  }
  
  /**
   * Get the sun direction in world space (from Earth to Sun, for Earth shader)
   */
  getSunDirection(): THREE.Vector3 {
    return this.sunDirection.clone();
  }

  /**
   * Get the sun direction for terrain lighting (direction TO the sun from terrain surface)
   * This is the normalized sun world position, representing the direction to the sun
   */
  getSunDirectionForTerrain(): THREE.Vector3 {
    return this.sunWorldPos.clone().normalize();
  }
  
  /**
   * Set sun position using azimuth and elevation
   */
  setSunPosition(azimuth: number, elevation: number): void {
    this.config.sunAzimuth = azimuth;
    this.config.sunElevation = elevation;
    this.positionCelestialBody(
      this.sunMesh,
      azimuth,
      elevation,
      this.config.sunDistance
    );
    this.updateSunDirection();
  }
  
  /**
   * Set Earth position using azimuth and elevation
   */
  setEarthPosition(azimuth: number, elevation: number): void {
    this.config.earthAzimuth = azimuth;
    this.config.earthElevation = elevation;
    this.positionCelestialBody(
      this.earthMesh,
      azimuth,
      elevation,
      this.config.earthDistance
    );
  }
  
  /**
   * Dispose of all resources
   */
  dispose(): void {
    this.sunMesh.geometry.dispose();
    this.sunMaterial.dispose();
    this.earthMesh.geometry.dispose();
    this.earthMaterial.dispose();
    this.sunLight.dispose();
    this.earthLight.dispose();
    this.spaceshipLight.dispose();
    this.flashlight.dispose();
    this.scene.remove(this.celestialContainer);
    this.scene.remove(this.sunLight);
    this.scene.remove(this.earthLight);
    this.scene.remove(this.spaceshipLight);
    this.scene.remove(this.flashlight);
    this.scene.remove(this.flashlightTarget);
  }
}
