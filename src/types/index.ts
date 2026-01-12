import * as THREE from 'three';

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
  resolution: number;     // Vertices per chunk edge
  viewDistance: number;   // Chunks to load in each direction
  buildBudget: number;    // Max chunks to build per frame
  disposeBuffer: number;  // Extra distance before disposal
  debugMeshes: boolean;   // Enable debug visualization
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
 * Message sent to worker to request chunk mesh generation
 */
export interface ChunkBuildRequest {
  type: 'build';
  chunkX: number;
  chunkZ: number;
  resolution: number;
  size: number;
  requestId: number;
}

/**
 * Message received from worker with generated mesh data
 */
export interface ChunkBuildResult {
  type: 'built';
  chunkX: number;
  chunkZ: number;
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
  priority: number;
  requestId: number;
}
