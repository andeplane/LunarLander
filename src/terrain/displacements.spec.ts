import { describe, it, expect } from 'vitest';
import { PlaneGeometry, type BufferAttribute } from 'three';
import { displaceY } from './displacements';

function makeFlatGeometry(): PlaneGeometry {
  const geometry = new PlaneGeometry(10, 10, 2, 2);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

describe(displaceY.name, () => {
  const heightFn = (x: number, z: number) => x + 2 * z;

  it('displaces vertex heights by the height function times strength', () => {
    const geometry = makeFlatGeometry();
    const strength = 3;

    displaceY(geometry, heightFn, strength);

    const position = geometry.attributes.position as BufferAttribute;
    for (let i = 0; i < position.count; i++) {
      const expected = heightFn(position.getX(i), position.getZ(i)) * strength;
      expect(position.getY(i)).toBeCloseTo(expected, 5);
    }
  });

  it('recomputes vertex normals by default', () => {
    const geometry = makeFlatGeometry();

    displaceY(geometry, heightFn, 1);

    // Sloped terrain must produce non-vertical normals
    const normal = geometry.attributes.normal as BufferAttribute;
    expect(normal.getY(0)).toBeLessThan(1);
  });

  it('skips the normals pass when computeNormals is false', () => {
    const geometry = makeFlatGeometry();
    const normalsBefore = Array.from(geometry.attributes.normal.array);

    displaceY(geometry, heightFn, 1, false);

    // Normals are untouched (still the flat-plane normals)
    expect(Array.from(geometry.attributes.normal.array)).toEqual(normalsBefore);

    // A later explicit pass yields the same normals as the default path
    geometry.computeVertexNormals();
    const reference = makeFlatGeometry();
    displaceY(reference, heightFn, 1);
    const actual = geometry.attributes.normal.array;
    const expected = reference.attributes.normal.array;
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < actual.length; i++) {
      expect(actual[i]).toBeCloseTo(expected[i], 5);
    }
  });
});
