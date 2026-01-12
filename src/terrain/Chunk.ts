import * as THREE from 'three';
import type { ChunkCoord, ChunkState } from '../types';

/**
 * Individual chunk representing a terrain mesh section
 * Responsible for:
 * - Chunk mesh geometry creation from worker data
 * - Debug visualization with colored triangles
 * - Height data storage
 * - LOD level management
 */
export class Chunk {
  public coord: ChunkCoord;
  public state: ChunkState = 'queued';
  public mesh: THREE.Mesh | null = null;
  public wireframeMesh: THREE.Mesh | null = null;
  public geometry: THREE.BufferGeometry | null = null;
  public heightData: Float32Array | null = null;
  public lodLevel: number = 0;
  public lastAccessTime: number = 0;
  public distanceToCamera: number = Infinity;
  public priority: number = Infinity;

  constructor(coord: ChunkCoord) {
    this.coord = coord;
  }

  /**
   * Create mesh from worker-generated data
   */
  createMeshFromData(
    vertices: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    debugMode: boolean
  ): void {
    // Create geometry
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    if (debugMode) {
      this.createDebugMesh();
    } else {
      this.createStandardMesh();
    }

    this.state = 'active';
    this.lastAccessTime = performance.now();
  }

  /**
   * Create standard terrain mesh
   */
  private createStandardMesh(): void {
    if (!this.geometry) return;

    const material = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.9,
      metalness: 0.1,
      side: THREE.DoubleSide
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
  }

  /**
   * Create debug mesh with colored triangles and wireframe overlay
   */
  private createDebugMesh(): void {
    if (!this.geometry) return;

    // Generate unique color based on chunk coordinates
    const baseColor = this.getChunkColor();

    // Add vertex colors for triangle distinction
    this.addVertexColors(baseColor);

    // Create material with flat shading to see individual triangles
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);

    // Create wireframe overlay to show triangle edges clearly
    const wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0.3
    });

    // Clone geometry for wireframe to avoid conflicts
    const wireframeGeometry = this.geometry.clone();
    this.wireframeMesh = new THREE.Mesh(wireframeGeometry, wireframeMaterial);
    // Slight offset to prevent z-fighting
    this.wireframeMesh.position.y = 0.1;
  }

  /**
   * Generate a unique color based on chunk coordinates
   * Uses a deterministic formula so the same chunk always gets the same color
   */
  private getChunkColor(): THREE.Color {
    // Use golden ratio to spread colors evenly
    const goldenRatio = 0.618033988749895;
    
    // Create hue from chunk coordinates
    const hue = ((this.coord.x * 0.1 + this.coord.z * goldenRatio) % 1 + 1) % 1;
    
    // Use high saturation and medium lightness for visibility
    const saturation = 0.7;
    const lightness = 0.5;

    const color = new THREE.Color();
    color.setHSL(hue, saturation, lightness);
    return color;
  }

  /**
   * Add vertex colors to geometry for triangle distinction
   * Each triangle gets a slightly varied color
   */
  private addVertexColors(baseColor: THREE.Color): void {
    if (!this.geometry) return;

    const positions = this.geometry.getAttribute('position');
    const indices = this.geometry.getIndex();
    
    if (!positions || !indices) return;

    // Create color array (3 floats per vertex)
    const colors = new Float32Array(positions.count * 3);
    
    // Process each triangle
    const indexArray = indices.array;
    const triangleCount = indexArray.length / 3;

    for (let tri = 0; tri < triangleCount; tri++) {
      // Vary the color slightly for each triangle
      const variation = (tri % 10) / 30; // Small variation within chunk
      const r = Math.min(1, baseColor.r + variation);
      const g = Math.min(1, baseColor.g + variation * 0.5);
      const b = Math.min(1, baseColor.b - variation * 0.5);

      // Apply color to all three vertices of this triangle
      for (let v = 0; v < 3; v++) {
        const vertexIndex = indexArray[tri * 3 + v];
        colors[vertexIndex * 3] = r;
        colors[vertexIndex * 3 + 1] = g;
        colors[vertexIndex * 3 + 2] = b;
      }
    }

    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  /**
   * Add mesh to scene
   */
  addToScene(scene: THREE.Scene): void {
    if (this.mesh) {
      scene.add(this.mesh);
    }
    if (this.wireframeMesh) {
      scene.add(this.wireframeMesh);
    }
  }

  /**
   * Remove mesh from scene
   */
  removeFromScene(scene: THREE.Scene): void {
    if (this.mesh) {
      scene.remove(this.mesh);
    }
    if (this.wireframeMesh) {
      scene.remove(this.wireframeMesh);
    }
  }

  /**
   * Update LOD level
   */
  updateLOD(level: number): void {
    this.lodLevel = level;
    // LOD implementation will be added in future tickets
  }

  /**
   * Dispose chunk resources
   */
  dispose(): void {
    this.state = 'disposing';

    if (this.geometry) {
      this.geometry.dispose();
      this.geometry = null;
    }

    if (this.mesh) {
      if (this.mesh.material) {
        if (Array.isArray(this.mesh.material)) {
          this.mesh.material.forEach(m => m.dispose());
        } else {
          this.mesh.material.dispose();
        }
      }
      this.mesh = null;
    }

    if (this.wireframeMesh) {
      if (this.wireframeMesh.geometry) {
        this.wireframeMesh.geometry.dispose();
      }
      if (this.wireframeMesh.material) {
        if (Array.isArray(this.wireframeMesh.material)) {
          this.wireframeMesh.material.forEach(m => m.dispose());
        } else {
          this.wireframeMesh.material.dispose();
        }
      }
      this.wireframeMesh = null;
    }

    this.heightData = null;
  }
}
