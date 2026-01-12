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
  geometry: THREE.BufferGeometry | null;
  
  // Height data (for queries)
  heightData: Float32Array | null;
  
  // Lifecycle
  lastAccessTime: number;
  distanceToCamera: number;
}
