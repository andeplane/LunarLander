import * as THREE from 'three';
import { EarthMaterial } from '../shaders/EarthMaterial';
import { SunMaterial } from '../shaders/SunMaterial';

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
  sunIntensity: 2.0,
  earthDistance: 40000,
  earthSize: 1500,       // Earth appears ~4x larger than sun from Moon
  sunAzimuth: Math.PI * 0.25,      // 45 degrees from north
  sunElevation: Math.PI * 0.35,    // 63 degrees above horizon
  earthAzimuth: Math.PI * 1.2,     // Opposite-ish from sun
  earthElevation: Math.PI * 0.3,   // 54 degrees above horizon
};

export class CelestialSystem {
  private scene: THREE.Scene;
  private config: Required<CelestialConfig>;
  
  // Planet radius for curvature (synced with terrain shader)
  private planetRadius: number = 5000; // Default matches MoonMaterial default
  
  // Celestial objects
  private sunMesh!: THREE.Mesh;
  private sunMaterial!: SunMaterial;
  private earthMesh!: THREE.Mesh;
  private earthMaterial!: EarthMaterial;
  private sunLight!: THREE.DirectionalLight;
  private ambientLight!: THREE.AmbientLight;
  
  // Container that rotates with curvature
  private celestialContainer: THREE.Group;
  
  // Base skybox rotation (set by Skybox class - Milky Way overhead)
  private readonly baseSkyboxRotation = new THREE.Euler(Math.PI / 2, 0, 0);
  private readonly baseSkyboxQuaternion = new THREE.Quaternion();
  
  // Reusable objects for calculations (avoid per-frame allocations)
  private readonly sunDirection = new THREE.Vector3();
  private readonly sunWorldPos = new THREE.Vector3();
  private readonly earthWorldPos = new THREE.Vector3();
  private readonly curvatureQuaternion = new THREE.Quaternion();
  private readonly rotationAxis = new THREE.Vector3();
  
  constructor(scene: THREE.Scene, config: CelestialConfig = {}) {
    this.scene = scene;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.celestialContainer = new THREE.Group();
    this.celestialContainer.name = 'CelestialSystem';
    
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
   * Initialize the directional light from the sun
   */
  private initializeLighting(): void {
    // Main directional light (sunlight)
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
    // so it maintains correct world-space direction
    this.scene.add(this.sunLight);
    
    // Minimal ambient light (earthshine + starlight)
    this.ambientLight = new THREE.AmbientLight(0x111122, 0.1);
    this.scene.add(this.ambientLight);
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
   * Update sun direction uniform for Earth shader
   */
  private updateSunDirection(): void {
    // Calculate direction from Earth to Sun in WORLD SPACE
    // Must use getWorldPosition() to account for container rotation and Earth's own rotation
    this.sunMesh.getWorldPosition(this.sunWorldPos);
    this.earthMesh.getWorldPosition(this.earthWorldPos);
    
    this.sunDirection.copy(this.sunWorldPos).sub(this.earthWorldPos).normalize();
    
    // Update Earth material with world-space sun direction
    this.earthMaterial.setSunDirection(this.sunDirection);
    
    // Update directional light position
    this.sunLight.position.copy(this.sunWorldPos);
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
    
    // Update sun direction for Earth lighting
    this.updateSunDirection();
    
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
  }
  
  /**
   * Get the current planet radius
   */
  getPlanetRadius(): number {
    return this.planetRadius;
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
   * Get the sun direction in world space
   */
  getSunDirection(): THREE.Vector3 {
    return this.sunDirection.clone();
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
    this.ambientLight.dispose();
    this.scene.remove(this.celestialContainer);
    this.scene.remove(this.sunLight);
    this.scene.remove(this.ambientLight);
  }
}
