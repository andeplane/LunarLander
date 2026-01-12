import * as THREE from 'three';

// ============================================
// LOD Level Definitions
// ============================================

/**
 * LOD level configuration
 * Resolution determines vertex count: triangles = 2 * (resolution-1)^2
 */
export interface LODLevelConfig {
  level: number;        // LOD level (0 = lowest detail)
  resolution: number;   // Vertices per edge
  maxScreenSize: number; // Max screen size (pixels) before needing higher LOD
}

/**
 * Default LOD levels (5 levels from 2 triangles to 512 triangles)
 * Higher thresholds = use lower LOD more often (better performance)
 */
export const LOD_LEVELS: LODLevelConfig[] = [
  { level: 0, resolution: 2, maxScreenSize: 50 },     // 2 triangles
  { level: 1, resolution: 4, maxScreenSize: 150 },    // 18 triangles
  { level: 2, resolution: 7, maxScreenSize: 300 },    // 72 triangles
  { level: 3, resolution: 9, maxScreenSize: 500 },    // 128 triangles
  { level: 4, resolution: 17, maxScreenSize: Infinity } // 512 triangles
];

/**
 * Get resolution for a given LOD level
 */
export function getResolutionForLOD(lodLevel: number): number {
  const config = LOD_LEVELS[lodLevel];
  return config ? config.resolution : LOD_LEVELS[0].resolution;
}

/**
 * Get target LOD level based on screen size
 */
export function getTargetLODForScreenSize(screenSize: number): number {
  for (let i = 0; i < LOD_LEVELS.length; i++) {
    if (screenSize < LOD_LEVELS[i].maxScreenSize) {
      return i;
    }
  }
  return LOD_LEVELS.length - 1;
}

// ============================================
// Chunk Types
// ============================================

/**
 * Chunk coordinate in the terrain grid
 */
export interface ChunkCoord {
  x: number;
  z: number;
}

/**
 * Configuration for chunk system
 */
export interface ChunkConfig {
  size: number;           // World units per chunk
  viewDistance: number;   // Base chunks to load in each direction
  buildBudget: number;    // Max chunks to build per frame
  lodUpgradeBudget: number; // Max LOD upgrades per frame
  disposeBuffer: number;  // Extra distance before disposal
  debugMeshes: boolean;   // Enable debug visualization
  minScreenSize?: number; // Minimum pixels on screen to load chunk (default: 10)
  altitudeScale?: number; // How much altitude affects view distance (default: 0.01)
  frustumMargin?: number; // Margin for frustum culling (default: 1.2)
}

/**
 * Camera configuration parameters
 */
export interface CameraConfig {
  fov: number;              // 60-75 degrees
  near: number;             // 0.1m
  far: number;              // 100000m (100km)
  baseSpeed: number;        // 50 m/s default
  minSpeed: number;         // 1 m/s
  maxSpeed: number;         // 1000 m/s
  acceleration: number;     // Smoothing factor
  mouseSensitivity: number;
}

/**
 * Chunk state in lifecycle
 */
export type ChunkState = 'queued' | 'building' | 'active' | 'disposing';

/**
 * Chunk data structure
 */
export interface Chunk {
  // Identity
  coord: ChunkCoord;
  
  // State
  state: ChunkState;
  lodLevel: number;
  
  // Three.js objects
  mesh: THREE.Mesh | null;
  wireframeMesh: THREE.Mesh | null;  // Debug wireframe overlay
  geometry: THREE.BufferGeometry | null;
  
  // Height data (for queries)
  heightData: Float32Array | null;
  
  // Lifecycle
  lastAccessTime: number;
  distanceToCamera: number;
  priority: number;  // Lower = higher priority (build first)
}

// ============================================
// Worker Message Types
// ============================================

/**
 * LOD levels of neighboring chunks for edge stitching
 * -1 means neighbor doesn't exist (treat as same LOD)
 */
export interface NeighborLODs {
  // Cardinal neighbors (for edge stitching)
  north: number;  // +Z direction
  south: number;  // -Z direction
  east: number;   // +X direction
  west: number;   // -X direction
  // Diagonal neighbors (for corner stitching)
  northeast: number;  // +X, +Z
  northwest: number;  // -X, +Z
  southeast: number;  // +X, -Z
  southwest: number;  // -X, -Z
}

/**
 * Message sent to worker to request chunk mesh generation
 */
export interface ChunkBuildRequest {
  type: 'build';
  chunkX: number;
  chunkZ: number;
  lodLevel: number;   // LOD level determines resolution
  size: number;
  requestId: number;
  neighborLODs: NeighborLODs;  // For edge stitching
}

/**
 * Message received from worker with generated mesh data
 */
export interface ChunkBuildResult {
  type: 'built';
  chunkX: number;
  chunkZ: number;
  lodLevel: number;   // LOD level that was built
  requestId: number;
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Union type for all worker messages
 */
export type WorkerMessage = ChunkBuildRequest;
export type WorkerResponse = ChunkBuildResult;

/**
 * Chunk in the build queue with priority
 */
export interface QueuedChunk {
  coord: ChunkCoord;
  lodLevel: number;   // LOD level to build
  priority: number;
  requestId: number;
}
