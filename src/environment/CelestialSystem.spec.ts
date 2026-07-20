import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as THREE from 'three';
import { CelestialSystem } from './CelestialSystem';
import { DEFAULT_PLANET_RADIUS } from '../core/EngineSettings';

/**
 * Runs in node with a minimal document stub: THREE.TextureLoader creates
 * <img> elements via document.createElementNS, but never fires load events,
 * so materials are constructed with empty textures — which is all these
 * wiring tests need.
 */
describe(CelestialSystem.name, () => {
  let scene: THREE.Scene;
  let requestRender: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.stubGlobal('document', {
      createElementNS: () => ({
        addEventListener: () => {},
        removeEventListener: () => {},
        setAttribute: () => {},
        style: {},
      }),
    });
    scene = new THREE.Scene();
    requestRender = vi.fn<() => void>();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeSystem(config = {}): CelestialSystem {
    return new CelestialSystem(scene, requestRender, config);
  }

  /** Rotation angle (radians) of a quaternion. */
  function quaternionAngle(q: THREE.Quaternion): number {
    return 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  }

  /** Fetch a scene object by name, throwing when absent. */
  function getByName(name: string): THREE.Object3D {
    const object = scene.getObjectByName(name);
    if (!object) {
      throw new Error(`expected scene object named: ${name}`);
    }
    return object;
  }

  it('builds sun, Earth, skybox, and all four lights into the scene', () => {
    const system = makeSystem();

    expect(scene.getObjectByName('CelestialSystem')).toBeDefined();
    expect(scene.getObjectByName('Sun')).toBeDefined();
    expect(scene.getObjectByName('Earth')).toBeDefined();
    expect(scene.getObjectByName('Skybox')).toBeDefined();
    expect(scene.getObjectByName('SunLight')).toBeDefined();
    expect(scene.getObjectByName('EarthLight')).toBeDefined();
    expect(scene.getObjectByName('SpaceshipLight')).toBeDefined();
    expect(scene.getObjectByName('Flashlight')).toBeDefined();

    system.dispose();
  });

  describe('sun horizon fade', () => {
    it('keeps full sunlight when the sun is high above the horizon', () => {
      const system = makeSystem({ sunIntensity: 5 });
      system.setSunPosition(0, Math.PI / 2); // straight overhead

      system.update(new THREE.Vector3(0, 0, 0), 1 / 60);

      expect(system.getSunHorizonFade()).toBeCloseTo(1, 6);
      expect(system.getSunLight().intensity).toBeCloseTo(5, 6);
      system.dispose();
    });

    it('extinguishes sunlight when the sun is below the horizon', () => {
      const system = makeSystem({ sunIntensity: 5 });
      system.setSunPosition(0, -Math.PI / 4);

      system.update(new THREE.Vector3(0, 0, 0), 1 / 60);

      expect(system.getSunHorizonFade()).toBe(0);
      expect(system.getSunLight().intensity).toBe(0);
      system.dispose();
    });

    it('sunIntensity getter returns the base value even while faded (GUI seeding)', () => {
      const system = makeSystem({ sunIntensity: 5 });
      system.setSunPosition(0, -Math.PI / 4);
      system.update(new THREE.Vector3(0, 0, 0), 1 / 60);

      expect(system.getSunLight().intensity).toBe(0);
      expect(system.sunIntensity).toBe(5);
      system.dispose();
    });
  });

  describe('light intensity plumbing', () => {
    it('setting sunIntensity rescales earthshine from the base value', () => {
      const system = makeSystem({ sunIntensity: 5, earthshineMultiplier: 0.2 });

      system.sunIntensity = 10;

      const earthLight = scene.getObjectByName('EarthLight') as THREE.DirectionalLight;
      expect(earthLight.intensity).toBeCloseTo(10 * 0.2, 6);
      expect(requestRender).toHaveBeenCalled();
      system.dispose();
    });

    it('setting earthshineMultiplier uses base sun intensity, not the faded light', () => {
      const system = makeSystem({ sunIntensity: 5 });
      system.setSunPosition(0, -Math.PI / 4); // sun below horizon
      system.update(new THREE.Vector3(0, 0, 0), 1 / 60);
      expect(system.getSunLight().intensity).toBe(0);

      system.earthshineMultiplier = 0.5;

      const earthLight = scene.getObjectByName('EarthLight') as THREE.DirectionalLight;
      expect(earthLight.intensity).toBeCloseTo(5 * 0.5, 6);
      system.dispose();
    });
  });

  describe('terrain sun direction', () => {
    it('points at the sun from the observer, unaffected by camera translation', () => {
      const system = makeSystem();
      system.setSunPosition(0, Math.PI / 2); // straight overhead

      // First update establishes the parallel-transport reference; no rotation
      const cameraPos = new THREE.Vector3(4000, 120, -2500);
      system.update(cameraPos, 1 / 60);

      const direction = system.getSunDirectionForTerrain();
      expect(direction.length()).toBeCloseTo(1, 6);
      // Observer-relative: overhead stays overhead regardless of camera position
      expect(direction.y).toBeCloseTo(1, 5);
      expect(direction.x).toBeCloseTo(0, 5);
      expect(direction.z).toBeCloseTo(0, 5);
      system.dispose();
    });
  });

  describe('curvature parallel transport', () => {
    it('rotates the sky by traveled distance / planet radius', () => {
      const system = makeSystem();
      const container = getByName('CelestialSystem');

      system.update(new THREE.Vector3(0, 0, 0), 1 / 60); // reference frame
      expect(quaternionAngle(container.quaternion)).toBeCloseTo(0, 10);

      const distance = 0.1 * DEFAULT_PLANET_RADIUS;
      system.update(new THREE.Vector3(distance, 0, 0), 1 / 60);

      expect(quaternionAngle(container.quaternion)).toBeCloseTo(0.1, 6);
      system.dispose();
    });

    it('accumulates rotation across steps along the same heading', () => {
      const system = makeSystem();
      const container = getByName('CelestialSystem');
      const step = 0.05 * DEFAULT_PLANET_RADIUS;

      system.update(new THREE.Vector3(0, 0, 0), 1 / 60);
      system.update(new THREE.Vector3(step, 0, 0), 1 / 60);
      system.update(new THREE.Vector3(2 * step, 0, 0), 1 / 60);

      expect(quaternionAngle(container.quaternion)).toBeCloseTo(0.1, 6);
      system.dispose();
    });

    it('keeps the container centered on the camera', () => {
      const system = makeSystem();
      const container = getByName('CelestialSystem');
      const cameraPos = new THREE.Vector3(123, 45, -678);

      system.update(cameraPos, 1 / 60);

      expect(container.position.x).toBe(123);
      expect(container.position.y).toBe(45);
      expect(container.position.z).toBe(-678);
      system.dispose();
    });
  });

  describe('camera-attached lights', () => {
    it('moves the spaceship light and flashlight with the camera', () => {
      const system = makeSystem();
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(10, 20, 30); // default orientation looks down -Z
      system.setCamera(camera);

      system.update(camera.position, 1 / 60);

      const spaceshipLight = scene.getObjectByName('SpaceshipLight') as THREE.PointLight;
      const flashlight = scene.getObjectByName('Flashlight') as THREE.SpotLight;
      const target = getByName('FlashlightTarget');

      expect(spaceshipLight.position.distanceTo(camera.position)).toBeCloseTo(0, 6);
      expect(flashlight.position.distanceTo(camera.position)).toBeCloseTo(0, 6);
      // Target is 100 m ahead along the camera forward direction (-Z)
      expect(target.position.x).toBeCloseTo(10, 6);
      expect(target.position.y).toBeCloseTo(20, 6);
      expect(target.position.z).toBeCloseTo(30 - 100, 6);
      system.dispose();
    });
  });

  describe('Earth spin render requests', () => {
    it('requests a render once accumulated rotation is visible, not every frame', () => {
      const system = makeSystem();
      requestRender.mockClear();

      // One 60 fps frame: rotation 0.01 * 1/60 rad, far below the threshold
      system.update(new THREE.Vector3(0, 0, 0), 1 / 60);
      expect(requestRender).not.toHaveBeenCalled();

      // Enough frames to pass the 0.005 rad threshold (0.5 s of spin)
      for (let i = 0; i < 30; i++) {
        system.update(new THREE.Vector3(0, 0, 0), 1 / 60);
      }
      expect(requestRender).toHaveBeenCalled();
      system.dispose();
    });
  });

  it('dispose removes the celestial container and lights from the scene', () => {
    const system = makeSystem();

    system.dispose();

    expect(scene.getObjectByName('CelestialSystem')).toBeUndefined();
    expect(scene.getObjectByName('SunLight')).toBeUndefined();
    expect(scene.getObjectByName('EarthLight')).toBeUndefined();
    expect(scene.getObjectByName('SpaceshipLight')).toBeUndefined();
    expect(scene.getObjectByName('Flashlight')).toBeUndefined();
    expect(scene.getObjectByName('FlashlightTarget')).toBeUndefined();
  });
});
