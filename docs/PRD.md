# PRD: Lunar Explorer (Working Title)
**Platform:** Web Browser (Desktop)  
**Tech Stack:** TypeScript, Three.js  
**Doc Owner:** (you)  
**Version:** v1.0  
**Status:** Draft

---

## 1) Product Summary

### One-liner
A **browser-based Moon exploration experience** built with TypeScript and Three.js, featuring **procedural terrain generation** with **LOD-based chunk streaming**, delivering a visually compelling lunar surface you can fly over freely.

### Player fantasy
"I'm soaring over the Moon's surface, watching craters and ridges stretch to the horizon. The terrain is vast and seamless—I can fly anywhere."

---

## 2) Goals

### Primary goals
1. **Beautiful procedural lunar terrain**
   - Realistic heightfield-based terrain with craters, ridges, and surface detail
   - Visually compelling from high altitude down to near-surface

2. **High-performance chunk-based LOD system**
   - Seamless infinite terrain feel
   - Distance-based level-of-detail with smooth transitions
   - Stable 60fps on mid-range hardware

3. **Technical showcase**
   - Clean, well-architected TypeScript codebase
   - Demonstrate modern Three.js terrain techniques
   - Serve as a foundation for future features (VR, landing mechanics)

4. **Accessible experience**
   - Runs in modern browsers without installation
   - Simple keyboard/mouse controls
   - No login or account required

### Success metrics
- Stable 60fps during flight at various altitudes
- Chunk loading/unloading without visible hitches
- Seamless LOD transitions (no popping artifacts)
- Memory usage remains bounded during extended sessions

---

## 3) Non-Goals (Explicitly Out of Scope for v1)

- No VR/WebXR support (future consideration)
- No landing mechanics or physics simulation
- No scoring, leaderboards, or game loop
- No collision detection with terrain
- No multiplayer
- No mobile support (desktop-first)
- No atmospheric effects (Moon has no atmosphere)

---

## 4) Target Audience

### Primary audience
- Developers interested in Three.js terrain techniques
- Space/astronomy enthusiasts
- Tech demo / portfolio showcase viewers
- Potential foundation for a full game

### Positioning statement
A technical demonstration and explorable experience showcasing modern procedural terrain rendering techniques in the browser, set on a beautifully rendered lunar surface.

---

## 5) Core Experience

### The loop
1. Page loads → Three.js scene initializes
2. Camera spawns above lunar surface
3. Player uses keyboard/mouse to fly freely
4. Terrain chunks stream in/out based on camera position
5. LOD adjusts based on distance from camera
6. Player explores indefinitely

### Key moments
- **First load**: Moon surface stretches to the horizon
- **Altitude change**: Flying low reveals surface detail; climbing high shows vast terrain
- **Horizon scanning**: Distant mountains and crater rims visible through LOD system

---

## 6) Technical Architecture

### 6.1 Stack Overview

```
┌─────────────────────────────────────────┐
│              Browser                     │
├─────────────────────────────────────────┤
│  TypeScript Application                  │
│  ├── Three.js (WebGL Renderer)          │
│  ├── Terrain System                      │
│  │   ├── Chunk Manager                  │
│  │   ├── LOD Controller                 │
│  │   ├── Height Generator (Noise)       │
│  │   └── Mesh Builder                   │
│  ├── Camera Controller                   │
│  ├── Lighting System                     │
│  └── UI Layer (minimal)                 │
└─────────────────────────────────────────┘
```

### 6.2 Project Structure (Proposed)

```
src/
├── main.ts                 # Entry point, scene setup
├── core/
│   ├── Engine.ts           # Main loop, renderer setup
│   └── InputManager.ts     # Keyboard/mouse handling
├── terrain/
│   ├── ChunkManager.ts     # Chunk lifecycle management
│   ├── Chunk.ts            # Individual chunk mesh + data
│   ├── LODController.ts    # Distance-based LOD decisions
│   ├── HeightGenerator.ts  # Noise-based terrain generation
│   └── TerrainMaterial.ts  # Lunar surface shader/material
├── camera/
│   └── FlightController.ts # Free-flight camera controls
├── environment/
│   ├── Skybox.ts           # Starfield background
│   └── Lighting.ts         # Sun directional light + shadows
├── utils/
│   ├── noise.ts            # Simplex/Perlin noise utilities
│   └── math.ts             # Vector/math helpers
└── types/
    └── index.ts            # TypeScript type definitions
```

### 6.3 Dependencies

| Package | Purpose |
|---------|---------|
| `three` | 3D rendering engine |
| `simplex-noise` | Procedural noise generation |
| `typescript` | Type-safe development |
| `vite` | Dev server and bundler |

---

## 7) Terrain System Requirements

The terrain system is the core technical challenge and primary focus of this project.

### 7.1 Chunk Grid System

**Must**
- World divided into square chunks on XZ plane
- Chunk size configurable (e.g., 128x128 vertices, 256m world units)
- Chunks identified by grid coordinates (chunkX, chunkZ)
- Active chunks maintained in a ring/grid around camera
- Chunks created/disposed as camera moves

**Implementation approach**
```typescript
interface ChunkCoord {
  x: number;
  z: number;
}

interface ChunkConfig {
  size: number;           // World units per chunk
  resolution: number;     // Vertices per chunk edge
  viewDistance: number;   // Chunks to load in each direction
}
```

### 7.2 Level of Detail (LOD)

**Must**
- Multiple LOD levels per chunk (e.g., LOD 0-3)
- LOD selection based on distance from camera
- Smooth transitions to prevent popping
- Lower LOD = fewer vertices, same chunk size

**LOD Strategy**
| LOD Level | Resolution | Distance Range |
|-----------|------------|----------------|
| 0 (highest) | 128x128 | 0-500m |
| 1 | 64x64 | 500-1500m |
| 2 | 32x32 | 1500-4000m |
| 3 (lowest) | 16x16 | 4000m+ |

**Edge stitching**
- Adjacent chunks with different LODs must stitch seamlessly
- Options: skirts, edge vertex matching, or geometry morphing

### 7.3 Height Generation

**Must**
- Deterministic: same seed produces same terrain
- Multi-octave noise for natural appearance
- Crater generation (stamped or procedural)
- Height query API for any world position

**Noise composition**
```typescript
height(x, z) = 
    baseNoise(x, z) * baseScale +
    ridgeNoise(x, z) * ridgeScale +
    detailNoise(x, z) * detailScale +
    craterModifier(x, z)
```

**Parameters**
- Base terrain scale: large rolling hills (1-2km wavelength)
- Ridge noise: medium-scale features (200-500m)
- Detail noise: small surface variation (10-50m)
- Crater stamps: various sizes with rim uplift

### 7.4 Chunk Lifecycle

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│  Queued  │────▶│ Building │────▶│  Active  │────▶│ Disposed │
└──────────┘     └──────────┘     └──────────┘     └──────────┘
     │                                  │
     │          Camera moves            │
     └──────────────────────────────────┘
```

**Must**
- Background mesh generation (don't block main thread)
- Priority queue: closer chunks build first
- Geometry pooling/reuse where possible
- Graceful LOD transitions during movement

### 7.5 Memory Management

**Must**
- Maximum chunk count limit
- Dispose distant chunks (geometry, materials)
- Monitor and cap memory usage
- Avoid garbage collection spikes

---

## 8) Rendering Requirements

### 8.1 Lunar Surface Material

**Must**
- Physically-based rendering (PBR)
- Grayscale lunar regolith appearance
- Normal mapping for surface detail
- Slope-based shading variation (lighter/darker on slopes)

**Nice-to-have**
- Triplanar mapping to reduce stretching on steep terrain
- Detail textures that tile at close range
- Subtle specular response (lunar regolith is slightly glossy at angles)

### 8.2 Lighting

**Must**
- Single directional light (Sun)
- Hard shadows (Moon has no atmosphere to soften them)
- Configurable sun angle/time of day
- Ambient light minimal (slight fill from earthshine)

**Shadow configuration**
- Cascaded shadow maps for terrain
- Shadow map resolution: 2048-4096
- Shadow distance: at least view distance

### 8.3 Sky/Environment

**Must**
- Black sky with starfield
- Stars as skybox or particle system
- Earth visible (static textured sphere at correct relative position)
- Sun as bright point or lens flare

**Nice-to-have**
- Milky Way band
- Accurate star positions (catalog-based)

### 8.4 Performance Targets

| Metric | Target |
|--------|--------|
| Frame rate | 60fps stable |
| Frame time | <16.6ms |
| Draw calls | <500 per frame |
| Triangle count | <2M visible |
| Memory | <1GB GPU, <500MB JS heap |
| Chunk build time | <50ms per chunk |

---

## 9) Camera & Controls

### 9.1 Flight Camera

**Must**
- Free-flight 6DOF camera (pitch, yaw, roll + translation)
- Smooth acceleration/deceleration
- Speed adjustment (slow for close inspection, fast for travel)
- No collision with terrain (fly-through allowed in v1)

**Control scheme (keyboard + mouse)**
| Input | Action |
|-------|--------|
| W/S | Forward/backward |
| A/D | Strafe left/right |
| Q/E | Roll left/right |
| Space/Shift | Up/down |
| Mouse move | Pitch/yaw (when pointer locked) |
| Scroll wheel | Adjust speed multiplier |
| Click | Enable pointer lock |

### 9.2 Camera Parameters

```typescript
interface CameraConfig {
  fov: number;              // 60-75 degrees
  near: number;             // 0.1m
  far: number;              // 100000m (100km)
  baseSpeed: number;        // 50 m/s default
  minSpeed: number;         // 1 m/s
  maxSpeed: number;         // 1000 m/s
  acceleration: number;     // Smoothing factor
  mouseSensitivity: number;
}
```

---

## 10) User Interface

### Philosophy
Minimal HUD. The focus is on the terrain and experience.

### Must have
- FPS counter (toggle-able)
- Current altitude display
- Current speed display
- Coordinates display (debug, toggle-able)

### Nice-to-have
- Minimap showing chunk grid
- LOD visualization mode (color chunks by LOD level)
- Wireframe toggle
- Stats panel (draw calls, triangles, memory)

---

## 11) Build & Development

### 11.1 Development Setup

```bash
npm create vite@latest moon-explorer -- --template vanilla-ts
cd moon-explorer
npm install three simplex-noise
npm install -D @types/three
```

### 11.2 Scripts

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |

### 11.3 Browser Support

**Target:** Modern evergreen browsers with WebGL 2.0
- Chrome 90+
- Firefox 90+
- Safari 15+
- Edge 90+

---

## 12) Testing Strategy

### Manual testing checklist
- [ ] Terrain generates correctly from seed
- [ ] Chunks load/unload as camera moves
- [ ] LOD transitions are smooth
- [ ] No visual seams between chunks
- [ ] Memory stays bounded over 10+ minutes
- [ ] 60fps maintained during normal flight
- [ ] Controls feel responsive

### Automated tests (nice-to-have)
- Height generator produces deterministic results
- Chunk coordinates calculated correctly
- LOD selection logic is correct

---

## 13) Risks & Mitigations

### Risk: Chunk seams visible at LOD boundaries
**Mitigation:** 
- Implement geometry skirts
- Or: match edge vertices to lower-LOD neighbor
- Or: vertex morphing in shader

### Risk: Hitching during chunk generation
**Mitigation:**
- Generate mesh data in Web Worker
- Spread work across frames
- Priority queue based on camera movement direction

### Risk: Memory leaks from disposed chunks
**Mitigation:**
- Explicit disposal of geometry and materials
- Use `dispose()` on all Three.js objects
- Monitor heap in dev tools

### Risk: Noise generation too slow
**Mitigation:**
- Pre-compute noise in chunks
- Use typed arrays for height data
- Consider GPU compute (WebGPU in future)

### Risk: Terrain looks too uniform/procedural
**Mitigation:**
- Layer multiple noise frequencies
- Add crater stamps
- Domain warping for more organic shapes
- Slope-based material variation

---

## 14) Release Criteria (v1)

A build is "complete" when:

1. **Terrain system works**
   - Chunks stream in/out seamlessly
   - LOD transitions without popping
   - Deterministic generation from seed

2. **Performance is stable**
   - 60fps maintained during flight
   - No memory leaks over extended sessions
   - Chunk loading doesn't cause hitches

3. **Visually compelling**
   - Lunar surface looks realistic
   - Lighting and shadows work correctly
   - Horizon and distance rendering are convincing

4. **Controls are responsive**
   - Flight feels smooth
   - Speed adjustment works
   - No input lag

---

## 15) Future Ideas (Post-v1)

- **WebXR/VR support** - Immersive VR exploration
- **Landing mode** - Physics-based lunar lander gameplay
- **Points of interest** - Specific locations to discover (Apollo sites, etc.)
- **Day/night cycle** - Animated sun position
- **Terrain features** - Rilles, mare/highland transitions
- **Vehicle** - Visible spacecraft model
- **Collision** - Terrain collision and crash mechanics
- **Mobile support** - Touch controls, performance optimization
- **Multiplayer** - Shared exploration sessions
- **Procedural rocks** - Instanced surface detail objects

---

## 16) Open Questions

- **Chunk size trade-offs**: What's the optimal chunk size vs resolution?
- **LOD transition method**: Skirts vs edge matching vs morphing?
- **Noise library**: `simplex-noise` vs custom implementation vs GPU noise?
- **Shadow approach**: Cascaded shadow maps vs other techniques?
- **Crater distribution**: Random scatter vs based on size distribution curves?

---

## 17) References

### Technical resources
- [Three.js Documentation](https://threejs.org/docs/)
- [Three.js Fundamentals - Custom BufferGeometry](https://threejsfundamentals.org/threejs/lessons/threejs-custom-buffergeometry.html)
- [GPU Gems - Terrain Rendering](https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry)

### Visual references
- NASA Lunar Reconnaissance Orbiter imagery
- Apollo mission photographs
- Existing lunar visualization projects

---

## Appendix A: Noise Function Reference

### Multi-octave noise
```typescript
function fractalNoise(
  x: number, 
  z: number, 
  octaves: number, 
  persistence: number, 
  lacunarity: number, 
  scale: number
): number {
  let total = 0;
  let frequency = 1;
  let amplitude = 1;
  let maxValue = 0;
  
  for (let i = 0; i < octaves; i++) {
    total += noise2D(x * frequency / scale, z * frequency / scale) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  
  return total / maxValue;
}
```

### Crater stamp function
```typescript
function craterHeight(
  x: number, 
  z: number, 
  craterX: number, 
  craterZ: number, 
  radius: number, 
  depth: number
): number {
  const dist = Math.sqrt((x - craterX) ** 2 + (z - craterZ) ** 2);
  const normDist = dist / radius;
  
  if (normDist > 1.5) return 0;
  
  // Bowl shape with raised rim
  if (normDist < 1.0) {
    // Inside crater - bowl shape
    return -depth * (1 - normDist * normDist);
  } else {
    // Rim - raised edge that falls off
    const rimDist = (normDist - 1.0) / 0.5;
    return depth * 0.3 * Math.exp(-rimDist * rimDist * 3);
  }
}
```

---

## Appendix B: Chunk Data Structure

```typescript
interface Chunk {
  // Identity
  coord: ChunkCoord;
  
  // State
  state: 'queued' | 'building' | 'active' | 'disposing';
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

interface ChunkManager {
  // Configuration
  config: ChunkConfig;
  
  // State
  activeChunks: Map<string, Chunk>;
  buildQueue: ChunkCoord[];
  
  // Methods
  update(cameraPosition: THREE.Vector3): void;
  getHeightAt(worldX: number, worldZ: number): number;
  dispose(): void;
}
```

---
