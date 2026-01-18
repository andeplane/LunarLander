# Lunar surface terrian generator

Tutorial 1:
🌑 Tutorial: The "Distorted Voronoi" Surface
The secret to the "Blender Moon" look isn't modeling; it's math applied to coordinates. We are creating a height map where white = high (rims) and black = low (pits).

Step 1: The "Wobbly Space" (Domain Warping)
If you place a standard Voronoi texture, you get perfect, geometric circles. They look man-made. Real craters are messy because the ground they hit was uneven.

The Technique:
Instead of asking for the texture at pixel (x, y), we ask for the texture at (x + noise, y + noise).

In Blender: Texture Coordinate $\rightarrow$ MixRGB (Add) $\rightarrow$ Voronoi Vector.
In Code:
// 1. Get a random noise value for this pixel
const shiftX = noise(x, y) * distortionStrength;
const shiftY = noise(x + 50, y + 50) * distortionStrength;

// 2. Sample the Voronoi using the shifted coordinates
// The Voronoi "cells" now appear to stretch and warp organically
getVoronoi(x + shiftX, y + shiftY);
Step 2: The "Inverted Pit" (The Float Curve)
Standard Voronoi creates "bubbles" that are highest in the center (Cell Distance). We need Craters (lowest in the center).

The Technique:
We need a mathematical curve that takes the Voronoi output (0.0 to 1.0) and flips it into a crater profile.

The Profile needed:
Outside the cell: Flat ground (0).
Cell Edge: Sharp rise (The Rim).
Cell Center: Deep drop (The Pit).
The Math:
We approximate the Blender "Float Curve" node using a polynomial function:
Height = (Spike_at_Edge) - (Bowl_Shape_at_Center)
Step 3: Fractal Stacking (Big vs. Small)
A single layer of Voronoi looks like a golf ball. To look like a moon, we need distinct "generations" of impacts.

The Technique:
We generate the texture twice (or three times) at different scales and add them together.

Layer A (Ancient Impacts):
Scale: Huge (Low frequency).
Distortion: High (Very wobbly, creating "bays" and "seas").
Depth: Deep.
Layer B (Recent Impacts):
Scale: Tiny (High frequency).
Distortion: Low (More circular, as they hit fresh rock).
Depth: Shallow.
Step 4: The "Regolith" (Micro-Surface)
The moon is covered in dust and pulverized rock. Between the craters, the surface shouldn't be smooth pixels.

The Technique:
We use Ridged Multifractal Noise.

Standard Noise: Smooth hills ( -1 to 1 ).
Ridged Noise: 1.0 - abs(noise).
Taking the absolute value creates sharp creases at 0.
Inverting it turns those creases into sharp little ridges, simulating rocky debris and dust piles.
How our TypeScript Engine implements this
Since we are ignoring the base crater, our Engine Code (moonEngine.ts) is already set up perfectly for this. It is purely generating this "Main Texture."

largeCraterScale controls Layer A.
largeCraterDistortion controls Step 1 (Warping).
smallCraterScale controls Layer B.
getHeteroTerrain controls Step 4 (Regolith).
You can simply run the script provided in the previous step, and it will generate this texture surface at 16k resolution.


The Mathematics of Moon Dust: A Deep Dive
In the Blender video, the artist isn't just "adding noise." He is manipulating a mathematical signal. To recreate the surface texture (the gritty, rocky, flowing regolith), we need to implement three specific mathematical concepts:

Fractional Brownian Motion (fBm) (The "Detail")
Persistence (The "Roughness")
Domain Warping (The "Distortion")
Let's break these down into equations and logic.

Part 1: The Core Signal (Fractal Brownian Motion)
In the video, the artist sets the Noise Texture Detail to 15.
In standard noise libraries (like Simplex or Perlin), you only get a smooth, blurry blobs. This creates a "plastic" look. To get a "rock" look, we need Fractal Brownian Motion (fBm).

The Concept
FBM is the process of layering noise on top of itself. Each layer is called an Octave.

Octave 1: Defines the mountains.
Octave 2: Defines the boulders.
Octave 3: Defines the rocks.
Octave 4: Defines the sand.
The Equation
The height $H$ of any pixel at coordinates $(x, y)$ is defined by the summation $\sum$ of these layers.

$$ H(x,y) = \sum_{i=0}^{n} A_i \cdot Noise(f_i \cdot x, f_i \cdot y) $$

Where:

$n$ is the number of Octaves (Blender's "Detail" slider).
$A$ is the Amplitude (How distinct the layer is).
$f$ is the Frequency (how small the features are).
The "Roughness" Variable
In the video, he adjusts the Roughness slider. In math, this is called Persistence.
In every loop of the summation, the features get smaller (frequency increases), but they must also get weaker (amplitude decreases), otherwise the result is just white noise.

The relationship is:
$$ f_{i+1} = f_i \cdot 2.0 $$
$$ A_{i+1} = A_i \cdot Roughness $$

If Roughness is 0.5: The boulders are half the height of the mountains. The rocks are half the height of the boulders.
If Roughness is 0.8: The rocks are nearly as big as the mountains. This creates a very gritty, sharp surface.

Logic Implementation
To write this in TypeScript, we don't just call noise once. We create a loop.

function getSurfaceHeight(x: number, y: number) {
    let totalValue = 0;
    let amplitude = 1;
    let frequency = 0.005; // The "Scale"
    const roughness = 0.6; // Blender's "Roughness" slider
    const octaves = 15;    // Blender's "Detail" slider

    for(let i = 0; i < octaves; i++) {
        // We add the noise to our accumulator
        totalValue += noise2D(x * frequency, y * frequency) * amplitude;

        // We prepare variables for the next smaller, rougher layer
        amplitude *= roughness; 
        frequency *= 2; 
    }

    return totalValue;
}
Part 2: Domain Warping (The Distortion)
This is the most critical part of the tutorial. At timestamp 08:40, the artist adds "Distortion".
Without distortion, noise looks like clouds—puffy and round.
With distortion, noise looks like liquid rock—swirled, pinched, and stretched.

The Concept
Domain Warping works by lying to the noise function about where we are looking. Instead of asking for the noise value at pixel $(x, y)$, we ask for the value at pixel $(x + \text{offset}, y + \text{offset})$.

Crucially, the offset is itself generated by noise.

The Equation
If our standard noise function is $f(p)$, Domain Warping defines a new function $g(p)$:

$$ g(p) = f\big( p + s \cdot h(p) \big) $$

Where:

$p$ is our coordinate vector $(x, y)$.
$f$ is our surface texture noise.
$h$ is a separate noise function used purely to shove the coordinates around.
$s$ is the Distortion Strength (The scale of the push).
Visual Explanation
Imagine a checkerboard.

Generate a noise map that represents "wind direction."
Push every square on the checkerboard slightly in the direction of the wind.
The checkerboard is now wavy and liquid-like.
Apply the rocky texture onto this wavy checkerboard.
Logic Implementation
In TypeScript, we calculate the offset before we calculate the surface brightness.

// 1. Calculate the Warp
// We use a low frequency here because we want big swirls, not jittery swirls.
const distortionStrength = 20.0; 
const warpX = noise2D(x * 0.01, y * 0.01) * distortionStrength;
const warpY = noise2D(x * 0.01 + 50, y * 0.01 + 50) * distortionStrength;

// 2. Apply the Warp to the Input
// Notice we add warpX to x. 
const surfaceBrightness = getSurfaceHeight(x + warpX, y + warpY);
Part 3: Contrast and Thresholding (The Color Ramp)
In the video, the resulting noise is gray and flat. He uses a Color Ramp node to crush the values. This makes the darks darker and the lights lighter, defining the sharpness of the rock.

The Equation (Linear Interpolation)
The raw noise usually outputs values between -1 and 1 (or 0 and 1 depending on the library). We need to compress this range.

If we want to sharpen the texture, we apply a power function (Gamma correction):

$$ Value_{sharp} = Value_{raw}^{Power} $$

Or, we can use an inverse lerp to set a "floor" and "ceiling".

$$ Value_{clamped} = \frac{Value - \text{BlackLevel}}{\text{WhiteLevel} - \text{BlackLevel}} $$

Any result less than 0 becomes pure black shadow. Any result higher than 1 becomes pure white peak.

Putting it Together: The Full Algorithm
Here is the complete logic flow to generate the surface texture, utilizing the equations above.

1. The Dependencies
You need a 2D noise function.
npm install simplex-noise

2. The TypeScript Implementation
Here is the code structure that combines FBM (Part 1) and Domain Warping (Part 2).

import { createNoise2D } from 'simplex-noise';

// Initialize two separate noise generators
// One for the shape of the terrain, one for the distortion swirls
const surfaceNoise = createNoise2D(() => Math.random()); 
const warpNoise = createNoise2D(() => Math.random()); 

// Helper: Linear Interpolation for color mixing
const lerp = (start: number, end: number, t: number) => start * (1 - t) + end * t;

// --- SETTINGS (Tweak these to match Blender) ---
const CONFIG = {
    scale: 0.005,       // Zoom level
    detail: 8,          // FBM Octaves (How many layers of grit)
    roughness: 0.6,     // Persistence (How strong the grit is)
    distortion: 40.0,   // How much the rock "swirls"
    contrast: 1.5,      // Sharpening the texture
};

export function generateMoonTexture(width: number, height: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            
            // --- STEP 1: DOMAIN WARPING (Equation Part 2) ---
            // We calculate a distortion vector based on the warpNoise generator
            const qx = x * 0.01; 
            const qy = y * 0.01;
            
            const displaceX = warpNoise(qx, qy) * CONFIG.distortion;
            const displaceY = warpNoise(qx + 5.2, qy + 1.3) * CONFIG.distortion;

            // --- STEP 2: FRACTAL BROWNIAN MOTION (Equation Part 1) ---
            // We feed the *displaced* coordinates (x + displaceX) into the FBM loop
            let amplitude = 1.0;
            let frequency = 1.0;
            let noiseValue = 0;
            let normalization = 0;

            // The Loop (Summation)
            for (let i = 0; i < CONFIG.detail; i++) {
                const nx = (x + displaceX) * CONFIG.scale * frequency;
                const ny = (y + displaceY) * CONFIG.scale * frequency;

                // Add noise layer
                noiseValue += surfaceNoise(nx, ny) * amplitude;
                
                // Track max potential value to normalize later
                normalization += amplitude;

                // Prepare next octave
                amplitude *= CONFIG.roughness; // Decrease amplitude
                frequency *= 2.0;              // Increase frequency
            }

            // Normalize to 0..1 range
            noiseValue = (noiseValue / normalization) + 0.5;

            // --- STEP 3: CONTRAST (Equation Part 3) ---
            // Apply a power curve to sharpen edges
            // Similar to tightening the handles on a Color Ramp
            noiseValue = Math.pow(noiseValue, CONFIG.contrast);
            
            // Clamp to ensure we stay valid
            noiseValue = Math.max(0, Math.min(1, noiseValue));

            // --- STEP 4: COLOR MAPPING ---
            // Map 0..1 to Moon Colors (Dark Grey to Light Grey)
            const moonDark = 30;
            const moonLight = 200;
            
            const finalColor = lerp(moonDark, moonLight, noiseValue);

            // Write to pixel array
            const idx = (x + y * width) * 4;
            data[idx] = finalColor;     // R
            data[idx + 1] = finalColor; // G
            data[idx + 2] = finalColor; // B
            data[idx + 3] = 255;        // Alpha
        }
    }
    return data;
}
Summary of what just happened:
We selected a pixel coordinate $(x,y)$.
We calculated a noise value for that coordinate to determine a "wind" direction.
We shifted our $(x,y)$ coordinate in that direction (Domain Warping).
We calculated the noise at that new location 8 times (8 Octaves), making the noise smaller and quieter each time, and added them together (FBM).
We increased the contrast using a Power function.
We mapped the result to a grey color.

🌑 Noise‑Based Moon Texture — A Practical Tutorial

This tutorial walks step‑by‑step from raw math to a production‑ready near‑surface Moon texture (1–2 m scale). The goal is not cinematic orbital craters, but regolith, sharp rims, micro‑impacts, and dust flow that holds up right in front of the camera.

We will reproduce the classic "Blender Moon" look using pure math, suitable for WebGL / Three.js / visionOS / Unity / Unreal / shaders.

0. Design Constraints (Important)

Before touching code, lock these constraints:

❌ No macro craters (km‑scale)

❌ No erosion or water flow

❌ No smooth sand dunes

✅ Sharp, fractured, dry regolith

✅ Micro‑craters everywhere

✅ Hard contrast in normals > albedo

Everything below enforces those rules.

1. Mental Model

The Moon surface is three independent signals:

Impact topology → Voronoi (craters)

Fragmented dust & debris → Ridged fBm

Chaos → Domain warping

Geometry comes from math, realism comes from how signals are combined.

2. Core Noise Building Block

We assume a deterministic 2D noise source.

import { createNoise2D } from 'simplex-noise';
const noise = createNoise2D(() => 1234); // fixed seed

All terrain is built from this single primitive.

3. Domain Warping (The Secret Sauce)

Without warping:

Noise looks cloudy

Voronoi looks procedural

With warping:

Noise looks crushed, pinched, broken

Concept

Instead of sampling noise at (x, y), we lie about the coordinates.

p' = p + warp(p)
Implementation
function domainWarp(x: number, y: number, strength: number) {
  const wx = noise(x * 0.01, y * 0.01) * strength;
  const wy = noise(x * 0.01 + 37.1, y * 0.01 + 91.7) * strength;
  return [x + wx, y + wy];
}

Low frequency → large swirling fractures

High frequency → jitter (❌ avoid)

4. Fractal Brownian Motion (Regolith Detail)

Simple noise = plastic

We need layered noise.

Equation

𝐻
(
𝑥
,
𝑦
)
=
∑
𝐴
𝑖
⋅
𝑛
𝑜
𝑖
𝑠
𝑒
(
𝑓
𝑖
𝑥
,
𝑓
𝑖
𝑦
)
H(x,y)=∑A
i
	​

⋅noise(f
i
	​

x,f
i
	​

y)


Where:

f *= 2
A *= roughness
Implementation
function fbm(x: number, y: number, octaves = 8, roughness = 0.6) {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;


  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= roughness;
    freq *= 2;
  }


  return sum / norm;
}

Use high octaves (8–15). This is where grit comes from.

5. Ridged Noise (Dust & Debris)

Moon dust isn’t smooth. It forms creases.

Trick
ridged = 1.0 - abs(noise)
Implementation
function ridgedFbm(x: number, y: number) {
  let v = fbm(x, y, 10, 0.55);
  return 1.0 - Math.abs(v);
}

This single line adds rocky sharpness everywhere.

6. Craters Using Distorted Voronoi
Why Voronoi?

Cell edges → rims

Cell centers → pits

But perfect circles are fake.

Warp the domain first
const [wx, wy] = domainWarp(x, y, 40);
const d = voronoiDistance(wx * scale, wy * scale);
Invert the profile (crater shape)
function craterProfile(d: number) {
  const rim = smoothstep(0.45, 0.5, d);
  const pit = Math.pow(1.0 - d, 3.5);
  return rim - pit;
}

Rim = sharp

Pit = steep drop

7. Multi‑Generation Impacts

Real Moon = impacts over billions of years.

Layer	Scale	Depth	Distortion
Ancient	Large	Deep	High
Recent	Small	Shallow	Low
height =
  craterA * 1.0 +
  craterB * 0.3;

Never equal weights.

8. Contrast (Color Ramp Math)

Raw noise is gray mush.

Power Curve
value = Math.pow(value, contrast);

1.0 → soft

1.5 → Moon‑like

2.0 → brutal rock

9. Final Assembly Pipeline
warp → fbm → ridged → craters → contrast → output

Normals matter more than albedo.

Generate:

Height map

Normal map (sobel or ddx/ddy)

Albedo from compressed height

10. Artist‑Friendly Parameters

Expose only meaningful knobs:

Parameter	Meaning
scale	meters per pixel
roughness	regolith sharpness
distortion	fracture chaos
craterDensity	impacts per m²
contrast	visual harshness

If a parameter doesn’t describe physics → remove it.

11. Common Mistakes

❌ Using erosion ❌ Smooth noise ❌ Too many crater sizes ❌ Low‑frequency ridges ❌ Soft normals

12. What This Gives You

✔ Works at 1–2 m altitude ✔ Procedural & infinite ✔ Deterministic ✔ GPU‑friendly ✔ Blender‑quality look

If you want next steps, we can:

Convert this to a GLSL / WGSL shader

Generate normal maps correctly

Match Apollo close‑up photos

Integrate with clipmap terrain

Add realistic rock instancing rules

Just say the word.

This is a very solid foundation already — you’re basically reverse-engineering what good Blender artists do intuitively and expressing it as math 👍
I’ve turned it into a clean, end-to-end tutorial in the canvas that:

Starts from physical intuition (regolith, impacts, fracture)

Explains why each noise technique exists

Shows minimal but correct math

Produces a texture that holds up at 1–2 m altitude, not orbital shots

A few important notes specific to your use case (Moon lander, near-surface):

Key Takeaways (Worth Emphasizing)
1. Domain warping is non-optional

If you remove it, everything instantly looks procedural.
Moon surfaces are fractured, not smooth.

Rule of thumb:

Warp frequency lower than surface noise

Warp strength large (tens of pixels)

2. Ridged noise > regular noise for regolith

Normal fBm gives dunes.
Ridged fBm gives pulverized rock and dust piles.

This is the single most common mistake in “moon textures”.

3. Craters are signals, not geometry

For near-surface:

Craters should be shallow

Rims should dominate normals, not albedo

Distorted Voronoi beats any heightmap photo

4. Contrast belongs late in the pipeline

Crushing values too early destroys detail.
Always:

warp → fbm → ridged → crater → contrast

Why this works better than heightmaps

Apollo photos fail close-up because:

Lighting baked into albedo

No control over normal harshness

No scale continuity

This method gives:

Infinite resolution

Physically interpretable parameters

Stable normals under moving light