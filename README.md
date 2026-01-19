# Lunar Explorer

A browser-based Moon exploration experience built with TypeScript and Three.js, featuring procedural terrain generation with LOD-based chunk streaming, delivering a visually compelling lunar surface you can fly over freely.

**🎮 [Live Demo](https://andeplane.github.io/LunarLander/)** | **📦 [GitHub Repository](https://github.com/andeplane/LunarLander)**

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Installation

```bash
# Clone the repository
git clone https://github.com/andeplane/LunarLander.git
cd LunarLander

# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

The development server will start at `http://localhost:5173` (or the next available port).

## Features

### Visual Effects (Shaders & Lighting)

#### MoonMaterial Shader Features

- **Planetary Curvature Simulation**: Vertex shader bends terrain to simulate a curved planetary surface using the formula `drop = distance² / (2R)`, creating a convincing horizon effect
- **Hex Tiling**: Eliminates texture repetition using Fabrice Neyret's hex tiling technique with contrast-corrected blending
- **Multi-Scale Color Variation**: Simplex noise-based mare/highlands color blending for realistic lunar surface appearance
- **Elevated-Inspired Micro-Detail**: Derivative-based FBM noise for high-frequency normal perturbation, creating surface detail that fades with distance
- **Fresnel Rim Lighting**: Dusty lunar surface glow at grazing angles, simulating light scattering from regolith
- **Enhanced Specular Highlights**: Subtle specular reflections simulating dust particles catching sunlight
- **Sun Horizon Fade**: Custom lighting effects (fresnel, specular) automatically fade when the sun is below the horizon, matching the main sun light

#### Celestial System

- **Sun**: Custom emissive material with bloom effect for realistic solar glow
- **Earth**: Realistic day/night cycle using 4 texture layers (day map, night map, clouds, specular)
- **Milky Way Starfield**: Large-scale skybox with equirectangular starfield texture
- **Four Light Sources**:
  - Sun directional light (main illumination with shadows)
  - Earthshine directional light (weak bluish reflected light from Earth)
  - Spaceship point light (local illumination attached to camera)
  - Flashlight spot light (directional cone pointing where camera looks)
- **Sky Curvature Rotation**: Entire celestial container rotates to simulate travel on a curved planetary surface

### Terrain Generation

#### Procedural Terrain System

The terrain is generated using multi-octave Fractal Brownian Motion (FBM) noise with configurable parameters:

- **Multi-Octave FBM Noise**: Layered noise functions with configurable frequency, amplitude, lacunarity, and gain
- **Biome Blending System**: Smooth transitions between desert and default terrain types
- **Erosion Simulation**: Derivative-based noise dampening creates erosion-like effects on ridges
- **Web Worker Background Generation**: Terrain meshes are generated off the main thread to prevent frame drops

**Key Files:**
- [`src/terrain/terrain.ts`](src/terrain/terrain.ts) - Core terrain generation logic
- [`src/terrain/TerrainGenerator.ts`](src/terrain/TerrainGenerator.ts) - Mesh creation and edge stitching
- [`src/terrain/ChunkWorker.ts`](src/terrain/ChunkWorker.ts) - Web Worker for background generation

#### Crater System

Scientifically accurate crater generation based on real lunar crater statistics:

- **Power-Law Size Distribution**: Follows S(D) ≈ D^-2.4 distribution matching real lunar data
- **Poisson-Distributed Counts**: Realistic crater density using Poisson distribution
- **Parabolic/Flat Floor Profiles**: Configurable floor shapes from parabolic bowls to flat floors
- **Raised Rims**: Realistic rim uplift with smooth falloff
- **Irregular Wobbly Rims**: Multi-frequency simplex noise creates organic, non-circular crater rims
- **Seamless Cross-Chunk Generation**: 3x3 neighbor scan ensures craters crossing chunk boundaries are included

**Key Files:**
- [`src/terrain/craters.ts`](src/terrain/craters.ts) - Crater generation and application

#### Chunk System

High-performance infinite terrain through intelligent chunk management:

- **Distance-Based LOD**: 4 levels (256x256 down to 16x16 vertices) based on camera distance
- **Edge Stitching**: Seamless transitions between chunks with different LOD levels
- **Priority Queue**: Closer chunks are built first for optimal loading
- **Memory-Bounded Pooling**: Automatic chunk disposal to prevent memory leaks

### Rock Generation

#### Procedural Rock Algorithm

Inspired by the gl-rock scraping algorithm, rocks are procedurally generated with realistic angular shapes:

1. **IcosahedronGeometry Base**: Uniform triangulation with merged vertices for clean topology
2. **Scraping Algorithm**: Vertices are projected onto randomly placed planes, creating flat facets
3. **Multi-Octave fBm Noise**: Surface variation using 3 octaves of 3D noise
4. **Moment of Inertia Tensor**: Calculated from geometry to determine stable axis
5. **Power Iteration**: Extracts principal eigenvector for stable orientation

#### Scientific Rock Placement

Based on Rüsch et al. 2024 lunar rock distribution research:

- **Power-Law Distribution**: N(>D) = A × D^-2.5 matches real lunar rock size-frequency data
- **LOD-Aware Minimum Diameter**: Smaller rocks only appear at higher detail levels
- **Slope-Aware Placement**: Rocks prefer flatter surfaces with search radius for optimal positioning
- **Stable Axis Alignment**: Rocks orient their stable axis (principal moment of inertia) with surface normal
- **Realistic Burial Depth**: 40-60% of rock is buried below surface for natural appearance
- **Instanced Rendering**: High-performance rendering using Three.js instanced meshes

**Key Files:**
- [`src/environment/RockBuilder.ts`](src/environment/RockBuilder.ts) - Rock geometry generation
- [`src/environment/RockManager.ts`](src/environment/RockManager.ts) - Rock placement and instancing

### Camera & Controls

Free-flight camera system with smooth movement and terrain awareness:

- **5DOF Flight**: Pitch and yaw rotation (no roll) for intuitive FPS-style controls
- **Smooth Acceleration/Deceleration**: Exponential decay for natural movement feel
- **AGL-Based Vertical Speed Scaling**: Automatic slowdown when descending near terrain
- **Scroll Wheel Speed Adjustment**: Dynamic speed multiplier adjustment
- **Shift Key Speed Boost**: 3x speed multiplier for fast travel
- **Terrain Collision Prevention**: Maintains minimum altitude above ground level

**Controls:**

| Input | Action |
|-------|--------|
| **W/S** | Forward/backward |
| **A/D** | Strafe left/right |
| **Q/E** | Move down/up |
| **Shift** | Speed boost (3x multiplier) |
| **Mouse Move** | Pitch/yaw (when pointer locked) |
| **Scroll Wheel** | Adjust speed multiplier |
| **Click** | Enable pointer lock |

**Key Files:**
- [`src/camera/FlightController.ts`](src/camera/FlightController.ts) - Flight control logic

## Tech Stack

- **TypeScript** - Type-safe development
- **Three.js** - 3D rendering engine (WebGL)
- **Vite** - Development server and bundler
- **simplex-noise** - Procedural noise generation
- **alea** - Seeded random number generation
- **vitest** - Unit testing framework

## Project Structure

```
src/
├── main.ts                 # Entry point, scene setup
├── core/
│   ├── Engine.ts           # Main loop, renderer setup
│   └── InputManager.ts     # Keyboard/mouse handling
├── terrain/
│   ├── ChunkManager.ts     # Chunk lifecycle management
│   ├── TerrainGenerator.ts # Mesh creation and stitching
│   ├── ChunkWorker.ts      # Web Worker for background generation
│   ├── terrain.ts          # Core terrain generation
│   └── craters.ts          # Crater generation system
├── camera/
│   └── FlightController.ts # Free-flight camera controls
├── environment/
│   ├── CelestialSystem.ts  # Sun, Earth, skybox, lighting
│   ├── RockBuilder.ts      # Procedural rock generation
│   └── RockManager.ts      # Rock placement and instancing
├── shaders/
│   ├── MoonMaterial.ts    # Unified lunar surface shader
│   ├── glsl_common.ts      # Shared GLSL utilities
│   ├── EarthMaterial.ts    # Earth day/night shader
│   └── SunMaterial.ts     # Sun emissive material
└── utils/
    ├── noise.ts            # Noise utilities
    └── math.ts             # Math helpers
```

## Performance Targets

| Metric | Target |
|--------|--------|
| Frame rate | 60fps stable |
| Frame time | <16.6ms |
| Draw calls | <500 per frame |
| Triangle count | <2M visible |
| Memory | <1GB GPU, <500MB JS heap |
| Chunk build time | <50ms per chunk |

## Credits & References

- **Elevated Demo** - Derivative-based noise and micro-detail techniques
- **Fabrice Neyret** - Hex tiling technique for texture repetition elimination ([Shadertoy](https://www.shadertoy.com/view/MdyfDV))
- **Rüsch et al. 2024** - Scientific lunar rock size-frequency distribution data

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
