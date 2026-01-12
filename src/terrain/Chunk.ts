import * as THREE from 'three';
import type { ChunkCoord, ChunkState } from '../types';

/**
 * LOD mesh data stored for each level
 */
interface LODMeshData {
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  wireframeMesh: THREE.Mesh | null;
}

/**
 * Individual chunk representing a terrain mesh section
 * Responsible for:
 * - Storing multiple LOD level meshes
 * - Chunk mesh geometry creation from worker data
 * - Debug visualization with colored triangles
 * - LOD level switching for rendering
 */
export class Chunk {
  public coord: ChunkCoord;
  public state: ChunkState = 'queued';
  public heightData: Float32Array | null = null;
  public lastAccessTime: number = 0;
  public distanceToCamera: number = Infinity;
  public priority: number = Infinity;

  // LOD management
  private lodMeshes: Map<number, LODMeshData> = new Map();
  private currentRenderingLOD: number = -1;
  private highestGeneratedLOD: number = -1;
  private scene: THREE.Scene | null = null;

  // Currently active mesh (for scene management)
  private activeMesh: THREE.Mesh | null = null;
  private activeWireframeMesh: THREE.Mesh | null = null;

  constructor(coord: ChunkCoord) {
    this.coord = coord;
  }

  /**
   * Get the highest LOD level that has been generated
   */
  getHighestGeneratedLOD(): number {
    return this.highestGeneratedLOD;
  }

  /**
   * Get the current LOD level being rendered
   */
  getCurrentRenderingLOD(): number {
    return this.currentRenderingLOD;
  }

  /**
   * Public accessor for the current LOD level (actual built mesh LOD)
   */
  get currentLOD(): number {
    return this.currentRenderingLOD;
  }

  /**
   * Check if a specific LOD level has been generated
   */
  hasLOD(level: number): boolean {
    return this.lodMeshes.has(level);
  }

  /**
   * Add LOD mesh from worker-generated data
   */
  addLODFromData(
    lodLevel: number,
    vertices: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    debugMode: boolean
  ): void {
    // Create geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Create mesh
    let mesh: THREE.Mesh;
    let wireframeMesh: THREE.Mesh | null = null;

    if (debugMode) {
      const result = this.createDebugMeshForGeometry(geometry);
      mesh = result.mesh;
      wireframeMesh = result.wireframeMesh;
    } else {
      mesh = this.createStandardMeshForGeometry(geometry);
    }

    // Store LOD data
    this.lodMeshes.set(lodLevel, {
      geometry,
      mesh,
      wireframeMesh
    });

    // Update highest generated LOD
    if (lodLevel > this.highestGeneratedLOD) {
      this.highestGeneratedLOD = lodLevel;
    }

    this.state = 'active';
    this.lastAccessTime = performance.now();

    // If this is the first LOD or higher than current, switch to it
    if (this.currentRenderingLOD < 0 || lodLevel > this.currentRenderingLOD) {
      this.switchToLOD(lodLevel);
    }
  }

  /**
   * Replace an existing LOD mesh with updated data (for edge rebuilds)
   * Does NOT trigger LOD switching - maintains current rendering state
   */
  replaceLODMesh(
    lodLevel: number,
    vertices: Float32Array,
    normals: Float32Array,
    indices: Uint32Array,
    debugMode: boolean
  ): void {
    const oldData = this.lodMeshes.get(lodLevel);
    const wasCurrentlyRendering = this.currentRenderingLOD === lodLevel;

    // Remove old mesh from scene if it was rendering
    if (wasCurrentlyRendering && this.scene) {
      if (this.activeMesh) {
        this.scene.remove(this.activeMesh);
      }
      if (this.activeWireframeMesh) {
        this.scene.remove(this.activeWireframeMesh);
      }
    }

    // Dispose old geometry and meshes
    if (oldData) {
      oldData.geometry.dispose();
      if (oldData.mesh.material instanceof THREE.Material) {
        oldData.mesh.material.dispose();
      }
      if (oldData.wireframeMesh?.material instanceof THREE.Material) {
        oldData.wireframeMesh.material.dispose();
      }
    }

    // Create new geometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    // Create new mesh
    let mesh: THREE.Mesh;
    let wireframeMesh: THREE.Mesh | null = null;

    if (debugMode) {
      const result = this.createDebugMeshForGeometry(geometry);
      mesh = result.mesh;
      wireframeMesh = result.wireframeMesh;
    } else {
      mesh = this.createStandardMeshForGeometry(geometry);
    }

    // Store updated LOD data
    this.lodMeshes.set(lodLevel, {
      geometry,
      mesh,
      wireframeMesh
    });

    // Re-add to scene if this was the currently rendering LOD
    if (wasCurrentlyRendering && this.scene) {
      this.scene.add(mesh);
      if (wireframeMesh && wireframeMesh.visible) {
        this.scene.add(wireframeMesh);
      }
      this.activeMesh = mesh;
      this.activeWireframeMesh = wireframeMesh;
    }

    this.lastAccessTime = performance.now();
  }

  /**
   * Switch to rendering a specific LOD level
   * Returns true if successful, false if LOD not available
   */
  switchToLOD(lodLevel: number): boolean {
    const lodData = this.lodMeshes.get(lodLevel);
    if (!lodData) {
      return false;
    }

    // If already rendering this LOD, no change needed
    if (this.currentRenderingLOD === lodLevel) {
      return true;
    }

    // If in scene, swap meshes
    if (this.scene) {
      // Remove current mesh
      if (this.activeMesh) {
        this.scene.remove(this.activeMesh);
      }
      if (this.activeWireframeMesh) {
        this.scene.remove(this.activeWireframeMesh);
      }

      // Add new mesh
      this.scene.add(lodData.mesh);
      // Only add wireframe if it exists and is visible (debug mode)
      if (lodData.wireframeMesh && lodData.wireframeMesh.visible) {
        this.scene.add(lodData.wireframeMesh);
      }
    }

    // Update active references
    this.activeMesh = lodData.mesh;
    this.activeWireframeMesh = (lodData.wireframeMesh && lodData.wireframeMesh.visible) ? lodData.wireframeMesh : null;
    this.currentRenderingLOD = lodLevel;

    return true;
  }

  /**
   * Get the best available LOD for a target level
   * Returns the highest LOD we have that doesn't exceed the target
   */
  getBestAvailableLOD(targetLOD: number): number {
    // Find the highest LOD we have that's <= target
    let bestLOD = -1;
    for (const [level] of this.lodMeshes) {
      if (level <= targetLOD && level > bestLOD) {
        bestLOD = level;
      }
    }
    
    // If no suitable LOD found, return highest we have
    if (bestLOD < 0 && this.lodMeshes.size > 0) {
      return this.highestGeneratedLOD;
    }
    
    return bestLOD;
  }

  /**
   * Switch all meshes to use debug or standard materials
   * Preserves geometry and meshes, only changes materials
   */
  recreateMeshesWithDebugMode(debugMode: boolean): void {
    for (const [level, lodData] of this.lodMeshes) {
      const geometry = lodData.geometry;
      const mesh = lodData.mesh;
      const isCurrentLOD = level === this.currentRenderingLOD;

      // Dispose old material
      if (mesh.material) {
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }

      // Create new material based on debug mode
      if (debugMode) {
        // Ensure vertex colors exist for debug mode
        if (!geometry.getAttribute('color')) {
          const baseColor = this.getChunkColor();
          this.addVertexColorsToGeometry(geometry, baseColor);
        }

        // Create debug material with vertex colors
        mesh.material = new THREE.MeshBasicMaterial({
          vertexColors: true,
          side: THREE.DoubleSide,
        });

        // Create wireframe mesh if it doesn't exist
        if (!lodData.wireframeMesh) {
          const wireframeMaterial = new THREE.MeshBasicMaterial({
            color: 0x000000,
            wireframe: true,
            transparent: true,
            opacity: 0.3
          });
          const wireframeGeometry = geometry.clone();
          const wireframeMesh = new THREE.Mesh(wireframeGeometry, wireframeMaterial);
          wireframeMesh.position.y = 0.1;
          lodData.wireframeMesh = wireframeMesh;
        }

        // Add wireframe to scene only if this is the current LOD and mesh is in scene
        if (isCurrentLOD && this.scene && mesh.parent === this.scene) {
          if (!lodData.wireframeMesh.parent) {
            this.scene.add(lodData.wireframeMesh);
          }
          lodData.wireframeMesh.visible = true;
        }
      } else {
        // Create standard material
        mesh.material = new THREE.MeshStandardMaterial({
          color: 0x888888,
          roughness: 0.9,
          metalness: 0.1,
          side: THREE.DoubleSide
        });

        // Remove wireframe mesh from scene if it exists and is current LOD
        if (lodData.wireframeMesh) {
          if (isCurrentLOD && lodData.wireframeMesh.parent) {
            lodData.wireframeMesh.parent.remove(lodData.wireframeMesh);
          }
          lodData.wireframeMesh.visible = false;
        }
      }
    }

    // Update active references for current LOD
    const currentLodData = this.lodMeshes.get(this.currentRenderingLOD);
    if (currentLodData) {
      this.activeMesh = currentLodData.mesh;
      this.activeWireframeMesh = debugMode ? currentLodData.wireframeMesh : null;
    }
  }

  /**
   * Create standard terrain mesh for a geometry
   */
  private createStandardMeshForGeometry(geometry: THREE.BufferGeometry): THREE.Mesh {
    const material = new THREE.MeshStandardMaterial({
      color: 0x888888,
      roughness: 0.9,
      metalness: 0.1,
      side: THREE.DoubleSide
    });

    return new THREE.Mesh(geometry, material);
  }

  /**
   * Create debug mesh with colored triangles and wireframe overlay
   */
  private createDebugMeshForGeometry(geometry: THREE.BufferGeometry): { mesh: THREE.Mesh; wireframeMesh: THREE.Mesh } {
    // Generate unique color based on chunk coordinates
    const baseColor = this.getChunkColor();

    // Add vertex colors for triangle distinction
    this.addVertexColorsToGeometry(geometry, baseColor);

    // Create material with flat shading to see individual triangles
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);

    // Create wireframe overlay to show triangle edges clearly
    const wireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      wireframe: true,
      transparent: true,
      opacity: 0.3
    });

    // Clone geometry for wireframe to avoid conflicts
    const wireframeGeometry = geometry.clone();
    const wireframeMesh = new THREE.Mesh(wireframeGeometry, wireframeMaterial);
    // Slight offset to prevent z-fighting
    wireframeMesh.position.y = 0.1;

    return { mesh, wireframeMesh };
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
  private addVertexColorsToGeometry(geometry: THREE.BufferGeometry, baseColor: THREE.Color): void {
    const positions = geometry.getAttribute('position');
    const indices = geometry.getIndex();
    
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

    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  /**
   * Add mesh to scene (will add current LOD mesh)
   */
  addToScene(scene: THREE.Scene): void {
    this.scene = scene;

    if (this.activeMesh) {
      scene.add(this.activeMesh);
    }
    if (this.activeWireframeMesh) {
      scene.add(this.activeWireframeMesh);
    }
  }

  /**
   * Remove mesh from scene
   */
  removeFromScene(scene: THREE.Scene): void {
    if (this.activeMesh) {
      scene.remove(this.activeMesh);
    }
    if (this.activeWireframeMesh) {
      scene.remove(this.activeWireframeMesh);
    }
    this.scene = null;
  }

  /**
   * Dispose chunk resources (all LOD levels)
   */
  dispose(): void {
    this.state = 'disposing';

    // Dispose all LOD meshes
    for (const [, lodData] of this.lodMeshes) {
      lodData.geometry.dispose();

      if (lodData.mesh.material) {
        if (Array.isArray(lodData.mesh.material)) {
          lodData.mesh.material.forEach(m => m.dispose());
        } else {
          lodData.mesh.material.dispose();
        }
      }

      if (lodData.wireframeMesh) {
        if (lodData.wireframeMesh.geometry) {
          lodData.wireframeMesh.geometry.dispose();
        }
        if (lodData.wireframeMesh.material) {
          if (Array.isArray(lodData.wireframeMesh.material)) {
            lodData.wireframeMesh.material.forEach(m => m.dispose());
          } else {
            lodData.wireframeMesh.material.dispose();
          }
        }
      }
    }

    this.lodMeshes.clear();
    this.activeMesh = null;
    this.activeWireframeMesh = null;
    this.currentRenderingLOD = -1;
    this.highestGeneratedLOD = -1;
    this.heightData = null;
    this.scene = null;
  }
}
