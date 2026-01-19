import { LOD, type Mesh, type InstancedMesh, type Scene } from 'three';

/**
 * Clean high-level container for a terrain chunk.
 * Contains terrain mesh + rock instances with LOD management.
 * No terrain implementation details - edge stitching handled by TerrainGenerator.
 */
export class Chunk {
  readonly gridKey: string;
  readonly lod: LOD;
  readonly builtLevels: Set<number> = new Set();
  currentLodLevel: number = 0;

  private terrainMeshes: (Mesh | null)[];
  // Multiple rock meshes per LOD level (one per prototype)
  private rockMeshes: InstancedMesh[][];
  private lodLevelCount: number;

  constructor(gridKey: string, worldX: number, worldZ: number, lodLevelCount: number) {
    this.gridKey = gridKey;
    this.lodLevelCount = lodLevelCount;

    // Initialize mesh arrays
    this.terrainMeshes = new Array(lodLevelCount).fill(null);
    // Each LOD level can have multiple rock meshes (one per prototype)
    this.rockMeshes = new Array(lodLevelCount).fill(null).map(() => []);

    // Create LOD object and position it in world space
    this.lod = new LOD();
    this.lod.position.x = worldX;
    this.lod.position.z = worldZ;

    // Disable Three.js LOD auto-update - we manually control mesh visibility
    this.lod.autoUpdate = false;
  }

  /**
   * Add to scene
   */
  addToScene(scene: Scene): void {
    scene.add(this.lod);
  }

  /**
   * Remove from scene
   */
  removeFromScene(scene: Scene): void {
    scene.remove(this.lod);
  }

  /**
   * Add a terrain mesh at the specified LOD level
   */
  addTerrainMesh(mesh: Mesh, lodLevel: number, distance: number): void {
    // Dispose old mesh at this level if exists
    const oldMesh = this.terrainMeshes[lodLevel];
    if (oldMesh) {
      oldMesh.geometry.dispose();
      this.lod.remove(oldMesh);
    }

    this.terrainMeshes[lodLevel] = mesh;
    this.builtLevels.add(lodLevel);

    // Add to LOD object with distance threshold
    this.lod.addLevel(mesh, distance);
  }

  /**
   * Get terrain mesh at specific LOD level
   */
  getTerrainMesh(lodLevel: number): Mesh | null {
    return this.terrainMeshes[lodLevel] ?? null;
  }

  /**
   * Add rock mesh at the specified LOD level
   */
  addRockMesh(mesh: InstancedMesh, lodLevel: number): void {
    // Add to array of rock meshes for this LOD level
    this.rockMeshes[lodLevel].push(mesh);

    // Add rocks directly to LOD object
    this.lod.add(mesh);
  }

  /**
   * Get rock meshes at specific LOD level
   */
  getRockMeshes(lodLevel: number): InstancedMesh[] {
    return this.rockMeshes[lodLevel] ?? [];
  }

  /**
   * Set the active LOD level and update mesh visibility
   * Note: Rock visibility is controlled separately based on bounding sphere screen space size.
   */
  setLodLevel(lodLevel: number): void {
    this.currentLodLevel = lodLevel;

    // Set visibility: only the active LOD level terrain meshes are visible
    // Rock visibility is controlled by ChunkManager.updateRockVisibility() based on screen space size
    for (let i = 0; i < this.lodLevelCount; i++) {
      const isActive = i === lodLevel;

      const terrainMesh = this.terrainMeshes[i];
      if (terrainMesh) {
        terrainMesh.visible = isActive;
      }
    }
  }

  /**
   * Check if a specific LOD level has been built
   */
  hasLodLevel(lodLevel: number): boolean {
    return this.builtLevels.has(lodLevel);
  }

  /**
   * Get the number of LOD levels
   */
  getLodLevelCount(): number {
    return this.lodLevelCount;
  }

  /**
   * Find any available built LOD level, preferring the closest to desired
   */
  findBestAvailableLod(desiredLod: number): number {
    if (this.builtLevels.has(desiredLod)) {
      return desiredLod;
    }

    // Try coarser LODs first
    let lod = desiredLod;
    while (lod < this.lodLevelCount && !this.builtLevels.has(lod)) {
      lod++;
    }

    if (lod < this.lodLevelCount) {
      return lod;
    }

    // Try finer LODs
    lod = desiredLod - 1;
    while (lod >= 0 && !this.builtLevels.has(lod)) {
      lod--;
    }

    if (lod >= 0) {
      return lod;
    }

    // Return first available, or 0 if none
    const first = this.builtLevels.values().next().value;
    return first ?? 0;
  }

  /**
   * Clean up all resources
   */
  dispose(): void {
    // Dispose terrain meshes
    for (const mesh of this.terrainMeshes) {
      if (mesh) {
        mesh.geometry.dispose();
      }
    }

    // Dispose rock meshes (multiple per LOD level)
    for (const rockMeshesAtLod of this.rockMeshes) {
      for (const mesh of rockMeshesAtLod) {
        mesh.geometry.dispose();
      }
    }

    // Clear arrays
    this.terrainMeshes = [];
    this.rockMeshes = [];
    this.builtLevels.clear();
  }
}
