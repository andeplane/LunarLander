import type { DigSite } from '../terrain/Excavations';

export const minerals = {
  monazite: { name: 'Monazite', color: '#e2a267' },
  xenotime: { name: 'Xenotime', color: '#aebb88' },
  gold: { name: 'Native gold', color: '#ffce48' },
  diamond: { name: 'Diamond', color: '#99e5f4' },
} as const;
export type Mineral = keyof typeof minerals;
export type Collection = Record<Mineral, number>;
export interface Deposit extends DigSite {
  mineral: Mineral;
  strokes: number;
  location: 'ground' | 'hand' | 'cargo' | 'base';
}
export const oxygenCapacity = 180;
export const cargoCapacity = 3;
export const uncoverStrokes = 3;
export const distance = (a: DigSite, b: DigSite) => Math.hypot(a.x - b.x, a.z - b.z);
const archiveKey = 'rover.mineral-collection.v1';
export function loadCollection(): Collection {
  const counts: Collection = { monazite: 0, xenotime: 0, gold: 0, diamond: 0 };
  try {
    const saved = JSON.parse(localStorage.getItem(archiveKey) ?? '{}');
    for (const key of Object.keys(counts) as Mineral[]) {
      if (Number.isSafeInteger(saved?.[key]) && saved[key] > 0) counts[key] = saved[key];
    }
  } catch {
    /* A session collection also works without browser storage. */
  }
  return counts;
}

export function survey(
  base: DigSite,
  findGround: (x: number, z: number) => DigSite,
  rotation = 0
): Deposit[] {
  return [32, 56, 74, 91].map((radius, i) => {
    const angle = rotation + [0, 1.2, -1.65, 2.65][i];
    const point = findGround(base.x + Math.sin(angle) * radius, base.z - Math.cos(angle) * radius);
    const roll = Math.random();
    const mineral =
      roll < 0.46 ? 'monazite' : roll < 0.81 ? 'xenotime' : roll < 0.95 ? 'gold' : 'diamond';
    return { x: point.x, z: point.z, mineral, strokes: 0, location: 'ground' };
  });
}

export class Expedition {
  phase: 'base' | 'drive' | 'eva' = 'base';
  oxygen = oxygenCapacity;
  report = 'Drive to a survey signal. Step out, dig, and bring the sample back in your rover.';
  constructor(
    readonly base: DigSite,
    public sites: Deposit[],
    readonly collection = loadCollection()
  ) {}
  get cargo() {
    return this.sites.filter((site) => site.location === 'cargo');
  }
  get hand() {
    return this.sites.find((site) => site.location === 'hand');
  }

  launch() {
    this.phase = 'drive';
  }

  tick(seconds: number) {
    if (this.phase === 'base') return false;
    this.oxygen = Math.max(0, this.oxygen - seconds);
    if (this.oxygen > 0) return false;
    for (const site of this.sites) {
      if (site.location !== 'base') site.location = 'ground';
    }
    this.phase = 'base';
    this.oxygen = oxygenCapacity;
    this.report =
      'Oxygen depleted. Rescue returned you to base. Unsecured samples remain at their dig sites.';
    return true;
  }

  dock(rover: DigSite) {
    if (this.phase !== 'drive' || distance(rover, this.base) > 9) return;
    const cargo = this.cargo;
    for (const site of cargo) {
      this.collection[site.mineral]++;
      site.location = 'base';
    }
    this.phase = 'base';
    this.oxygen = oxygenCapacity;
    this.report = cargo.length
      ? `Archived ${cargo.map((site) => minerals[site.mineral].name).join(', ')}. Oxygen refilled.`
      : 'Oxygen refilled. The rover is ready.';
    try {
      localStorage.setItem(archiveKey, JSON.stringify(this.collection));
    } catch {
      /* Keep session totals. */
    }
  }

  nearbySite(boots: DigSite) {
    return this.sites.find((site) => site.location === 'ground' && distance(site, boots) <= 2.7);
  }

  workSite(boots: DigSite, rover: DigSite) {
    const site = this.nearbySite(boots);
    if (this.phase !== 'eva' || !site || this.hand || distance(site, rover) > 14) return;
    if (site.strokes < uncoverStrokes) {
      site.strokes++;
      return site;
    }
    site.location = 'hand';
  }

  load(rover: DigSite, boots: DigSite) {
    const sample = this.hand;
    if (
      this.phase === 'eva' &&
      sample &&
      distance(rover, boots) <= 3.6 &&
      this.cargo.length < cargoCapacity
    )
      sample.location = 'cargo';
  }
}
