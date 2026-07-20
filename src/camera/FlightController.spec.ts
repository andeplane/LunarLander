import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { FlightController } from './FlightController';
import type { InputManager } from '../core/InputManager';
import type { ChunkManager } from '../terrain/ChunkManager';
import type { CameraConfig } from '../types';

/**
 * Controllable stand-in for InputManager. State is mutated directly by tests;
 * the getters mirror InputManager's read-and-reset semantics.
 */
function makeInputStub() {
  const state = {
    keys: new Set<string>(),
    pointerLocked: false,
    mouseDelta: { x: 0, y: 0 },
    scrollDelta: 0,
    touchMove: { x: 0, y: 0 },
    verticalInput: 0,
    touchLook: { x: 0, y: 0 },
  };

  const stub = {
    state,
    isPointerLockActive: () => state.pointerLocked,
    isKeyPressed: (key: string) => state.keys.has(key),
    getMouseDelta: () => {
      const d = { ...state.mouseDelta };
      state.mouseDelta = { x: 0, y: 0 };
      return d;
    },
    getScrollDelta: () => {
      const d = state.scrollDelta;
      state.scrollDelta = 0;
      return d;
    },
    getMoveDirection: () => ({ ...state.touchMove }),
    getVerticalInput: () => state.verticalInput,
    getTouchLookDelta: () => {
      const d = { ...state.touchLook };
      state.touchLook = { x: 0, y: 0 };
      return d;
    },
  };
  return stub as typeof stub & InputManager;
}

/** Terrain stub: getHeightAt returns a fixed (or per-test) height. */
function makeChunkManagerStub(height: number | null) {
  const getHeightAt = vi.fn(() => height);
  return {
    stub: { getHeightAt } as unknown as ChunkManager,
    getHeightAt,
  };
}

const BASE_CONFIG: CameraConfig = {
  fov: 70,
  near: 0.1,
  far: 100000,
  baseSpeed: 10,
  minSpeed: 1,
  maxSpeed: 100,
  // Effectively instant acceleration: after one update the velocity equals
  // the target velocity, so speed assertions become exact
  acceleration: 1e6,
  mouseSensitivity: 0.002,
  minAltitudeAGL: 0.5,
};

function makeController(options?: {
  config?: Partial<CameraConfig>;
  terrainHeight?: number | null;
  withTerrain?: boolean;
  cameraY?: number;
}) {
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100000);
  camera.position.set(0, options?.cameraY ?? 100, 0);
  const input = makeInputStub();
  const config = { ...BASE_CONFIG, ...options?.config };
  const chunkManager =
    options?.withTerrain === false
      ? undefined
      : makeChunkManagerStub(options?.terrainHeight ?? 0).stub;
  const controller = new FlightController(camera, input, config, chunkManager);
  return { controller, camera, input, config };
}

/** Extract yaw/pitch from the camera quaternion (YXZ order, matching controller). */
function getYawPitch(camera: THREE.Camera): { yaw: number; pitch: number } {
  const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  return { yaw: euler.y, pitch: euler.x };
}

const DT = 0.001; // small step so position stays within the same AGL bracket

describe(FlightController.name, () => {
  describe('mouse look', () => {
    it('applies mouse deltas scaled by sensitivity while pointer-locked', () => {
      const { controller, camera, input } = makeController();
      input.state.pointerLocked = true;
      input.state.mouseDelta = { x: 100, y: 50 };

      controller.update(DT);

      const { yaw, pitch } = getYawPitch(camera);
      expect(yaw).toBeCloseTo(-100 * 0.002, 10);
      expect(pitch).toBeCloseTo(-50 * 0.002, 10);
    });

    it('ignores mouse deltas when pointer is not locked', () => {
      const { controller, camera, input } = makeController();
      input.state.pointerLocked = false;
      input.state.mouseDelta = { x: 100, y: 50 };

      controller.update(DT);

      const { yaw, pitch } = getYawPitch(camera);
      expect(yaw).toBeCloseTo(0, 10);
      expect(pitch).toBeCloseTo(0, 10);
    });

    it('clamps pitch to just under +/-90 degrees to prevent flipping', () => {
      const { controller, camera, input } = makeController();
      input.state.pointerLocked = true;
      input.state.mouseDelta = { x: 0, y: -1e6 }; // look straight up, way past vertical

      controller.update(DT);

      const { pitch } = getYawPitch(camera);
      expect(pitch).toBeCloseTo(Math.PI / 2 - 0.01, 6);
      expect(pitch).toBeLessThan(Math.PI / 2);
    });

    it('uses touch look deltas with the same sensitivity when not pointer-locked', () => {
      const { controller, camera, input } = makeController();
      input.state.pointerLocked = false;
      input.state.touchLook = { x: 100, y: 50 };

      controller.update(DT);

      const { yaw, pitch } = getYawPitch(camera);
      expect(yaw).toBeCloseTo(-100 * 0.002, 10);
      expect(pitch).toBeCloseTo(-50 * 0.002, 10);
    });
  });

  describe('speed adjustment', () => {
    it('scroll up increases the speed multiplier, scroll down decreases it', () => {
      const { controller, input } = makeController();

      input.state.scrollDelta = -1000; // scroll up
      controller.update(DT);
      expect(controller.getSpeedMultiplier()).toBeCloseTo(2.0, 10);

      input.state.scrollDelta = 500; // scroll down
      controller.update(DT);
      expect(controller.getSpeedMultiplier()).toBeCloseTo(1.0, 10);
    });

    it('clamps the multiplier to the configured min/max speed range', () => {
      const { controller, input } = makeController();

      input.state.scrollDelta = -1e9;
      controller.update(DT);
      // maxSpeed / baseSpeed = 100 / 10
      expect(controller.getSpeedMultiplier()).toBe(10);

      input.state.scrollDelta = 1e9;
      controller.update(DT);
      // Positive deltaY with a huge magnitude makes the factor negative, which
      // still clamps at the floor: minSpeed / baseSpeed = 1 / 10
      expect(controller.getSpeedMultiplier()).toBe(0.1);
    });

    it('setSpeedMultiplier clamps to the same range (touch speed presets)', () => {
      const { controller } = makeController();

      controller.setSpeedMultiplier(1000);
      expect(controller.getSpeedMultiplier()).toBe(10);

      controller.setSpeedMultiplier(0);
      expect(controller.getSpeedMultiplier()).toBe(0.1);

      controller.setSpeedMultiplier(2.5);
      expect(controller.getSpeedMultiplier()).toBe(2.5);
    });
  });

  describe('movement', () => {
    it('W moves forward (-Z at zero yaw) at base speed', () => {
      const { controller, camera, input } = makeController();
      input.state.keys.add('w');

      controller.update(DT);

      expect(controller.getCurrentSpeed()).toBeCloseTo(10, 3);
      expect(camera.position.z).toBeCloseTo(-10 * DT, 6);
      expect(camera.position.x).toBeCloseTo(0, 10);
    });

    it('shift boosts target speed 3x', () => {
      const { controller, input } = makeController();
      input.state.keys.add('w');
      input.state.keys.add('shift');

      controller.update(DT);

      expect(controller.getCurrentSpeed()).toBeCloseTo(30, 3);
    });

    it('touch joystick moves without any keys pressed (keyboard and touch coexist)', () => {
      const { controller, camera, input } = makeController();
      input.state.touchMove = { x: 0, y: 1 }; // full forward

      controller.update(DT);

      expect(camera.position.z).toBeLessThan(0);
      expect(controller.getCurrentSpeed()).toBeCloseTo(10, 3);
    });

    it('combines W + D into a normalized diagonal (not faster than base speed)', () => {
      const { controller, camera, input } = makeController();
      input.state.keys.add('w');
      input.state.keys.add('d');

      controller.update(DT);

      expect(controller.getCurrentSpeed()).toBeCloseTo(10, 3);
      // Forward is -Z, right is +X at zero yaw
      expect(camera.position.z).toBeCloseTo(-10 * DT * Math.SQRT1_2, 6);
      expect(camera.position.x).toBeCloseTo(10 * DT * Math.SQRT1_2, 6);
    });

    it('E moves up and Q moves down (touch vertical input equivalent)', () => {
      const { controller, camera, input } = makeController({ cameraY: 100 });
      input.state.verticalInput = 1;
      controller.update(DT);
      expect(camera.position.y).toBeGreaterThan(100);

      input.state.verticalInput = 0;
      input.state.keys.add('q');
      controller.update(DT);
      controller.update(DT);
      expect(camera.position.y).toBeLessThan(100 + 10 * DT);
    });
  });

  describe('AGL descent slowdown', () => {
    /**
     * Measure the vertical speed produced by holding Q for one update at the
     * given camera altitude (terrain height 0, so altitude == AGL).
     */
    function descentSpeedAtAgl(agl: number): number {
      const { controller, input } = makeController({ cameraY: agl, terrainHeight: 0 });
      input.state.keys.add('q');
      controller.update(DT);
      return controller.getCurrentSpeed();
    }

    it('applies no slowdown above 50m AGL', () => {
      expect(descentSpeedAtAgl(100)).toBeCloseTo(10, 3);
    });

    it('halves descent speed at 5m AGL', () => {
      expect(descentSpeedAtAgl(5)).toBeCloseTo(5, 2);
    });

    it('quarters descent speed at 1m AGL', () => {
      expect(descentSpeedAtAgl(1)).toBeCloseTo(2.5, 2);
    });

    it('stops descent entirely at the minimum AGL', () => {
      expect(descentSpeedAtAgl(0.5)).toBeCloseTo(0, 5);
    });

    it('does not slow horizontal movement near the ground', () => {
      const { controller, input } = makeController({ cameraY: 1, terrainHeight: 0 });
      input.state.keys.add('w');
      controller.update(DT);
      expect(controller.getCurrentSpeed()).toBeCloseTo(10, 3);
    });

    it('does not slow upward movement near the ground', () => {
      const { controller, input } = makeController({ cameraY: 1, terrainHeight: 0 });
      input.state.keys.add('e');
      controller.update(DT);
      expect(controller.getCurrentSpeed()).toBeCloseTo(10, 3);
    });
  });

  describe('terrain collision', () => {
    it('pushes the camera up when terrain loads underneath it', () => {
      const { controller, camera } = makeController({ cameraY: 5, terrainHeight: 20 });

      controller.update(DT);

      // Forced up to terrainHeight + minAltitudeAGL
      expect(camera.position.y).toBeCloseTo(20.5, 6);
    });

    it('never lets sustained descent go below terrain + minAltitudeAGL', () => {
      const { controller, camera, input } = makeController({ cameraY: 3, terrainHeight: 0 });
      input.state.keys.add('q');

      for (let i = 0; i < 2000; i++) {
        controller.update(0.016);
      }

      expect(camera.position.y).toBeGreaterThanOrEqual(0.5 - 1e-9);
    });

    it('moves freely when terrain height is unknown (chunk not loaded)', () => {
      const { controller, camera, input } = makeController({ terrainHeight: null, cameraY: 100 });
      input.state.keys.add('q');

      controller.update(DT);

      expect(camera.position.y).toBeLessThan(100);
      expect(controller.getCurrentSpeed()).toBeCloseTo(10, 3);
    });

    it('works without a chunk manager at all', () => {
      const { controller, camera, input } = makeController({ withTerrain: false, cameraY: 100 });
      input.state.keys.add('q');

      controller.update(DT);

      expect(camera.position.y).toBeLessThan(100);
    });
  });

  describe('initial orientation', () => {
    it('adopts the camera existing yaw/pitch instead of snapping to zero', () => {
      const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 100000);
      camera.position.set(0, 100, 0);
      camera.quaternion.setFromEuler(new THREE.Euler(0.3, 1.2, 0, 'YXZ'));
      const input = makeInputStub();
      const controller = new FlightController(camera, input, BASE_CONFIG);

      controller.update(DT);

      const { yaw, pitch } = getYawPitch(camera);
      expect(yaw).toBeCloseTo(1.2, 6);
      expect(pitch).toBeCloseTo(0.3, 6);
    });
  });
});
