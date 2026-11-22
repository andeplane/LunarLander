import { describe, expect, it } from 'vitest';
import { MAX_DISTANCE, readView, scaleBar, viewHash, viewTilt } from './view';

describe('surface lab bookmarks', () => {
  it('reopens the same ground and sampling conditions', () => {
    const view = readView(
      '#view=procedural&h=0.43&x=-104.257214988573&z=28.125&sun=12&angle=oblique&channel=normals&relief=0.4'
    );
    expect(readView(viewHash(view))).toEqual(view);
    expect(view).toMatchObject({
      variant: 'procedural',
      x: -104.257214988573,
      z: 28.125,
      angle: 'oblique',
    });
    expect(view.distance * Math.cos(viewTilt('oblique'))).toBeCloseTo(0.43, 10);
    expect(new URLSearchParams(viewHash(view)).get('d')).toBe(String(view.distance));
  });
  it('holds the distance to the target when switching camera angles', () => {
    for (const angle of ['overhead', 'oblique', 'grazing']) {
      expect(readView(`#d=56&h=1&angle=${angle}`).distance).toBe(56);
    }
    const high = readView('#h=4000&angle=grazing');
    expect(readView(viewHash(high)).distance * Math.cos(viewTilt('grazing'))).toBeCloseTo(4000);
  });
  it('keeps malformed links within the navigable range', () => {
    expect(readView('#d=1e9&sun=nan&x=&channel=nope')).toMatchObject({
      distance: MAX_DISTANCE,
      sun: 22,
      x: 19,
      channel: 'lit',
    });
  });
});

describe('surface lab scale bar', () => {
  it.each([
    0.0002, 0.013, 0.7, 12,
  ])('reflects the projected ground scale at %s m/px', (resolution) => {
    const scale = scaleBar(resolution, 100);
    expect(scale.pixels).toBeLessThanOrEqual(100);
    expect(scale.pixels).toBeGreaterThan(39);
    expect(scale.pixels * resolution).toBeCloseTo(scale.metres);
  });
});
