import alea from 'alea';
import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import { BufferAttribute, BufferGeometry, IcosahedronGeometry, Matrix3, Vector3 } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { type RockArchetype, rockArchetype, rockHeightRatio } from './rockPrototypes';

/**
 * Options controlling procedural rock generation.
 * Shared by generate(), generateLibrary() and createLibraryBuilder().
 */
export interface RockLibraryOptions {
  /**
   * Icosphere subdivision frequency of the starting mesh. The result has at
   * most 20·(detail+1)² triangles (fewer once collapsed ones are removed).
   */
  detail?: number;
  /** Scale of the surface relief (undulation, ledges, dents, pits, grain; default 1, 0 = none). */
  roughness?: number;
  /** Scale of the edge rounding width (default 1, 0 = razor-sharp polytope edges). */
  bevel?: number;
  /** Faces meeting at more than this angle (degrees) get a hard edge (default 38). */
  creaseAngle?: number;
  /**
   * How far (as a fraction of the mesh edge length) a vertex may move to land
   * exactly on an edge or corner of the cut body (default 1.5, 0 disables).
   * Only edges whose rounding is narrower than the mesh spacing are snapped:
   * wider, worn edges are resolved by the plain sampling.
   */
  edgeSnap?: number;
}

/**
 * Incremental rock-library builder returned by RockBuilder.createLibraryBuilder().
 * Builds one prototype per buildNext() call so the work can be spread across
 * idle time instead of blocking the main thread in one long synchronous burst.
 *
 * Prototype i is identical to generateLibrary(count, options)[i] and to
 * generate(i, options): generation is seeded per index.
 */
export interface RockLibraryBuilder {
  /** Number of prototypes built so far. */
  readonly builtCount: number;
  /** Total number of prototypes this builder will produce. */
  readonly total: number;
  /**
   * Build the next prototype in sequence.
   * Returns null once the library is complete (or the builder was disposed).
   */
  buildNext(): BufferGeometry | null;
  /** Stop the builder without finishing the library. */
  dispose(): void;
}

/** Unit-sphere vertex directions and triangle indices of a welded icosphere. */
interface BaseSphere {
  readonly directions: Float32Array;
  readonly index: Uint32Array;
}

const DEFAULT_DETAIL = 3;
const DEFAULT_CREASE_ANGLE_DEG = 38;
/** Detail of the coarse point cloud used to find a shape's resting pose. */
const POSE_REFERENCE_DETAIL = 3;
const DEFAULT_EDGE_SNAP = 1.5;
/** Triangles thinner than this (doubled area, prototype units²) are dropped. */
const DEGENERATE_AREA = 1e-9;

/** Welded icospheres are immutable and tiny, so they are shared per detail. */
const baseSphereCache = new Map<number, BaseSphere>();

function getBaseSphere(detail: number): BaseSphere {
  const cached = baseSphereCache.get(detail);
  if (cached) {
    return cached;
  }
  const raw = new IcosahedronGeometry(1, detail);
  // Weld on position only: the UV seam would otherwise keep duplicate
  // vertices that tear open as soon as they are displaced differently
  raw.deleteAttribute('uv');
  raw.deleteAttribute('normal');
  const merged = mergeVertices(raw, 1e-5);
  const position = merged.getAttribute('position');
  const directions = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const inv = 1 / Math.hypot(x, y, z);
    directions[i * 3] = x * inv;
    directions[i * 3 + 1] = y * inv;
    directions[i * 3 + 2] = z * inv;
  }
  const mergedIndex = merged.getIndex();
  const index = new Uint32Array(mergedIndex ? mergedIndex.count : 0);
  if (mergedIndex) {
    for (let i = 0; i < index.length; i++) {
      index[i] = mergedIndex.getX(i);
    }
  }
  raw.dispose();
  merged.dispose();
  const base: BaseSphere = { directions, index };
  baseSphereCache.set(detail, base);
  return base;
}

/**
 * The convex body a rock is cut from: the unit sphere clipped by half-spaces
 * n·p <= d, then stretched per axis. Because it is described analytically,
 * every detail tier of a shape samples the very same silhouette.
 */
class CutBody {
  /** Flat [nx, ny, nz, d] per plane. */
  private planes: number[] = [];
  /** Per-axis stretch applied after cutting. */
  stretch: [number, number, number] = [1, 1, 1];

  // Results of the last nearest() call: the three planes that clip the
  // queried direction first (-1 when fewer exist) and their radii
  planeA = -1;
  planeB = -1;
  planeC = -1;
  radiusA = Number.POSITIVE_INFINITY;
  radiusB = Number.POSITIVE_INFINITY;
  radiusC = Number.POSITIVE_INFINITY;

  get planeCount(): number {
    return this.planes.length / 4;
  }

  addPlane(nx: number, ny: number, nz: number, distance: number): void {
    const inv = 1 / Math.hypot(nx, ny, nz);
    this.planes.push(nx * inv, ny * inv, nz * inv, distance);
  }

  /** Distance from the center to the surface along a unit direction. */
  radius(ux: number, uy: number, uz: number): number {
    const planes = this.planes;
    let r = 1;
    for (let i = 0; i < planes.length; i += 4) {
      const along = planes[i] * ux + planes[i + 1] * uy + planes[i + 2] * uz;
      if (along > 1e-9) {
        const hit = planes[i + 3] / along;
        if (hit < r) {
          r = hit;
        }
      }
    }
    return r;
  }

  /** Like radius(), but also records the three nearest clipping planes. */
  nearest(ux: number, uy: number, uz: number): number {
    const planes = this.planes;
    let a = -1;
    let b = -1;
    let c = -1;
    let ra = Number.POSITIVE_INFINITY;
    let rb = Number.POSITIVE_INFINITY;
    let rc = Number.POSITIVE_INFINITY;
    for (let i = 0; i < planes.length; i += 4) {
      const along = planes[i] * ux + planes[i + 1] * uy + planes[i + 2] * uz;
      if (along <= 1e-9) {
        continue;
      }
      const hit = planes[i + 3] / along;
      if (hit < ra) {
        c = b;
        rc = rb;
        b = a;
        rb = ra;
        a = i;
        ra = hit;
      } else if (hit < rb) {
        c = b;
        rc = rb;
        b = i;
        rb = hit;
      } else if (hit < rc) {
        c = i;
        rc = hit;
      }
    }
    this.planeA = a;
    this.planeB = b;
    this.planeC = c;
    this.radiusA = ra;
    this.radiusB = rb;
    this.radiusC = rc;
    return Math.min(1, ra);
  }

  /** Flat copy of the planes ([nx, ny, nz, d] per plane, unit-sphere space). */
  getPlanes(): readonly number[] {
    return this.planes;
  }

  /** Whether a point (unit-sphere space) lies inside or on the body. */
  contains(x: number, y: number, z: number): boolean {
    const len = Math.hypot(x, y, z);
    if (len < 1e-9) {
      return true;
    }
    return this.radius(x / len, y / len, z / len) >= len * (1 - 1e-6);
  }

  /**
   * Move a surface point lying on plane `a` (flat index) onto the edge it
   * shares with plane `b`, or onto the corner shared with `b` and `c` when
   * `c` is given (>= 0). The point at positions[offset..+2] is only replaced
   * when the target lies on the body and within `limit` of the point.
   */
  snapToFeature(
    positions: Float32Array,
    offset: number,
    a: number,
    b: number,
    c: number,
    limit: number
  ): boolean {
    const planes = this.planes;
    const px = positions[offset];
    const py = positions[offset + 1];
    const pz = positions[offset + 2];

    if (c >= 0) {
      const corner = CutBody.scratch;
      if (
        intersectThreePlanes(planes, a, b, c, corner) &&
        Math.hypot(corner[0] - px, corner[1] - py, corner[2] - pz) < limit &&
        this.contains(corner[0], corner[1], corner[2])
      ) {
        positions[offset] = corner[0];
        positions[offset + 1] = corner[1];
        positions[offset + 2] = corner[2];
        return true;
      }
    }

    // Edge: slide within plane a, straight towards plane b
    const cosAB =
      planes[a] * planes[b] + planes[a + 1] * planes[b + 1] + planes[a + 2] * planes[b + 2];
    const sinSq = 1 - cosAB * cosAB;
    if (sinSq < 1e-4) {
      return false;
    }
    const gap = planes[b + 3] - (planes[b] * px + planes[b + 1] * py + planes[b + 2] * pz);
    if (Math.abs(gap) / Math.sqrt(sinSq) >= limit) {
      return false;
    }
    const s = gap / sinSq;
    const ex = px + s * (planes[b] - cosAB * planes[a]);
    const ey = py + s * (planes[b + 1] - cosAB * planes[a + 1]);
    const ez = pz + s * (planes[b + 2] - cosAB * planes[a + 2]);
    if (!this.contains(ex, ey, ez)) {
      return false;
    }
    positions[offset] = ex;
    positions[offset + 1] = ey;
    positions[offset + 2] = ez;
    return true;
  }

  private static readonly scratch: [number, number, number] = [0, 0, 0];
}

/** Solve the intersection point of three planes (Cramer's rule). */
function intersectThreePlanes(
  planes: readonly number[],
  a: number,
  b: number,
  c: number,
  out: [number, number, number]
): boolean {
  const ax = planes[a];
  const ay = planes[a + 1];
  const az = planes[a + 2];
  const bx = planes[b];
  const by = planes[b + 1];
  const bz = planes[b + 2];
  const cx = planes[c];
  const cy = planes[c + 1];
  const cz = planes[c + 2];
  // b × c, c × a, a × b
  const bcx = by * cz - bz * cy;
  const bcy = bz * cx - bx * cz;
  const bcz = bx * cy - by * cx;
  const det = ax * bcx + ay * bcy + az * bcz;
  if (Math.abs(det) < 1e-3) {
    return false;
  }
  const cax = cy * az - cz * ay;
  const cay = cz * ax - cx * az;
  const caz = cx * ay - cy * ax;
  const abx = ay * bz - az * by;
  const aby = az * bx - ax * bz;
  const abz = ax * by - ay * bx;
  const da = planes[a + 3];
  const db = planes[b + 3];
  const dc = planes[c + 3];
  out[0] = (da * bcx + db * cax + dc * abx) / det;
  out[1] = (da * bcy + db * cay + dc * aby) / det;
  out[2] = (da * bcz + db * caz + dc * abz) / det;
  return true;
}

/** Random unit vector into out, uniform on the sphere. */
function randomDirection(random: () => number, out: [number, number, number]): void {
  const y = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  out[0] = Math.cos(angle) * ring;
  out[1] = y;
  out[2] = Math.sin(angle) * ring;
}

/** Add a plane whose normal is (nx, ny, nz) tilted randomly by up to `tilt` (rad-ish). */
function addJitteredPlane(
  body: CutBody,
  random: () => number,
  nx: number,
  ny: number,
  nz: number,
  tilt: number,
  distance: number
): void {
  const jitter: [number, number, number] = [0, 0, 0];
  randomDirection(random, jitter);
  const amount = tilt * random();
  body.addPlane(
    nx + jitter[0] * amount,
    ny + jitter[1] * amount,
    nz + jitter[2] * amount,
    distance
  );
}

function range(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

/** Large random cuts that slice whole corners or sides off. */
function addObliqueCuts(
  body: CutBody,
  random: () => number,
  count: number,
  min: number,
  max: number
): void {
  const direction: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    randomDirection(random, direction);
    body.addPlane(direction[0], direction[1], direction[2], range(random, min, max));
  }
}

/**
 * Small cuts placed where the body sticks out the most (its corners and
 * edges), like chips knocked off by impacts.
 */
function addChips(body: CutBody, random: () => number, count: number): void {
  const candidate: [number, number, number] = [0, 0, 0];
  const best: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    let bestRadius = -1;
    for (let attempt = 0; attempt < 8; attempt++) {
      randomDirection(random, candidate);
      const r = body.radius(candidate[0], candidate[1], candidate[2]);
      if (r > bestRadius) {
        bestRadius = r;
        best[0] = candidate[0];
        best[1] = candidate[1];
        best[2] = candidate[2];
      }
    }
    addJitteredPlane(
      body,
      random,
      best[0],
      best[1],
      best[2],
      0.35,
      bestRadius * range(random, 0.8, 0.93)
    );
  }
}

/**
 * Cut off thin spikes. Where few planes meet at a shallow angle the body can
 * reach far out in a narrow tip that coarse meshes cannot represent (it shows
 * up as a random spike). Any direction reaching beyond `limitRatio` times the
 * mean radius gets a blunt cut across it.
 */
function trimSpikes(body: CutBody, random: () => number, limitRatio: number): void {
  const reference = getBaseSphere(POSE_REFERENCE_DETAIL).directions;
  const count = reference.length / 3;
  for (let pass = 0; pass < 8; pass++) {
    let sum = 0;
    let worst = -1;
    let worstRadius = 0;
    for (let i = 0; i < count; i++) {
      const r = body.radius(reference[i * 3], reference[i * 3 + 1], reference[i * 3 + 2]);
      sum += r;
      if (r > worstRadius) {
        worstRadius = r;
        worst = i;
      }
    }
    const limit = (sum / count) * limitRatio;
    if (worstRadius <= limit) {
      return;
    }
    addJitteredPlane(
      body,
      random,
      reference[worst * 3],
      reference[worst * 3 + 1],
      reference[worst * 3 + 2],
      0.3,
      limit * range(random, 0.8, 0.95)
    );
  }
}

/** Build the cut planes and stretch for one shape. */
function createCutBody(
  archetype: RockArchetype,
  heightRatio: number,
  random: () => number
): CutBody {
  const body = new CutBody();

  if (archetype === 'block' || archetype === 'slab') {
    // An irregular hexahedron: six roughly axis-aligned faces, each tilted
    const tilt = archetype === 'slab' ? 0.16 : 0.26;
    const axes: readonly (readonly [number, number, number])[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const [x, y, z] of axes) {
      addJitteredPlane(
        body,
        random,
        x,
        y,
        z,
        y !== 0 ? tilt * 0.6 : tilt,
        range(random, 0.45, 0.6)
      );
    }
    addObliqueCuts(body, random, 1 + Math.floor(random() * 3), 0.52, 0.7);
    addChips(body, random, 3 + Math.floor(random() * 4));
    body.stretch = [1, heightRatio * range(random, 0.95, 1.05), range(random, 0.62, 0.95)];
  } else if (archetype === 'wedge') {
    // A base plus three or four inward-leaning sides, optionally truncated
    addJitteredPlane(body, random, 0, -1, 0, 0.1, range(random, 0.34, 0.44));
    const sides = 3 + Math.floor(random() * 2);
    const startAngle = random() * Math.PI * 2;
    for (let i = 0; i < sides; i++) {
      const azimuth = startAngle + (i / sides) * Math.PI * 2 + range(random, -0.3, 0.3);
      const lean = range(random, 0.35, 0.8);
      body.addPlane(
        Math.cos(azimuth) * Math.cos(lean),
        Math.sin(lean),
        Math.sin(azimuth) * Math.cos(lean),
        range(random, 0.3, 0.45)
      );
    }
    addJitteredPlane(body, random, 0, 1, 0, 0.45, range(random, 0.5, 0.85));
    addObliqueCuts(body, random, 1, 0.5, 0.7);
    addChips(body, random, 2 + Math.floor(random() * 3));
    trimSpikes(body, random, 1.6);
    body.stretch = [1, range(random, 0.85, 1.05), range(random, 0.7, 1)];
  } else {
    // Many shallow cuts: a worn, many-faceted cobble that keeps some of the
    // sphere between its facets
    addObliqueCuts(body, random, 12 + Math.floor(random() * 5), 0.72, 0.9);
    addChips(body, random, 2);
    body.stretch = [1, heightRatio * range(random, 1.1, 1.25), range(random, 0.75, 0.95)];
  }

  return body;
}

/** Hermite smoothstep of x between edge0 and edge1. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Integer hash to [0, 1) of a 3D lattice cell and a salt. */
function cellHash(ix: number, iy: number, iz: number, salt: number): number {
  let h = Math.imul(ix, 0x8da6b343) ^ Math.imul(iy, 0xd8163841) ^ Math.imul(iz, 0xcb1ab31f);
  h = Math.imul(h ^ salt ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** One layer of scattered bowl-shaped dents (cellular noise). */
interface DentLayer {
  /** Cells per prototype unit. */
  readonly frequency: number;
  /** Dent radius as a fraction of the cell size (at most 0.5). */
  readonly radius: number;
  /** Deepest dent, prototype units. */
  readonly depth: number;
  /** Share of cells that hold a dent. */
  readonly coverage: number;
  readonly salt: number;
}

/**
 * Sum of the dents of one layer at a point: cells of 1 / frequency each
 * hold at most one spherical-cap-like bowl (depth·(1 - (d/R)²)²) whose
 * center is jittered inside the cell, so only the 2×2×2 nearest cells can
 * reach the point.
 */
function dentDepth(layer: DentLayer, x: number, y: number, z: number): number {
  const fx = x * layer.frequency;
  const fy = y * layer.frequency;
  const fz = z * layer.frequency;
  const bx = Math.floor(fx - 0.5);
  const by = Math.floor(fy - 0.5);
  const bz = Math.floor(fz - 0.5);
  const radius = layer.radius;
  const jitter = 0.5 - radius;
  let total = 0;
  for (let cx = bx; cx <= bx + 1; cx++) {
    for (let cy = by; cy <= by + 1; cy++) {
      for (let cz = bz; cz <= bz + 1; cz++) {
        const pick = cellHash(cx, cy, cz, layer.salt);
        if (pick >= layer.coverage) {
          continue;
        }
        const dx = fx - (cx + 0.5 + jitter * (cellHash(cx, cy, cz, layer.salt + 1) * 2 - 1));
        const dy = fy - (cy + 0.5 + jitter * (cellHash(cx, cy, cz, layer.salt + 2) * 2 - 1));
        const dz = fz - (cz + 0.5 + jitter * (cellHash(cx, cy, cz, layer.salt + 3) * 2 - 1));
        // Each dent has its own size, from half to the full radius
        const size = radius * (0.5 + 0.5 * (pick / layer.coverage));
        const t = (dx * dx + dy * dy + dz * dz) / (size * size);
        if (t < 1) {
          const bowl = 1 - t;
          total += layer.depth * (0.4 + 0.6 * (pick / layer.coverage)) * bowl * bowl;
        }
      }
    }
  }
  return total;
}

/**
 * Edge rounding width, in prototype units (the stretched body spans about
 * one unit). Scaled per point by BEVEL_SPREAD, so some edges stay crisp and
 * others are worn round.
 */
const BEVEL_RANGE: readonly [number, number] = [0.014, 0.028];
/** Per-point bevel width factor: [crisp, worn]. */
const BEVEL_SPREAD: readonly [number, number] = [0.12, 2.2];
/** Width of the rounded strip of an edge, in bevel widths. */
const BEVEL_STRIP = 3;
/**
 * Edges are snapped (kept on the sharp body's edge line) unless their
 * rounded strip spans this many vertex spacings: narrower roundings would
 * only be sampled as a zig-zag.
 */
const SNAP_STRIP_RATIO = 2.5;

/**
 * The natural surface of a rock in stretched space (the body's proportions,
 * before the resting rotation and normalization):
 *
 * - shape: the cut body with its edges and corners rounded by an
 *   exponential smooth-min over the radial hit distances of its planes (and
 *   of the stretched sphere they cut), with a rounding width that varies
 *   over the surface;
 * - relief, pushed radially so the surface stays star-shaped: broad face
 *   undulation, fracture ledges (a soft sawtooth across a random direction,
 *   in patches), spall scars and zap pits (cellular dents), joint cracks
 *   and fine grain.
 *
 * Relief layers too fine for a mesh's vertex spacing fade out (band
 * limiting), so a coarse tier is a smoothed sampling of the same surface
 * instead of an aliased one. Everything is seeded per shape and independent
 * of the detail.
 */
class RockSurface {
  /** Stretched-space planes, flat [nx, ny, nz, d]. */
  private readonly planes: Float64Array;
  private readonly hits: Float64Array;
  private readonly inverseStretch: [number, number, number];
  private readonly bevel: number;
  private readonly noise: NoiseFunction3D;
  private readonly roughness: number;
  /** Fracture ledges: unit direction and ledges per unit. */
  private readonly ledgeDirection: [number, number, number] = [0, 1, 0];
  private readonly ledgeFrequency: number;
  private readonly dents: readonly DentLayer[];
  /** Joint cracks, flat [nx, ny, nz, offset, half width] per crack. */
  private readonly cracks: number[] = [];
  /** Band-limiting weights of the relief layers for the current mesh spacing. */
  private broadWeight = 1;
  private broadFineWeight = 1;
  private ledgeWeight = 1;
  private crackWeight = 1;
  private grainWeight = 1;
  private grainFineWeight = 1;
  private readonly dentWeights: number[];

  constructor(
    body: CutBody,
    noise: NoiseFunction3D,
    random: () => number,
    roughness: number,
    bevelScale: number
  ) {
    const [sx, sy, sz] = body.stretch;
    this.inverseStretch = [1 / sx, 1 / sy, 1 / sz];
    const source = body.getPlanes();
    this.planes = new Float64Array(source.length);
    for (let i = 0; i < source.length; i += 4) {
      // n·p <= d in unit space is (n / s)·q <= d in stretched space q = s·p
      const nx = source[i] / sx;
      const ny = source[i + 1] / sy;
      const nz = source[i + 2] / sz;
      const length = Math.hypot(nx, ny, nz);
      this.planes[i] = nx / length;
      this.planes[i + 1] = ny / length;
      this.planes[i + 2] = nz / length;
      this.planes[i + 3] = source[i + 3] / length;
    }
    this.hits = new Float64Array(source.length / 4);
    this.noise = noise;
    this.roughness = roughness;
    this.bevel = bevelScale * range(random, BEVEL_RANGE[0], BEVEL_RANGE[1]);
    randomDirection(random, this.ledgeDirection);
    this.ledgeFrequency = range(random, 6, 9);
    const crackCount = 1 + Math.floor(random() * 3);
    const crackDirection: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < crackCount; i++) {
      randomDirection(random, crackDirection);
      this.cracks.push(
        crackDirection[0],
        crackDirection[1],
        crackDirection[2],
        range(random, -0.25, 0.25),
        range(random, 0.005, 0.009)
      );
    }
    const salt = Math.floor(random() * 0x7fffffff);
    this.dents = [
      // Spall scars
      { frequency: 3.2, radius: 0.42, depth: 0.02, coverage: 0.5, salt },
      // Smaller chips
      { frequency: 7.5, radius: 0.38, depth: 0.0055, coverage: 0.3, salt: salt + 101 },
      // Zap pits
      { frequency: 19, radius: 0.3, depth: 0.0022, coverage: 0.35, salt: salt + 202 },
    ];
    this.dentWeights = this.dents.map(() => 1);
  }

  /**
   * Fade out relief finer than a mesh can carry. `spacing` is the vertex
   * spacing in prototype units; a layer of wavelength λ is kept fully when
   * λ >= 4·spacing and dropped when λ <= 2·spacing.
   */
  setSpacing(spacing: number): void {
    const weight = (wavelength: number): number => smoothstep(2 * spacing, 4 * spacing, wavelength);
    this.broadWeight = weight(1 / 1.7);
    this.broadFineWeight = weight(1 / 3.6);
    this.ledgeWeight = weight(1 / this.ledgeFrequency);
    this.crackWeight = weight(0.04);
    this.grainWeight = weight(1 / 22);
    this.grainFineWeight = weight(1 / 47);
    for (let i = 0; i < this.dents.length; i++) {
      // A bowl is about as wide as its radius
      const layer = this.dents[i];
      this.dentWeights[i] = weight((2 * layer.radius) / layer.frequency);
    }
  }

  /** Rounding width at a stretched-space unit direction. */
  bevelAt(vx: number, vy: number, vz: number): number {
    if (this.bevel <= 0) {
      return 0;
    }
    const n = this.noise(vx * 1.9 + 41.7, vy * 1.9 - 13.1, vz * 1.9 + 7.9);
    const t = smoothstep(-0.55, 0.65, n);
    return this.bevel * (BEVEL_SPREAD[0] + (BEVEL_SPREAD[1] - BEVEL_SPREAD[0]) * t);
  }

  /**
   * Distance from the center to the rounded body along a stretched-space unit
   * direction: -k·ln Σ exp(-hᵢ / k) over the plane and sphere hits hᵢ, which
   * equals the nearest hit away from edges and blends neighbouring faces
   * over a width of about k where they meet.
   */
  shapeRadius(vx: number, vy: number, vz: number, k: number): number {
    const planes = this.planes;
    const hits = this.hits;
    const [ix, iy, iz] = this.inverseStretch;
    const sphere = 1 / Math.hypot(vx * ix, vy * iy, vz * iz);
    let nearest = sphere;
    for (let i = 0, p = 0; i < planes.length; i += 4, p++) {
      const along = planes[i] * vx + planes[i + 1] * vy + planes[i + 2] * vz;
      const hit = along > 1e-9 ? planes[i + 3] / along : Number.POSITIVE_INFINITY;
      hits[p] = hit;
      if (hit < nearest) {
        nearest = hit;
      }
    }
    if (k <= 0) {
      return nearest;
    }
    const reach = nearest + 12 * k;
    let sum = sphere < reach ? Math.exp((nearest - sphere) / k) : 0;
    for (let p = 0; p < hits.length; p++) {
      if (hits[p] < reach) {
        sum += Math.exp((nearest - hits[p]) / k);
      }
    }
    return nearest - k * Math.log(sum);
  }

  /** Radial relief (prototype units, + outwards) at a stretched-space surface point. */
  relief(x: number, y: number, z: number): number {
    if (this.roughness === 0) {
      return 0;
    }
    const noise = this.noise;
    let height = 0;

    // Broad, gentle undulation of the faces
    height += this.broadWeight * 0.021 * noise(x * 1.7, y * 1.7, z * 1.7);
    height += this.broadFineWeight * 0.008 * noise(x * 3.6 + 11.3, y * 3.6 - 5.2, z * 3.6 + 2.9);

    // Fracture ledges: a soft sawtooth across the ledge direction (gentle
    // tread, steep riser), warped and present only in patches
    if (this.ledgeWeight > 0) {
      const [lx, ly, lz] = this.ledgeDirection;
      const warp = 0.55 * noise(x * 2.3 - 7.7, y * 2.3 + 3.1, z * 2.3 + 19.4);
      const t = (x * lx + y * ly + z * lz) * this.ledgeFrequency + warp;
      const fraction = t - Math.floor(t);
      const sawtooth = smoothstep(0.82, 1, fraction) - fraction;
      const patch = smoothstep(-0.15, 0.45, noise(x * 1.3 + 29.1, y * 1.3 - 31.7, z * 1.3 + 3.3));
      height += this.ledgeWeight * 0.011 * patch * sawtooth;
    }

    // Spall scars, chips and zap pits
    for (let i = 0; i < this.dents.length; i++) {
      if (this.dentWeights[i] > 0) {
        height -= this.dentWeights[i] * dentDepth(this.dents[i], x, y, z);
      }
    }

    // Joint cracks: narrow V-grooves along a few slightly wavy planes
    // through the rock, each running out somewhere along its length
    if (this.crackWeight > 0) {
      const cracks = this.cracks;
      for (let i = 0; i < cracks.length; i += 5) {
        const wobble = 0.025 * noise(x * 4.1 + i, y * 4.1 - i, z * 4.1 + 2 * i);
        const offset = Math.abs(
          x * cracks[i] + y * cracks[i + 1] + z * cracks[i + 2] - cracks[i + 3] + wobble
        );
        if (offset < cracks[i + 4]) {
          const fade = smoothstep(-0.2, 0.25, noise(x * 1.6 - 3 * i, y * 1.6 + i, z * 1.6 + 7));
          const v = 1 - offset / cracks[i + 4];
          height -= this.crackWeight * 0.006 * fade * v * v;
        }
      }
    }

    // Fine grain
    if (this.grainWeight > 0) {
      height += this.grainWeight * 0.0022 * noise(x * 22 + 5.5, y * 22 + 5.5, z * 22 + 5.5);
    }
    if (this.grainFineWeight > 0) {
      height += this.grainFineWeight * 0.0011 * noise(x * 47 - 8.1, y * 47 - 8.1, z * 47 - 8.1);
    }
    return this.roughness * height;
  }
}

/**
 * Sample the body along every icosphere direction and pull the mesh onto the
 * body's edges: wherever a mesh edge connects two different cut planes, both
 * its ends are moved onto the line (or corner) where those planes meet.
 * Facets therefore end in a straight edge instead of a zig-zag of triangles
 * straddling it. Edges whose rounding is wider than the mesh spacing are
 * left alone: plain sampling already resolves them.
 *
 * Positions are written in unit-sphere space on the sharp body; generate()
 * then moves each vertex along its (stretched) direction onto the rounded,
 * relief-covered surface.
 */
function sampleBody(
  body: CutBody,
  surface: RockSurface,
  base: BaseSphere,
  edgeSnap: number,
  positions: Float32Array
): void {
  const { directions, index } = base;
  const vertexCount = directions.length / 3;
  // Flat index of the plane each vertex lies on (-1: the uncut sphere)
  const plane = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const o = i * 3;
    const r = body.nearest(directions[o], directions[o + 1], directions[o + 2]);
    plane[i] = body.radiusA <= 1 ? body.planeA : -1;
    positions[o] = directions[o] * r;
    positions[o + 1] = directions[o + 1] * r;
    positions[o + 2] = directions[o + 2] * r;
  }
  if (edgeSnap <= 0) {
    return;
  }

  // Mean edge length of the icosphere on the unit sphere
  const meshEdge = 1.07 * Math.sqrt((4 * Math.PI) / vertexCount);
  const [sx, sy, sz] = body.stretch;
  const meanStretch = (sx + sy + sz) / 3;
  // Vertices on edges that are rounded wider than the mesh spacing stay put
  for (let i = 0; i < vertexCount; i++) {
    if (plane[i] < 0) {
      continue;
    }
    const o = i * 3;
    const vx = directions[o] * sx;
    const vy = directions[o + 1] * sy;
    const vz = directions[o + 2] * sz;
    const inv = 1 / Math.hypot(vx, vy, vz);
    const strip = BEVEL_STRIP * surface.bevelAt(vx * inv, vy * inv, vz * inv);
    const spacing =
      meshEdge * meanStretch * Math.hypot(positions[o], positions[o + 1], positions[o + 2]);
    if (strip > SNAP_STRIP_RATIO * spacing) {
      plane[i] = -1;
    }
  }

  // Up to two other planes reached through a mesh edge, per vertex
  const otherA = new Int32Array(vertexCount).fill(-1);
  const otherB = new Int32Array(vertexCount).fill(-1);
  for (let i = 0; i < index.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = index[i + k];
      const neighbourPlane = plane[index[i + ((k + 1) % 3)]];
      const own = plane[v];
      if (own < 0 || neighbourPlane < 0 || neighbourPlane === own) {
        continue;
      }
      if (otherA[v] < 0) {
        otherA[v] = neighbourPlane;
      } else if (otherA[v] !== neighbourPlane && otherB[v] < 0) {
        otherB[v] = neighbourPlane;
      }
    }
  }

  for (let i = 0; i < vertexCount; i++) {
    if (otherA[i] < 0) {
      continue;
    }
    const o = i * 3;
    const limit =
      edgeSnap * meshEdge * Math.hypot(positions[o], positions[o + 1], positions[o + 2]);
    if (
      !body.snapToFeature(positions, o, plane[i], otherA[i], otherB[i], limit) &&
      otherB[i] >= 0
    ) {
      body.snapToFeature(positions, o, plane[i], otherB[i], -1, limit);
    }
  }
  unfoldSnappedTriangles(body, base, positions);
}

/**
 * Snapping can drag a vertex across its neighbours and turn a triangle
 * inside out. The body is convex around the origin, so such a triangle is
 * easy to spot: its normal points inwards. Its vertices are put back on
 * their plain radial sample, repeating until no folded triangle is left.
 */
function unfoldSnappedTriangles(body: CutBody, base: BaseSphere, positions: Float32Array): void {
  const { directions, index } = base;
  for (let pass = 0; pass < 4; pass++) {
    let folded = false;
    for (let i = 0; i < index.length; i += 3) {
      const a = index[i] * 3;
      const b = index[i + 1] * 3;
      const c = index[i + 2] * 3;
      const abx = positions[b] - positions[a];
      const aby = positions[b + 1] - positions[a + 1];
      const abz = positions[b + 2] - positions[a + 2];
      const acx = positions[c] - positions[a];
      const acy = positions[c + 1] - positions[a + 1];
      const acz = positions[c + 2] - positions[a + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      const outward = nx * positions[a] + ny * positions[a + 1] + nz * positions[a + 2];
      if (outward < -1e-12) {
        folded = true;
        for (let k = 0; k < 3; k++) {
          const o = index[i + k] * 3;
          const r = body.radius(directions[o], directions[o + 1], directions[o + 2]);
          positions[o] = directions[o] * r;
          positions[o + 1] = directions[o + 1] * r;
          positions[o + 2] = directions[o + 2] * r;
        }
      }
    }
    if (!folded) {
      return;
    }
  }
}

/**
 * Inertia tensor of a point cloud about its centroid (unit mass per point).
 * I_ij = Σ [δ_ij·r² − x_i·x_j]
 */
function inertiaTensor(points: ArrayLike<number>, count: number): Matrix3 {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < count; i++) {
    cx += points[i * 3];
    cy += points[i * 3 + 1];
    cz += points[i * 3 + 2];
  }
  cx /= count;
  cy /= count;
  cz /= count;

  let Ixx = 0;
  let Iyy = 0;
  let Izz = 0;
  let Ixy = 0;
  let Ixz = 0;
  let Iyz = 0;
  for (let i = 0; i < count; i++) {
    const x = points[i * 3] - cx;
    const y = points[i * 3 + 1] - cy;
    const z = points[i * 3 + 2] - cz;
    const r2 = x * x + y * y + z * z;
    Ixx += r2 - x * x;
    Iyy += r2 - y * y;
    Izz += r2 - z * z;
    Ixy -= x * y;
    Ixz -= x * z;
    Iyz -= y * z;
  }
  const invN = 1 / count;
  return new Matrix3().set(
    Ixx * invN,
    Ixy * invN,
    Ixz * invN,
    Ixy * invN,
    Iyy * invN,
    Iyz * invN,
    Ixz * invN,
    Iyz * invN,
    Izz * invN
  );
}

/**
 * Deterministic restart directions for power iteration, tried in order when
 * the iterated vector collapses to zero (initial guess orthogonal to the
 * dominant eigenvector). Math.random() here would make rock orientations
 * differ between sessions.
 */
const POWER_ITERATION_RESTARTS: readonly Vector3[] = [
  new Vector3(0, 1, 0),
  new Vector3(0, 0, 1),
  new Vector3(1, 1, 1).normalize(),
];

/** Eigenvector of the largest eigenvalue, by power iteration. */
function principalAxis(tensor: Matrix3): Vector3 {
  const v = new Vector3(1, 0, 0);
  const temp = new Vector3();
  const e = tensor.elements;
  let restartCount = 0;

  for (let iter = 0; iter < 20; iter++) {
    temp.set(
      e[0] * v.x + e[3] * v.y + e[6] * v.z,
      e[1] * v.x + e[4] * v.y + e[7] * v.z,
      e[2] * v.x + e[5] * v.y + e[8] * v.z
    );
    const len = temp.length();
    if (len < 1e-6) {
      v.copy(POWER_ITERATION_RESTARTS[restartCount % POWER_ITERATION_RESTARTS.length]);
      restartCount++;
      continue;
    }
    v.copy(temp).multiplyScalar(1 / len);
  }
  return v.normalize();
}

/**
 * Rotation (rows = new X, Y, Z axes) that stands a shape on its broadest
 * face: the stable axis becomes +Y, pointing away from the flatter end.
 * Computed from a fixed coarse sampling of the analytic body, so every
 * detail tier of a shape gets exactly the same pose.
 */
function restingRotation(body: CutBody): number[] {
  const reference = getBaseSphere(POSE_REFERENCE_DETAIL).directions;
  const count = reference.length / 3;
  const cloud = new Float32Array(reference.length);
  const [sx, sy, sz] = body.stretch;
  for (let i = 0; i < count; i++) {
    const ux = reference[i * 3];
    const uy = reference[i * 3 + 1];
    const uz = reference[i * 3 + 2];
    const r = body.radius(ux, uy, uz);
    cloud[i * 3] = ux * r * sx;
    cloud[i * 3 + 1] = uy * r * sy;
    cloud[i * 3 + 2] = uz * r * sz;
  }

  const up = principalAxis(inertiaTensor(cloud, count));

  // The broad face goes down: compare how many samples sit near each end
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const t = cloud[i * 3] * up.x + cloud[i * 3 + 1] * up.y + cloud[i * 3 + 2] * up.z;
    min = Math.min(min, t);
    max = Math.max(max, t);
  }
  const band = (max - min) * 0.15;
  let nearMin = 0;
  let nearMax = 0;
  for (let i = 0; i < count; i++) {
    const t = cloud[i * 3] * up.x + cloud[i * 3 + 1] * up.y + cloud[i * 3 + 2] * up.z;
    if (t < min + band) {
      nearMin++;
    }
    if (t > max - band) {
      nearMax++;
    }
  }
  if (nearMax > nearMin) {
    up.negate();
  }

  // Right-handed basis around `up` (X × Y = Z keeps the triangle winding)
  const helper = Math.abs(up.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
  const axisX = helper.sub(up.clone().multiplyScalar(helper.dot(up))).normalize();
  const axisZ = new Vector3().crossVectors(axisX, up);
  return [axisX.x, axisX.y, axisX.z, up.x, up.y, up.z, axisZ.x, axisZ.y, axisZ.z];
}

/**
 * Drop collapsed triangles (all three vertices snapped onto one edge or
 * corner). Returns the surviving indices.
 */
function removeDegenerateTriangles(positions: Float32Array, index: Uint32Array): Uint32Array {
  const kept = new Uint32Array(index.length);
  let write = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (nx * nx + ny * ny + nz * nz > DEGENERATE_AREA * DEGENERATE_AREA) {
      kept[write++] = index[i];
      kept[write++] = index[i + 1];
      kept[write++] = index[i + 2];
    }
  }
  return kept.slice(0, write);
}

/** Angle at corner `a` of triangle (a, b, c). */
function cornerAngle(positions: Float32Array, a: number, b: number, c: number): number {
  const abx = positions[b] - positions[a];
  const aby = positions[b + 1] - positions[a + 1];
  const abz = positions[b + 2] - positions[a + 2];
  const acx = positions[c] - positions[a];
  const acy = positions[c + 1] - positions[a + 1];
  const acz = positions[c + 2] - positions[a + 2];
  const lengths = Math.hypot(abx, aby, abz) * Math.hypot(acx, acy, acz);
  if (lengths < 1e-20) {
    return 0;
  }
  return Math.acos(Math.max(-1, Math.min(1, (abx * acx + aby * acy + abz * acz) / lengths)));
}

/**
 * Build the final indexed geometry with angle-weighted vertex normals that
 * are smooth within a facet and split wherever adjacent faces meet at more
 * than the crease angle. Only vertices on such edges are duplicated, so the
 * mesh stays close to the welded vertex count while edges render crisp.
 */
function buildCreasedGeometry(
  positions: Float32Array,
  index: Uint32Array,
  creaseAngleDeg: number
): BufferGeometry {
  const vertexCount = positions.length / 3;
  const cornerCount = index.length;
  const faceCount = cornerCount / 3;
  const cosCrease = Math.cos((creaseAngleDeg * Math.PI) / 180);

  // Unit face normals
  const faceNormals = new Float32Array(faceCount * 3);
  for (let f = 0; f < faceCount; f++) {
    const a = index[f * 3] * 3;
    const b = index[f * 3 + 1] * 3;
    const c = index[f * 3 + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const inv = 1 / Math.hypot(nx, ny, nz);
    faceNormals[f * 3] = nx * inv;
    faceNormals[f * 3 + 1] = ny * inv;
    faceNormals[f * 3 + 2] = nz * inv;
  }

  // Corners grouped per vertex (compressed rows)
  const cornerStart = new Uint32Array(vertexCount + 1);
  for (let corner = 0; corner < cornerCount; corner++) {
    cornerStart[index[corner] + 1]++;
  }
  for (let v = 0; v < vertexCount; v++) {
    cornerStart[v + 1] += cornerStart[v];
  }
  const cornersOfVertex = new Uint32Array(cornerCount);
  const fill = cornerStart.slice(0, vertexCount);
  for (let corner = 0; corner < cornerCount; corner++) {
    cornersOfVertex[fill[index[corner]]++] = corner;
  }

  // Worst case every corner becomes its own vertex
  const outPositions = new Float32Array(cornerCount * 3);
  const outNormals = new Float32Array(cornerCount * 3);
  const outIndex = new Uint32Array(cornerCount);
  let outCount = 0;

  // Smoothing groups of the vertex being processed: representative face
  // normal (first face of the group) and the output vertex accumulating it
  const groupNormals: number[] = [];
  const groupVertex: number[] = [];

  for (let v = 0; v < vertexCount; v++) {
    groupNormals.length = 0;
    groupVertex.length = 0;
    for (let k = cornerStart[v]; k < cornerStart[v + 1]; k++) {
      const corner = cornersOfVertex[k];
      const face = Math.floor(corner / 3);
      const slot = corner - face * 3;
      const fx = faceNormals[face * 3];
      const fy = faceNormals[face * 3 + 1];
      const fz = faceNormals[face * 3 + 2];

      let target = -1;
      for (let g = 0; g < groupVertex.length; g++) {
        if (
          groupNormals[g * 3] * fx + groupNormals[g * 3 + 1] * fy + groupNormals[g * 3 + 2] * fz >=
          cosCrease
        ) {
          target = groupVertex[g];
          break;
        }
      }
      if (target < 0) {
        target = outCount++;
        groupNormals.push(fx, fy, fz);
        groupVertex.push(target);
        outPositions[target * 3] = positions[v * 3];
        outPositions[target * 3 + 1] = positions[v * 3 + 1];
        outPositions[target * 3 + 2] = positions[v * 3 + 2];
      }

      const weight = cornerAngle(
        positions,
        v * 3,
        index[face * 3 + ((slot + 1) % 3)] * 3,
        index[face * 3 + ((slot + 2) % 3)] * 3
      );
      outNormals[target * 3] += fx * weight;
      outNormals[target * 3 + 1] += fy * weight;
      outNormals[target * 3 + 2] += fz * weight;
      outIndex[corner] = target;
    }
  }

  const finalPositions = outPositions.slice(0, outCount * 3);
  const finalNormals = outNormals.slice(0, outCount * 3);
  const uvs = new Float32Array(outCount * 2);
  for (let i = 0; i < outCount; i++) {
    const nx = finalNormals[i * 3];
    const ny = finalNormals[i * 3 + 1];
    const nz = finalNormals[i * 3 + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      finalNormals[i * 3] = nx / len;
      finalNormals[i * 3 + 1] = ny / len;
      finalNormals[i * 3 + 2] = nz / len;
    } else {
      finalNormals[i * 3 + 1] = 1;
    }
    // Planar footprint UVs: materials that sample by uv get something sane
    uvs[i * 2] = finalPositions[i * 3] + 0.5;
    uvs[i * 2 + 1] = finalPositions[i * 3 + 2] + 0.5;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(finalPositions, 3));
  geometry.setAttribute('normal', new BufferAttribute(finalNormals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setIndex(
    new BufferAttribute(outCount <= 65535 ? new Uint16Array(outIndex) : outIndex, 1)
  );
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * RockBuilder generates procedural lunar boulders.
 *
 * Algorithm
 * 1. Describe the rock as a convex body: the unit sphere clipped by random
 *    half-spaces (big cuts make the faces, small "chip" cuts knock corners
 *    off), stretched per axis into a block, slab, wedge or cobble.
 * 2. Turn it into a natural surface (RockSurface): edges and corners
 *    rounded by a smooth-min of the plane distances, worn on some edges and
 *    crisp on others, plus radial relief (face undulation, fracture ledges,
 *    spall scars, zap pits, joint cracks, grain) band-limited to the mesh
 *    resolution.
 * 3. Sample that surface along the directions of a welded icosphere of the
 *    requested detail, snapping vertices onto the body's edges and corners
 *    where the rounding is narrower than the mesh spacing, so crisp edges
 *    stay straight at any triangle count.
 * 4. Stand the rock on its broadest face (stable axis → +Y), put its base
 *    on y = 0 and normalize it to a unit footprint and the shape's
 *    canonical height (see rockHeightRatio).
 * 5. Compute normals that are smooth across rounded edges and relief and
 *    hard across crisp edges.
 *
 * Everything is seeded: the same (seed, detail) always yields the same
 * mesh, and all details of a seed share one surface, silhouette and pose
 * (coarse details sample it more coarsely).
 */
// biome-ignore lint/complexity/noStaticOnlyClass: Static class kept as the public namespace used across the app
export class RockBuilder {
  /**
   * Generate a single rock prototype.
   *
   * The result rests on y = 0 with +Y up, is centered in X/Z, has a largest
   * horizontal extent of 1 and a height of rockHeightRatio(seed).
   *
   * @param seed - Shape id / random seed for this rock
   * @param options - Rock generation options
   */
  static generate(seed: number, options: RockLibraryOptions = {}): BufferGeometry {
    const {
      detail = DEFAULT_DETAIL,
      roughness = 1,
      bevel = 1,
      creaseAngle = DEFAULT_CREASE_ANGLE_DEG,
      edgeSnap = DEFAULT_EDGE_SNAP,
    } = options;

    const random = alea(seed);
    const noise3D = createNoise3D(random);
    const heightRatio = rockHeightRatio(seed);
    const body = createCutBody(rockArchetype(seed), heightRatio, random);
    const rotation = restingRotation(body);

    const base = getBaseSphere(detail);
    const vertexCount = base.directions.length / 3;
    const positions = new Float32Array(vertexCount * 3);

    const [sx, sy, sz] = body.stretch;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    // Drawn after the body so the body (and with it the pose) does not
    // depend on the surface parameters
    const surface = new RockSurface(body, noise3D, random, roughness, bevel);
    const meshEdge = 1.07 * Math.sqrt((4 * Math.PI) / vertexCount);
    surface.setSpacing(meshEdge * 0.5 * ((sx + sy + sz) / 3));

    sampleBody(body, surface, base, edgeSnap, positions);

    for (let i = 0; i < vertexCount; i++) {
      const o = i * 3;

      // Direction of the (snapped) sample in the shape's proportions
      let x = positions[o] * sx;
      let y = positions[o + 1] * sy;
      let z = positions[o + 2] * sz;
      const len = Math.hypot(x, y, z);
      if (len > 1e-9) {
        // Onto the rounded body, then out or in by the relief: both radial,
        // so the surface stays star-shaped around the center
        const vx = x / len;
        const vy = y / len;
        const vz = z / len;
        const r = surface.shapeRadius(vx, vy, vz, surface.bevelAt(vx, vy, vz));
        const radius = Math.max(0.05, r + surface.relief(vx * r, vy * r, vz * r));
        x = vx * radius;
        y = vy * radius;
        z = vz * radius;
      }

      // Rotate into the resting pose
      const rx = rotation[0] * x + rotation[1] * y + rotation[2] * z;
      const ry = rotation[3] * x + rotation[4] * y + rotation[5] * z;
      const rz = rotation[6] * x + rotation[7] * y + rotation[8] * z;
      positions[o] = rx;
      positions[o + 1] = ry;
      positions[o + 2] = rz;

      minX = Math.min(minX, rx);
      minY = Math.min(minY, ry);
      minZ = Math.min(minZ, rz);
      maxX = Math.max(maxX, rx);
      maxY = Math.max(maxY, ry);
      maxZ = Math.max(maxZ, rz);
    }

    // Normalize: unit footprint, base on y = 0, canonical height
    const horizontalScale = 1 / Math.max(maxX - minX, maxZ - minZ, 1e-9);
    const verticalScale = heightRatio / Math.max(maxY - minY, 1e-9);
    const centerX = (minX + maxX) / 2;
    const centerZ = (minZ + maxZ) / 2;
    for (let i = 0; i < vertexCount; i++) {
      const o = i * 3;
      positions[o] = (positions[o] - centerX) * horizontalScale;
      positions[o + 1] = (positions[o + 1] - minY) * verticalScale;
      positions[o + 2] = (positions[o + 2] - centerZ) * horizontalScale;
    }

    const index = removeDegenerateTriangles(positions, base.index);
    return buildCreasedGeometry(positions, index, creaseAngle);
  }

  /**
   * Calculate the stable axis of a rock geometry: the principal axis with
   * the largest moment of inertia, i.e. the direction along which the rock
   * is flattest and that points up when it rests on its broadest face.
   *
   * @param geometry - BufferGeometry to analyze
   * @returns Normalized Vector3 representing the stable axis
   */
  static calculateStableAxis(geometry: BufferGeometry): Vector3 {
    const position = geometry.getAttribute('position');
    return principalAxis(inertiaTensor(position.array, position.count));
  }

  /**
   * Generate a library of rock prototype geometries (seeds 0..count-1).
   *
   * @param count - Number of prototypes to generate
   * @param options - Rock generation options (optional)
   */
  static generateLibrary(count: number, options?: RockLibraryOptions): BufferGeometry[] {
    const builder = RockBuilder.createLibraryBuilder(count, options);
    const library: BufferGeometry[] = [];
    let geometry = builder.buildNext();
    while (geometry) {
      library.push(geometry);
      geometry = builder.buildNext();
    }
    return library;
  }

  /**
   * Create an incremental library builder that produces the exact same
   * prototypes as generateLibrary(count, options), one buildNext() call at
   * a time, so callers can spread the work across idle callbacks or frames.
   *
   * @param count - Number of prototypes the builder will produce
   * @param options - Rock generation options (optional)
   */
  static createLibraryBuilder(count: number, options?: RockLibraryOptions): RockLibraryBuilder {
    let next = 0;
    let disposed = false;
    return {
      total: count,
      get builtCount(): number {
        return next;
      },
      buildNext(): BufferGeometry | null {
        if (disposed || next >= count) {
          return null;
        }
        return RockBuilder.generate(next++, options);
      },
      dispose(): void {
        disposed = true;
      },
    };
  }
}
