import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyCurvatureStep, directionFromObserver } from './celestialMath';

const PLANET_RADIUS = 5000;

describe('directionFromObserver', () => {
  it('returns the normalized offset from observer to target', () => {
    const observer = new THREE.Vector3(0, 0, 0);
    const target = new THREE.Vector3(0, 50000, 0);
    const dir = directionFromObserver(target, observer);
    expect(dir.x).toBeCloseTo(0, 10);
    expect(dir.y).toBeCloseTo(1, 10);
    expect(dir.z).toBeCloseTo(0, 10);
  });

  it('is independent of the observer position (camera movement must not skew sun direction)', () => {
    // Sun offset as seen by the observer (container follows the camera)
    const offset = new THREE.Vector3(20000, 40000, 10000);

    const atOrigin = directionFromObserver(
      offset.clone(), // observer at origin: world pos == offset
      new THREE.Vector3(0, 0, 0)
    );

    // Observer 4 km from origin: world pos = observer + same offset
    const observer = new THREE.Vector3(4000, 100, -2500);
    const farFromOrigin = directionFromObserver(observer.clone().add(offset), observer);

    expect(farFromOrigin.x).toBeCloseTo(atOrigin.x, 10);
    expect(farFromOrigin.y).toBeCloseTo(atOrigin.y, 10);
    expect(farFromOrigin.z).toBeCloseTo(atOrigin.z, 10);

    // Sanity check: normalizing the raw world position instead (the old bug)
    // gives a measurably different direction at 4 km out
    const buggy = observer.clone().add(offset).normalize();
    const errorDegrees = THREE.MathUtils.radToDeg(buggy.angleTo(atOrigin));
    expect(errorDegrees).toBeGreaterThan(3);
  });

  it('writes into the provided out vector and returns a unit vector', () => {
    const out = new THREE.Vector3();
    const result = directionFromObserver(
      new THREE.Vector3(3, 4, 0),
      new THREE.Vector3(0, 0, 0),
      out
    );
    expect(result).toBe(out);
    expect(out.length()).toBeCloseTo(1, 10);
    expect(out.x).toBeCloseTo(0.6, 10);
    expect(out.y).toBeCloseTo(0.8, 10);
  });
});

describe('applyCurvatureStep', () => {
  it('leaves the rotation unchanged for a zero-length step', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3);
    const before = q.clone();
    applyCurvatureStep(q, 0, 0, PLANET_RADIUS);
    // angleTo goes through acos, which amplifies float rounding near 0
    expect(q.angleTo(before)).toBeLessThan(1e-7);
  });

  it('matches the closed-form radial rotation for straight-line travel along +x', () => {
    const q = new THREE.Quaternion();
    const totalDistance = 2000;
    const steps = 200;
    for (let i = 0; i < steps; i++) {
      applyCurvatureStep(q, totalDistance / steps, 0, PLANET_RADIUS);
    }

    // Travelling +x tilts the sky by theta = d/R around the +z axis
    // (axis = (-sin(phi), 0, cos(phi)) with phi = 0)
    const expected = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      totalDistance / PLANET_RADIUS
    );
    expect(q.angleTo(expected)).toBeLessThan(1e-6);
  });

  it('returns to the original orientation after a full circumference of straight travel', () => {
    const q = new THREE.Quaternion();
    const circumference = 2 * Math.PI * PLANET_RADIUS;
    const steps = 1000;
    for (let i = 0; i < steps; i++) {
      applyCurvatureStep(q, 0, circumference / steps, PLANET_RADIUS);
    }
    expect(q.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });

  it('stays smooth when crossing the origin (no axis-flip snap)', () => {
    // Fly a straight line through the world origin. The old position-based
    // formula flips phi by ~180 degrees at the crossing; the incremental form
    // must never change the rotation by more than the step's own dTheta.
    const q = new THREE.Quaternion();
    const step = 10; // meters per frame
    const maxDelta = step / PLANET_RADIUS;

    let prev = q.clone();
    for (let x = -1000; x <= 1000; x += step) {
      applyCurvatureStep(q, step, 0, PLANET_RADIUS);
      expect(q.angleTo(prev)).toBeLessThanOrEqual(maxDelta + 1e-9);
      prev = q.clone();
    }
  });

  it('stays smooth during tangential flight (circle around the origin)', () => {
    // Fly a circle of radius 1000 m around the origin. The old formula kept
    // theta constant while swinging the axis, slewing the sky; each
    // incremental step must be bounded by the step arc length / R.
    const q = new THREE.Quaternion();
    const radius = 1000;
    const steps = 360;
    let prevX = radius;
    let prevZ = 0;
    let prev = q.clone();

    for (let i = 1; i <= steps; i++) {
      const angle = (i / steps) * 2 * Math.PI;
      const x = radius * Math.cos(angle);
      const z = radius * Math.sin(angle);
      const stepDist = Math.hypot(x - prevX, z - prevZ);

      applyCurvatureStep(q, x - prevX, z - prevZ, PLANET_RADIUS);
      expect(q.angleTo(prev)).toBeLessThanOrEqual(stepDist / PLANET_RADIUS + 1e-9);

      prev = q.clone();
      prevX = x;
      prevZ = z;
    }
  });

  it('keeps the quaternion normalized over many steps', () => {
    const q = new THREE.Quaternion();
    for (let i = 0; i < 10000; i++) {
      applyCurvatureStep(q, 7, 3, PLANET_RADIUS);
    }
    expect(q.length()).toBeCloseTo(1, 10);
  });
});
