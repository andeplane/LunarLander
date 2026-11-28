import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Deposit,
  Expedition,
  loadCollection,
  oxygenCapacity,
  uncoverStrokes,
} from './Expedition';

const home = { x: 0, z: 0 };
const boots = { x: 30, z: 0 };
const parked = { x: 32, z: 0 };
function sample(x = boots.x): Deposit {
  return { x, z: 0, strokes: 0, mineral: 'diamond', location: 'ground' };
}
function sortie(...sites: Deposit[]) {
  const mission = new Expedition(home, sites);
  mission.launch();
  mission.phase = 'eva';
  return mission;
}
afterEach(() => vi.unstubAllGlobals());

describe('lunar sample recovery', () => {
  it('requires the rover at the signal and boots within reach for each cut', () => {
    const site = sample(),
      mission = sortie(site);
    mission.workSite(boots, home);
    mission.workSite(home, parked);
    expect(site.strokes).toBe(0);
    for (let i = 0; i < uncoverStrokes; i++) {
      expect(mission.workSite(boots, parked)).toBe(site);
      expect(mission.hand).toBeUndefined();
    }
    mission.workSite(boots, parked);
    expect(mission.hand).toBe(site);
    mission.load(home, boots);
    expect(mission.cargo).toHaveLength(0);
    mission.load(parked, boots);
    mission.launch();
    mission.dock(parked);
    expect(mission.collection.diamond).toBe(0);
    expect(mission.cargo).toEqual([site]);
    mission.tick(40);
    const store = new Map();
    vi.stubGlobal('localStorage', storeStorage(store));
    mission.dock(home);
    mission.dock(home);
    expect(mission.cargo).toHaveLength(0);
    expect(mission.oxygen).toBe(oxygenCapacity);
    expect(loadCollection().diamond).toBe(1);
    expect(mission.tick(1000)).toBe(false);
  });
  it('returns loose and stowed finds to their sites after a rescue while preserving archived finds', () => {
    const sites = [sample(10), sample(20), sample(30)];
    const mission = sortie(...sites);
    sites[0].location = 'base';
    sites[1].location = 'cargo';
    sites[2].location = 'hand';
    mission.collection.diamond = 1;
    expect(mission.tick(oxygenCapacity)).toBe(true);
    expect(mission.phase).toBe('base');
    expect(sites.map((site) => site.location)).toEqual(['base', 'ground', 'ground']);
    expect(mission.collection.diamond).toBe(1);
  });
  it('loads valid counts when an older or damaged archive is missing entries', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{"diamond":2,"gold":-1,"monazite":"broken"}' });
    expect(loadCollection()).toEqual({ diamond: 2, gold: 0, monazite: 0, xenotime: 0 });
  });
});
function storeStorage(map: Map<string, string>) {
  return {
    getItem: (key: string) => map.get(key),
    setItem: (key: string, value: string) => map.set(key, value),
  };
}
