import * as THREE from 'three';
import { EarthMaterial } from '../shaders/EarthMaterial';
import { SunMaterial } from '../shaders/SunMaterial';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';
import { applyCurvatureStep, directionFromObserver } from './celestialMath';

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
 * The curvature rotation is accumulated incrementally (parallel transport):
 * each frame the sky rotates by dθ = stepDistance / planetRadius around the
 * horizontal axis perpendicular to the direction of travel. This stays smooth
 * for any flight path (tangential flight and origin crossings included) and
 * flying a straight line of length 2πR brings the sky back to its original
 * orientation.
 */

export interface CelestialConfig {
  // Sun configuration
  sunDistance: number;      // Distance from camera (visual only)
  sunSize: number;          // Visual size of sun sphere
  sunIntensity: number;     // Light intensity
  
  // Earth configuration
  earthDistance: number;    // Distance from camera (visual only)
  earthSize: number;        // Visual size of Earth sphere
  
  // Earthshine (reflected light from Earth)
  earthshineMultiplier: number;  // Multiplier of sun intensity (0-1)
  
  // Spaceship light (local illumination)
  spaceshipLightIntensity: number;
  spaceshipLightRange: number;   // Range in meters
  
  // Flashlight (directional cone pointing where camera looks)
  flashlightIntensity: number;
  flashlightRange: number;       // Range in meters
  flashlightAngle: number;       // Cone angle in radians
  flashlightPenumbra: number;    // Edge softness (0-1)
  
  // Initial positions (angles in radians)
  // Measured from the reference "up" at origin
  sunAzimuth: number;       // Horizontal angle
  sunElevation: number;     // Vertical angle above horizon
  earthAzimuth: number;
  earthElevation: number;
  
  // Loading callbacks
  onEarthTextureLoad?: () => void; // Called for each Earth texture load (4 times)
  onEarthTextureError?: (path: string) => void; // Called for each Earth texture load failure
}

const DEFAULT_CONFIG: CelestialConfig = {
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
  private config: CelestialConfig;
  
  // Planet radius for curvature (synced with terrain shader)
  private planetRadius: number;
  
  // Celestial objects
  private sunMesh!: THREE.Mesh;
  private sunMaterial!: SunMaterial;
  private earthMesh!: THREE.Mesh;
  private earthMaterial!: EarthMaterial;
  private skyboxMesh!: THREE.Mesh;
  private skyboxTexture: THREE.Texture | null = null;
  
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
  
  // Reusable objects for calculations (avoid per-frame allocations)
  private readonly sunDirection = new THREE.Vector3();
  private readonly curvatureQuaternion = new THREE.Quaternion();
  private readonly flashlightForward = new THREE.Vector3();

  // Reusable vectors for world position calculations
  private readonly sunWorldPos = new THREE.Vector3();
  private readonly earthWorldPos = new THREE.Vector3();

  // Sun/Earth offsets relative to the observer (camera). The celestial
  // container follows the camera, so world positions include the camera
  // position; these observer-relative offsets are what lighting math needs.
  private readonly sunOffset = new THREE.Vector3();
  private readonly earthOffset = new THREE.Vector3();

  // Previous camera position for incremental curvature (parallel transport)
  private readonly prevCameraPosition = new THREE.Vector3();

  // Reusable output vector for getSunDirectionForTerrain (called every frame)
  private readonly sunDirectionForTerrain = new THREE.Vector3();
  private hasPrevCameraPosition = false;

  // Earth spin accumulated since the last requested render; used to request
  // renders often enough that the rotation never visibly snaps after idling
  private pendingEarthRotation = 0;

  // Current sun horizon fade (0 = below horizon, 1 = above horizon)
  private currentSunHorizonFade: number = 1.0;
  
  constructor(scene: THREE.Scene, requestRender: () => void, config: Partial<CelestialConfig> = {}) {
    this.scene = scene;
    this.requestRender = requestRender;
    this.config = { 
      ...DEFAULT_CONFIG, 
      ...config,
    };
    this.planetRadius = DEFAULT_PLANET_RADIUS;
    this.celestialContainer = new THREE.Group();
    this.celestialContainer.name = 'CelestialSystem';
    
    // Create flashlight target (SpotLight needs a target to point at)
    this.flashlightTarget = new THREE.Object3D();
    this.flashlightTarget.name = 'FlashlightTarget';
    
    this.initializeSun();
    this.initializeEarth();
    this.initializeSkybox();
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
    this.sunMesh.frustumCulled = false; // Disable frustum culling to prevent lag on first view
    
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
      dayMapPath: `${import.meta.env.BASE_URL}textures/2k_earth_daymap.jpg`,
      nightMapPath: `${import.meta.env.BASE_URL}textures/2k_earth_nightmap.jpg`,
      cloudsMapPath: `${import.meta.env.BASE_URL}textures/2k_earth_clouds.jpg`,
      specularMapPath: `${import.meta.env.BASE_URL}textures/2k_earth_specular_map.jpg`,
      onTextureLoad: this.config.onEarthTextureLoad,
      onTextureError: this.config.onEarthTextureError,
    });
    
    this.earthMesh = new THREE.Mesh(geometry, this.earthMaterial);
    this.earthMesh.name = 'Earth';
    this.earthMesh.frustumCulled = false; // Disable frustum culling to prevent lag on first view
    
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
   * Initialize the skybox as a large inverted sphere mesh
   * This is added to the celestialContainer so it rotates with curvature
   * just like sun and Earth - no Euler conversion issues!
   */
  private initializeSkybox(): void {
    // Create a large sphere that encompasses everything
    // Using BackSide so we see the inside of the sphere
    const geometry = new THREE.SphereGeometry(90000, 64, 32);
    const material = new THREE.MeshBasicMaterial({
      color: 0x000000, // Black until texture loads
      side: THREE.BackSide,
      depthWrite: false, // Don't write to depth buffer so other objects render in front
    });
    
    this.skyboxMesh = new THREE.Mesh(geometry, material);
    this.skyboxMesh.name = 'Skybox';
    this.skyboxMesh.frustumCulled = false;
    this.skyboxMesh.renderOrder = -Infinity; // Render first (behind everything)
    
    // Apply the base rotation to position Milky Way overhead (PI/2 around X)
    // This is "baked in" to the mesh, so the container's curvature rotation
    // will be applied on top of it correctly
    this.skyboxMesh.rotation.x = Math.PI / 2;
    
    // Clear scene.background so our mesh is visible
    this.scene.background = null;
    
    this.celestialContainer.add(this.skyboxMesh);
  }
  
  /**
   * Load the skybox texture
   * @param texturePath Path to the equirectangular starfield image
   * @param onLoad Optional callback when texture loads successfully
   * @param onError Optional callback when texture fails to load
   */
  loadSkyboxTexture(texturePath: string, onLoad?: () => void, onError?: () => void): void {
    const loader = new THREE.TextureLoader();
    
    loader.load(
      texturePath,
      (texture) => {
        // Configure for correct display on sphere interior
        texture.colorSpace = THREE.SRGBColorSpace;
        
        // Apply to skybox material
        const material = this.skyboxMesh.material as THREE.MeshBasicMaterial;
        material.map = texture;
        material.color.setHex(0xffffff); // Remove black tint
        material.needsUpdate = true;
        
        this.skyboxTexture = texture;
        this.requestRender();
        
        console.log('Skybox texture loaded successfully');
        
        // Call onLoad callback if provided
        if (onLoad) {
          onLoad();
        }
      },
      undefined,
      (error) => {
        console.error('Failed to load skybox texture:', error);

        // Call onError callback if provided
        if (onError) {
          onError();
        }
      }
    );
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

    // Note: no shadow configuration. Shadows are not used in this project
    // (renderer.shadowMap is never enabled and no mesh casts/receives shadows).

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
   * Update the curvature rotation incrementally from camera movement
   * (parallel transport).
   *
   * Each step rotates the sky by dθ = stepDistance / planetRadius around the
   * horizontal axis perpendicular to the movement direction. Deriving the
   * rotation from the current position relative to the world origin (the old
   * approach) is only correct for radial travel: tangential flight swings the
   * rotation axis while θ stays constant and crossing near the origin flips
   * the axis, which made the sky slew or snap intermittently while flying.
   * The incremental form is smooth for any path.
   *
   * @param cameraPosition Camera world position
   */
  private updateCurvatureRotation(cameraPosition: THREE.Vector3): void {
    if (!this.hasPrevCameraPosition) {
      // First update: establish the reference position, keep identity rotation
      this.prevCameraPosition.copy(cameraPosition);
      this.hasPrevCameraPosition = true;
      return;
    }

    const dx = cameraPosition.x - this.prevCameraPosition.x;
    const dz = cameraPosition.z - this.prevCameraPosition.z;
    this.prevCameraPosition.copy(cameraPosition);

    applyCurvatureStep(this.curvatureQuaternion, dx, dz, this.planetRadius);
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

    // The container follows the camera, so world positions include the camera
    // position. Subtract the container (observer) position to get the pure
    // observer-relative offsets used for all directional lighting math.
    this.sunOffset.copy(this.sunWorldPos).sub(this.celestialContainer.position);
    this.earthOffset.copy(this.earthWorldPos).sub(this.celestialContainer.position);

    // Calculate direction FROM Earth TO Sun (for Earth shader)
    // Earth's day/night depends on which side faces the sun
    // (the shared camera offset cancels in the subtraction)
    this.sunDirection.copy(this.sunWorldPos).sub(this.earthWorldPos).normalize();

    // Update Earth material with world-space sun direction
    this.earthMaterial.setSunDirection(this.sunDirection);

    // Update sun directional light position
    // DirectionalLight direction is position -> target (at the origin), so use
    // the observer-relative offset: copying the raw world position would mix
    // the camera position into the light direction (~4.6 deg error 4 km out)
    this.sunLight.position.copy(this.sunOffset);

    // Update earth directional light position (same reasoning as sun light)
    this.earthLight.position.copy(this.earthOffset);
  }
  
  /**
   * Update the celestial system
   * Call this every frame with the camera position
   * 
   * @param cameraPosition Camera world position
   * @param deltaTime Time since last frame (seconds)
   */
  update(cameraPosition: THREE.Vector3, deltaTime: number): void {
    // Accumulate curvature rotation from camera movement (parallel transport)
    this.updateCurvatureRotation(cameraPosition);

    // Apply curvature rotation to celestial container
    this.celestialContainer.quaternion.copy(this.curvatureQuaternion);
    
    // Move container to follow camera (celestial objects are at "infinity")
    // The skybox mesh is inside the container, so it automatically follows the camera
    // and rotates with the same curvature as sun/Earth - no Euler conversion needed!
    this.celestialContainer.position.copy(cameraPosition);
    
    // Update sun direction for Earth lighting and directional light positions
    // Must be called AFTER curvature rotation is applied to container
    this.updateSunDirection();
    
    // Calculate sun elevation relative to local horizon and fade light intensity
    // This prevents light from reaching terrain when sun is below the virtual curved surface
    // Uses the observer-relative offset: the raw world position includes the
    // camera position and would fade the sun at the wrong elevation
    const sunLength = this.sunOffset.length();
    if (sunLength > 0.001) {
      // Calculate elevation angle: y component normalized by distance
      // Positive = above horizon, negative = below horizon
      const sunElevation = this.sunOffset.y / sunLength;
      
      // Smooth fade from -0.1 (fully below) to 0.1 (fully above horizon)
      // THREE.MathUtils.smoothstep signature is (x, min, max)
      const horizonFade = THREE.MathUtils.smoothstep(sunElevation, -0.1, 0.1);
      
      // Store for external access
      this.currentSunHorizonFade = horizonFade;
      
      // Apply fade to sun light intensity only
      this.sunLight.intensity = this.config.sunIntensity * horizonFade;
      
      // DON'T fade earthshine with sun - Earth is a separate light source
      // that may still be above the horizon when the sun is below
      // Earthshine intensity remains constant based on config
    } else {
      // Sun is at origin or invalid - treat as below horizon
      this.currentSunHorizonFade = 0.0;
      this.sunLight.intensity = 0.0;
    }
    
    // Update spaceship light to follow camera
    if (this.camera) {
      this.spaceshipLight.position.copy(this.camera.position);
      
      // Update flashlight position and direction
      this.flashlight.position.copy(this.camera.position);
      // Get camera forward direction and place target 100m ahead
      this.flashlightForward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      this.flashlightTarget.position
        .copy(this.camera.position)
        .add(this.flashlightForward.multiplyScalar(100));
    }

    // Slowly rotate Earth (one rotation per ~24 hours scaled down)
    const earthRotationStep = deltaTime * 0.01;
    this.earthMesh.rotation.y += earthRotationStep;

    // Request a render once enough rotation has accumulated so the spin never
    // visibly snaps after idle periods (0.005 rad is sub-pixel at Earth's
    // apparent size, so idle frames stay cheap between requests)
    this.pendingEarthRotation += earthRotationStep;
    if (this.pendingEarthRotation >= 0.005) {
      this.pendingEarthRotation = 0;
      this.requestRender();
    }
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
   * Get sun light intensity (base config value, not the horizon-faded value
   * applied to the light — keeps the getter symmetric with the setter so UI
   * controls seeded near sunset don't permanently lower the base intensity)
   */
  get sunIntensity(): number {
    return this.config.sunIntensity;
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
   * Get the sun direction for terrain lighting (direction TO the sun from the
   * observer). Uses the observer-relative offset — the celestial container
   * follows the camera, so normalizing the raw world position would mix the
   * camera position into the direction and skew terrain lighting as the
   * camera moves away from the origin.
   */
  getSunDirectionForTerrain(): THREE.Vector3 {
    // Reuses a scratch vector: called every frame, and consumers copy the
    // value into their uniforms rather than retaining the reference.
    return directionFromObserver(
      this.sunWorldPos,
      this.celestialContainer.position,
      this.sunDirectionForTerrain
    );
  }

  /**
   * Get the sun horizon fade factor (0 = below horizon, 1 = above horizon)
   * This matches the fade applied to sunLight.intensity
   */
  getSunHorizonFade(): number {
    return this.currentSunHorizonFade;
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
    this.skyboxMesh.geometry.dispose();
    (this.skyboxMesh.material as THREE.MeshBasicMaterial).dispose();
    if (this.skyboxTexture) {
      this.skyboxTexture.dispose();
    }
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
