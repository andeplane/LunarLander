import RAPIER from '@dimforge/rapier3d-compat';
import { Matrix4, Vector3 } from 'three';
import type { RockManager } from '../environment/RockManager';
import type { ChunkManager } from '../terrain/ChunkManager';

// Only build hulls within driving distance. Use the renderer's original
// instance transforms so the same boulder stays solid through visual LOD swaps.
export class RoverRocks {
  private readonly colliders = new Map<string, RAPIER.Collider>();
  private readonly matrix = new Matrix4();
  private readonly vertex = new Vector3();
  private readonly size;
  private untilRefresh = 0;
  constructor(
    private readonly world: RAPIER.World,
    private readonly chunks: ChunkManager,
    private readonly rocks: RockManager
  ) {
    this.size = chunks.getBaseTerrainArgs();
  }

  update(x: number, z: number, dt: number) {
    this.untilRefresh -= dt;
    if (this.untilRefresh > 0) return;
    this.untilRefresh = 0.4;
    const reach = 18,
      keep = new Set<string>();
    const { width, depth } = this.size;
    for (let gx = Math.round((x - reach) / width); gx <= Math.round((x + reach) / width); gx++) {
      for (let gz = Math.round((z - reach) / depth); gz <= Math.round((z + reach) / depth); gz++) {
        const chunk = this.chunks.getChunk(`${gx},${gz}`);
        if (!chunk) continue;
        for (const mesh of chunk.boulders) {
          const placements = this.rocks.getPlacementMatrices(mesh);
          if (!placements) continue;
          for (let k = 0; k < placements.length; k += 16) {
            const rx = placements[k + 12] + gx * width,
              rz = placements[k + 14] + gz * depth;
            if ((rx - x) ** 2 + (rz - z) ** 2 > reach * reach) continue;
            const key = `${mesh.id}/${k}`;
            keep.add(key);
            if (this.colliders.has(key)) continue;
            this.matrix.fromArray(placements, k).setPosition(0, 0, 0);
            const attr = mesh.geometry.getAttribute('position');
            const points = new Float32Array(attr.count * 3);
            for (let j = 0; j < attr.count; j++) {
              this.vertex
                .fromBufferAttribute(attr, j)
                .applyMatrix4(this.matrix)
                .toArray(points, 3 * j);
            }
            const desc = RAPIER.ColliderDesc.convexHull(points);
            if (desc)
              this.colliders.set(
                key,
                this.world.createCollider(
                  desc.setTranslation(rx, placements[k + 13], rz).setFriction(0.8)
                )
              );
          }
        }
      }
    }
    for (const [key, c] of this.colliders)
      if (!keep.has(key)) {
        this.world.removeCollider(c, true);
        this.colliders.delete(key);
      }
  }

  dispose() {
    for (const c of this.colliders.values()) this.world.removeCollider(c, true);
    this.colliders.clear();
  }
}
