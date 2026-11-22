import { describe, expect, it } from 'vitest';
import { MAX_ALTITUDE, readView, scaleBar, viewHash } from './view';

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
      height: 0.43,
      angle: 'oblique',
    });
  });
  it('keeps malformed links within the navigable range', () => {
    expect(readView('#h=1e9&sun=nan&x=&channel=nope')).toMatchObject({
      height: MAX_ALTITUDE,
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
