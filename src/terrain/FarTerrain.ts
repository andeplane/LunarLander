/**
 * Distant terrain: one coarse mesh that carries the surface from the edge of
 * the chunk grid out to the horizon.
 *
 * Chunks only cover a disc of `renderDistance` chunks around the camera
 * (about 4 km). From a few hundred metres up the horizon is further away than
 * that, so without this the terrain ends in a visible jagged edge against the
 * sky. The far mesh is a world-aligned grid sampled from the same height
 * function as the chunks (relief plus the craters large enough for its
 * spacing), with the cells under the chunk disc left out.
 *
 * Heights are generated in slices spread over several frames, and only when
 * the camera has travelled far enough for the grid to need recentring; the
 * hole is just an index buffer, rebuilt when the chunk disc changes.
 */
import { BufferAttribute, BufferGeometry, type Material, Mesh } from 'three';
import {
  craterParamsFromTerrainArgs,
  generateLargeCratersInBounds,
  LOD_FADE_START,
  rasterizeCraters,
} from './craters';
import {
  createLatticeTerrainEvaluator,
  RELIEF_LATTICE_SPACING,
  type TerrainFieldArgs,
  terrainDisplacementStrength,
} from './terrain';

export interface FarTerrainConfig {
  /** Grid spacing in metres; a multiple of RELIEF_LATTICE_SPACING that divides the chunk size. */
  spacing: number;
  /** Distance from the grid centre to its edge in metres; a multiple of the chunk size. */
  halfExtent: number;
  /** The grid is recentred when the camera is this far from its centre; a multiple of the chunk size. */
  recenterStep: number;
  /** Grid rows generated per slice. */
  rowsPerSlice: number;
  /** Time spent generating per update call, in milliseconds. */
  budgetMs: number;
}

export const DEFAULT_FAR_TERRAIN_CONFIG: FarTerrainConfig = {
  spacing: 100,
  halfExtent: 12000,
  recenterStep: 1600,
  rowsPerSlice: 12,
  budgetMs: 2,
};

/** A generated far grid: `size` x `size` vertices, row-major (row = Z). */
export interface FarTerrainGrid {
  /** World X of column 0 */
  originX: number;
  /** World Z of row 0 */
  originZ: number;
  spacing: number;
  /** Vertices per side */
  size: number;
  /**
   * `size`² surface vertices, followed by a copy of them lowered by
   * FAR_SKIRT_DEPTH_FACTOR spacings for the wall around the chunk hole
   */
  positions: Float32Array;
  normals: Float32Array;
}

/**
 * Depth of the wall hung from the rim of the chunk hole, in grid spacings.
 * The chunks carve craters this grid leaves out, so their edge mostly lies
 * below the far surface and the gap would show the sky.
 */
export const FAR_SKIRT_DEPTH_FACTOR = 1.5;

/** Number of indices a far grid's index buffer must hold. */
export function farTerrainIndexCapacity(size: number): number {
  // Every cell, plus a wall around a hole whose outline is at most twice the
  // grid's own
  return ((size - 1) * (size - 1) + 8 * (size - 1)) * 6;
}

/** The disc of chunks the chunk manager keeps loaded, in chunk grid units. */
export interface ChunkCoverage {
  /** Camera position in chunk units (fractional) */
  centerX: number;
  centerZ: number;
  /** Radius in chunks */
  radius: number;
}

/**
 * Whether the chunk manager loads this chunk for the given coverage. Mirrors
 * ChunkManager.getNearbyChunkPositionKeys.
 */
export function isChunkCovered(gridX: number, gridZ: number, coverage: ChunkCoverage): boolean {
  return Math.hypot(gridX - coverage.centerX, gridZ - coverage.centerZ) <= coverage.radius;
}

/**
 * Generate a far grid centred on (centerX, centerZ), a slice of rows at a
 * time. Yields between slices so the caller can spread the work over frames.
 */
export function* generateFarTerrainGrid(
  args: TerrainFieldArgs,
  centerX: number,
  centerZ: number,
  config: FarTerrainConfig
): Generator<undefined, FarTerrainGrid, undefined> {
  const { spacing, halfExtent } = config;
  if (spacing % RELIEF_LATTICE_SPACING !== 0) {
    throw new Error(`Far terrain spacing must be a multiple of ${RELIEF_LATTICE_SPACING} m`);
  }

  const size = Math.round((2 * halfExtent) / spacing) + 1;
  const originX = centerX - halfExtent;
  const originZ = centerZ - halfExtent;
  const xs = new Float64Array(size);
  const zs = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    xs[i] = originX + i * spacing;
    zs[i] = originZ + i * spacing;
  }

  const evaluate = createLatticeTerrainEvaluator(args);
  const strength = terrainDisplacementStrength(args.smoothLowerPlanes);
  const craterParams = craterParamsFromTerrainArgs(args);
  // Smaller craters have zero weight at this spacing (see craterLodWeight)
  const minCraterRadius = LOD_FADE_START * spacing;

  const heights = new Float64Array(size * size);
  const rowsPerSlice = Math.max(2, Math.floor(config.rowsPerSlice));
  let row0 = 0;
  while (row0 < size) {
    // A lone last row cannot be rasterized on its own, so it joins this slice
    let rowEnd = Math.min(row0 + rowsPerSlice, size);
    if (size - rowEnd < 2) rowEnd = size;

    for (let row = row0; row < rowEnd; row++) {
      const z = zs[row];
      const offset = row * size;
      for (let col = 0; col < size; col++) {
        heights[offset + col] = evaluate(xs[col], z) * strength;
      }
    }

    const craters = generateLargeCratersInBounds(
      { minX: xs[0], maxX: xs[size - 1], minZ: zs[row0], maxZ: zs[rowEnd - 1] },
      args.width,
      args.depth,
      craterParams,
      minCraterRadius
    );
    rasterizeCraters(
      heights.subarray(row0 * size, rowEnd * size),
      xs,
      zs.subarray(row0, rowEnd),
      craters,
      spacing
    );

    row0 = rowEnd;
    if (row0 < size) yield undefined;
  }

  const positions = new Float32Array(size * size * 6);
  const normals = new Float32Array(size * size * 6);
  const skirtOffset = size * size * 3;
  const skirtDepth = FAR_SKIRT_DEPTH_FACTOR * spacing;
  for (let row = 0; row < size; row++) {
    const up = Math.max(row - 1, 0);
    const down = Math.min(row + 1, size - 1);
    for (let col = 0; col < size; col++) {
      const left = Math.max(col - 1, 0);
      const right = Math.min(col + 1, size - 1);
      const index = row * size + col;
      const slopeX =
        (heights[row * size + right] - heights[row * size + left]) / ((right - left) * spacing);
      const slopeZ = (heights[down * size + col] - heights[up * size + col]) / ((down - up) * spacing);
      const inverseLength = 1 / Math.sqrt(slopeX * slopeX + slopeZ * slopeZ + 1);

      positions[index * 3] = xs[col];
      positions[index * 3 + 1] = heights[index];
      positions[index * 3 + 2] = zs[row];
      normals[index * 3] = -slopeX * inverseLength;
      normals[index * 3 + 1] = inverseLength;
      normals[index * 3 + 2] = -slopeZ * inverseLength;

      const skirt = skirtOffset + index * 3;
      positions[skirt] = xs[col];
      positions[skirt + 1] = heights[index] - skirtDepth;
      positions[skirt + 2] = zs[row];
      normals[skirt] = normals[index * 3];
      normals[skirt + 1] = normals[index * 3 + 1];
      normals[skirt + 2] = normals[index * 3 + 2];
    }
  }

  return { originX, originZ, spacing, size, positions, normals };
}

/**
 * Fill `indices` with the triangles of every grid cell that is not under the
 * chunk disc, plus a wall hanging from the rim of the hole and facing into
 * it, and return the number of indices written. `indices` must hold
 * farTerrainIndexCapacity(size) entries.
 */
export function writeFarTerrainIndices(
  indices: Uint32Array,
  grid: Pick<FarTerrainGrid, 'originX' | 'originZ' | 'spacing' | 'size'>,
  chunkWidth: number,
  chunkDepth: number,
  coverage: ChunkCoverage
): number {
  const { originX, originZ, spacing, size } = grid;
  const cellsPerSide = size - 1;
  const covered = new Uint8Array(cellsPerSide * cellsPerSide);
  let count = 0;
  for (let row = 0; row < cellsPerSide; row++) {
    const gridZ = Math.round((originZ + (row + 0.5) * spacing) / chunkDepth);
    for (let col = 0; col < cellsPerSide; col++) {
      const gridX = Math.round((originX + (col + 0.5) * spacing) / chunkWidth);
      if (isChunkCovered(gridX, gridZ, coverage)) {
        covered[row * cellsPerSide + col] = 1;
        continue;
      }
      const v00 = row * size + col;
      const v01 = v00 + size;
      indices[count++] = v00;
      indices[count++] = v01;
      indices[count++] = v00 + 1;
      indices[count++] = v00 + 1;
      indices[count++] = v01;
      indices[count++] = v01 + 1;
    }
  }

  // Wall: one quad per edge between a drawn cell and a covered one, from the
  // surface vertices down to their lowered copies
  const lowered = size * size;
  const wall = (top0: number, top1: number): void => {
    if (count + 6 > indices.length) return;
    indices[count++] = top0;
    indices[count++] = top1;
    indices[count++] = top0 + lowered;
    indices[count++] = top1;
    indices[count++] = top1 + lowered;
    indices[count++] = top0 + lowered;
  };
  for (let row = 0; row < cellsPerSide; row++) {
    for (let col = 0; col < cellsPerSide; col++) {
      const cell = row * cellsPerSide + col;
      if (covered[cell] === 1) continue;
      const v00 = row * size + col;
      const v01 = v00 + size;
      if (row > 0 && covered[cell - cellsPerSide] === 1) wall(v00, v00 + 1);
      if (row < cellsPerSide - 1 && covered[cell + cellsPerSide] === 1) wall(v01 + 1, v01);
      if (col > 0 && covered[cell - 1] === 1) wall(v01, v00);
      if (col < cellsPerSide - 1 && covered[cell + 1] === 1) wall(v00 + 1, v01 + 1);
    }
  }
  return count;
}

/**
 * Identifies the set of covered chunks, so the hole is only rebuilt when a
 * chunk enters or leaves the disc.
 */
export function coverageSignature(coverage: ChunkCoverage): number {
  const reach = Math.ceil(coverage.radius);
  const baseX = Math.round(coverage.centerX);
  const baseZ = Math.round(coverage.centerZ);
  let hash = (Math.imul(baseX, 73856093) ^ Math.imul(baseZ, 19349663)) | 0;
  for (let dz = -reach; dz <= reach; dz++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const covered = isChunkCovered(baseX + dx, baseZ + dz, coverage) ? 1 : 0;
      hash = (Math.imul(hash, 31) + covered) | 0;
    }
  }
  return hash;
}

/** Snap a camera coordinate to the grid centre it should use. */
function snapCenter(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * Owns the far mesh and keeps it centred on the camera.
 */
export class FarTerrain {
  readonly mesh: Mesh;

  private readonly args: TerrainFieldArgs;
  private readonly config: FarTerrainConfig;
  private readonly now: () => number;

  private grid: FarTerrainGrid | null = null;
  private indices: Uint32Array | null = null;
  private signature: number | null = null;

  private pending: Generator<undefined, FarTerrainGrid, undefined> | null = null;
  private pendingCenterX = Number.NaN;
  private pendingCenterZ = Number.NaN;
  private centerX = Number.NaN;
  private centerZ = Number.NaN;

  constructor(
    material: Material,
    args: TerrainFieldArgs,
    config: FarTerrainConfig = DEFAULT_FAR_TERRAIN_CONFIG,
    now: () => number = () => performance.now()
  ) {
    this.args = args;
    this.config = config;
    this.now = now;
    this.mesh = new Mesh(new BufferGeometry(), material);
    // The vertex shader bends the mesh around the planet, so its CPU-side
    // bounds are meaningless; it surrounds the camera anyway.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.visible = false;
  }

  /**
   * Advance generation within the time budget and keep the hole in step with
   * the chunk disc.
   *
   * @returns true when the mesh changed and a new frame should be rendered
   */
  update(cameraX: number, cameraZ: number, coverage: ChunkCoverage): boolean {
    const { recenterStep } = this.config;
    const wantedX = snapCenter(cameraX, recenterStep);
    const wantedZ = snapCenter(cameraZ, recenterStep);
    const targetX = this.pending !== null ? this.pendingCenterX : this.centerX;
    const targetZ = this.pending !== null ? this.pendingCenterZ : this.centerZ;
    // Hysteresis: only recentre once the camera has clearly left the middle
    // block, so hovering on a boundary never regenerates back and forth.
    const drifted =
      Math.abs(cameraX - targetX) >= recenterStep * 0.75 ||
      Math.abs(cameraZ - targetZ) >= recenterStep * 0.75;
    if (Number.isNaN(targetX) || drifted) {
      this.pending = generateFarTerrainGrid(this.args, wantedX, wantedZ, this.config);
      this.pendingCenterX = wantedX;
      this.pendingCenterZ = wantedZ;
    }

    let changed = false;
    if (this.pending !== null) {
      const deadline = this.now() + this.config.budgetMs;
      do {
        const step = this.pending.next();
        if (step.done) {
          this.adoptGrid(step.value, this.pendingCenterX, this.pendingCenterZ);
          changed = true;
          break;
        }
      } while (this.now() < deadline);
    }

    if (this.grid !== null && this.indices !== null) {
      const signature = coverageSignature(coverage);
      if (signature !== this.signature) {
        this.signature = signature;
        const count = writeFarTerrainIndices(
          this.indices,
          this.grid,
          this.args.width,
          this.args.depth,
          coverage
        );
        const index = this.mesh.geometry.getIndex();
        if (index !== null) index.needsUpdate = true;
        this.mesh.geometry.setDrawRange(0, count);
        changed = true;
      }
    }

    return changed;
  }

  /** True once a grid has been generated and is being drawn. */
  get ready(): boolean {
    return this.grid !== null;
  }

  private adoptGrid(grid: FarTerrainGrid, centerX: number, centerZ: number): void {
    this.pending = null;
    this.grid = grid;
    this.centerX = centerX;
    this.centerZ = centerZ;
    this.signature = null;

    this.indices = new Uint32Array(farTerrainIndexCapacity(grid.size));

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(grid.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(grid.normals, 3));
    geometry.setIndex(new BufferAttribute(this.indices, 1));
    geometry.setDrawRange(0, 0);

    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
    this.mesh.visible = true;
  }

  dispose(): void {
    this.pending = null;
    this.grid = null;
    this.indices = null;
    this.mesh.geometry.dispose();
    this.mesh.removeFromParent();
  }
}
