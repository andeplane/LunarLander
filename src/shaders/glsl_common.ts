export const glslCommon = `
  // ==========================================
  // COMMON NOISE UTILITIES
  // ==========================================
  
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
  vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  // ==========================================
  // 2D SIMPLEX NOISE
  // ==========================================
  
  float simplexNoise(vec2 v) {
    v *= 0.5;
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec2 x1 = x0.xy + C.xx - i1;
    vec2 x2 = x0.xy + C.zz;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x1,x1), dot(x2,x2)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    vec3 g = vec3(0.0);
    g.x = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * vec2(x1.x, x2.x) + h.yz * vec2(x1.y, x2.y);
    return 130.0 * dot(m, g);
  }

  // ==========================================
  // 3D SIMPLEX NOISE (for coordinate distortion)
  // ==========================================
  
  float snoise3D(vec3 v) {
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    
    // First corner
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    
    // Other corners
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    
    // Permutations
    i = mod289(i);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    
    // Gradients
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    
    // Normalize gradients
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;
    
    // Mix contributions
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }

  // ==========================================
  // CELLULAR/VORONOI NOISE (for craters)
  // ==========================================
  
  float cellular(vec3 P) {
    vec3 Pi = floor(P);
    vec3 Pf = P - Pi;
    
    float d = 1e30;
    
    // Search 3x3x3 neighborhood
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        for (int k = -1; k <= 1; k++) {
          vec3 offset = vec3(float(i), float(j), float(k));
          vec3 cellPos = Pi + offset;
          
          // Hash to get random point position within cell
          vec3 p = permute(permute(permute(
                    mod289(vec3(cellPos.x))) + 
                    mod289(vec3(cellPos.y))) + 
                    mod289(vec3(cellPos.z)));
          
          // Random offset within cell (0-1 range)
          vec3 randomOffset = fract(p * vec3(0.1031, 0.1030, 0.0973));
          
          // Point position
          vec3 pointPos = offset + randomOffset - Pf;
          
          // Distance to point (squared for efficiency, but we need actual distance for crater shape)
          float dist = length(pointPos);
          d = min(d, dist);
        }
      }
    }
    
    return d;
  }

  // ==========================================
  // DERIVATIVE-BASED NOISE (Elevated-inspired)
  // Returns vec3(noise, dNoise/dx, dNoise/dy)
  // https://iquilezles.org/articles/morenoise
  // ==========================================
  
  // Rotation matrix to break axis alignment between octaves
  const mat2 m2 = mat2(0.8, -0.6, 0.6, 0.8);
  
  // Hash function for value noise
  float hash2D(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  
  // 2D Value noise with analytical derivatives
  // Returns vec3(noise value, dNoise/dx, dNoise/dy)
  vec3 noised2D(vec2 x) {
    vec2 p = floor(x);
    vec2 f = fract(x);
    
    // Quintic interpolation for smoother derivatives
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
    
    // Sample four corners
    float a = hash2D(p + vec2(0.0, 0.0));
    float b = hash2D(p + vec2(1.0, 0.0));
    float c = hash2D(p + vec2(0.0, 1.0));
    float d = hash2D(p + vec2(1.0, 1.0));
    
    // Bilinear interpolation
    float k0 = a;
    float k1 = b - a;
    float k2 = c - a;
    float k4 = a - b - c + d;
    
    float value = k0 + k1 * u.x + k2 * u.y + k4 * u.x * u.y;
    
    // Analytical derivatives
    vec2 derivatives = du * (vec2(k1, k2) + k4 * u.yx);
    
    return vec3(value, derivatives);
  }
  
  // FBM with derivatives for normal computation (Elevated-inspired)
  // Uses derivative accumulation for erosion-like dampening effect
  // Returns vec3(height, dHeight/dx, dHeight/dy)
  vec3 fbmDerivatives(vec2 p, int octaves, float frequency, float amplitude) {
    float value = 0.0;
    vec2 derivatives = vec2(0.0);
    vec2 derivativeSum = vec2(0.0); // Accumulated derivatives for erosion effect
    
    float amp = amplitude;
    float freq = frequency;
    
    for (int i = 0; i < 8; i++) {
      if (i >= octaves) break;
      
      vec3 n = noised2D(p * freq);
      
      // Erosion-inspired dampening: ridges become sharper as derivatives accumulate
      float erosionFactor = 1.0 / (1.0 + dot(derivativeSum, derivativeSum));
      
      value += amp * n.x * erosionFactor;
      derivatives += amp * n.yz * erosionFactor;
      derivativeSum += n.yz;
      
      // Rotate coordinates between octaves to break axis alignment
      p = m2 * p;
      freq *= 2.0;
      amp *= 0.5;
    }
    
    return vec3(value, derivatives);
  }
  
  // Compute micro-detail normal from FBM derivatives
  // Returns a normal vector that can be blended with the mesh normal
  vec3 computeMicroNormal(vec2 pos, float frequency, float strength, int octaves) {
    vec3 fbmResult = fbmDerivatives(pos, octaves, frequency, 1.0);
    
    // Convert derivatives to normal perturbation
    // Normal = normalize(vec3(-dh/dx, 1.0, -dh/dy)) where h is height
    vec3 microNormal = normalize(vec3(
      -fbmResult.y * strength,
      1.0,
      -fbmResult.z * strength
    ));
    
    return microNormal;
  }
  
  // Blend micro-normal with mesh normal
  // meshNormal: the interpolated vertex normal (world space)
  // microNormal: the computed micro-detail normal (tangent space, Y-up)
  // Returns blended normal in world space
  // Simple additive approach - no tangent frame, no NaN possible
  vec3 blendNormals(vec3 meshNormal, vec3 microNormal, float blendFactor) {
    // microNormal is approximately (perturbX, 1.0, perturbZ) from the noise derivatives
    // We extract just the XZ perturbation and add it to the mesh normal
    // This is simple but works well for mostly-horizontal terrain
    vec3 perturbation = vec3(microNormal.x, 0.0, microNormal.z) * blendFactor;
    return normalize(meshNormal + perturbation);
  }

  // ==========================================
  // FBM (Fractal Brownian Motion)
  // ==========================================
  
  float fbm(in vec2 st, int OCTAVES) {
    int maxOctaves = 16;
    OCTAVES = clamp(OCTAVES, 1, maxOctaves);
    float value = 0.0;
    float amplitude = 0.5;
    
    for (int i = 0; i < OCTAVES; i++) {
      value += amplitude * (simplexNoise(st) * 0.5 + 0.5);
      st *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }
  
  float fbm3D(in vec3 st, int OCTAVES) {
    int maxOctaves = 16;
    OCTAVES = clamp(OCTAVES, 1, maxOctaves);
    float value = 0.0;
    float amplitude = 0.5;
    
    for (int i = 0; i < OCTAVES; i++) {
      value += amplitude * (snoise3D(st) * 0.5 + 0.5);
      st *= 2.0;
      amplitude *= 0.5;
    }
    return value;
  }

  // ==========================================
  // UTILITY FUNCTIONS
  // ==========================================
  
  vec2 distortCoords(in vec2 st, in float strength, in float mapVal) {
    mapVal -= 0.5;
    vec2 ou = st + mapVal * strength;
    return ou;
  }
  
  float remap(float value, float min1, float max1, float min2, float max2) {
    return min2 + (value - min1) * (max2 - min2) / (max1 - min1);
  }

  // ==========================================
  // HEX TILING (adapted from Fabrice Neyret's Shadertoy)
  // https://www.shadertoy.com/view/MdyfDV
  // ==========================================
  
  // Hash function for randomization
  vec2 hexHash(vec2 p) {
    return fract(sin(p * mat2(127.1, 311.7, 269.5, 183.3)) * 43758.5453);
  }
  
  // sRGB <-> linear conversions for contrast-corrected blending
  vec3 srgb2linear(vec3 c) {
    return pow(max(c, vec3(0.0)), vec3(2.2));
  }
  
  vec3 linear2srgb(vec3 c) {
    return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2));
  }
  
  // Hex tiling texture sampler - preserves original UV scale
  // patchScale only controls hex cell density, not texture zoom
  // patchScale = 0 bypasses hex tiling entirely (for debugging)
  vec3 textureNoTileHex(sampler2D samp, vec2 uv, float patchScale, bool useContrastCorrection) {
    // Bypass: patchScale 0 = no hex tiling, just normal sample
    if (patchScale < 0.5) {
      return texture2D(samp, uv).rgb;
    }
    
    mat2 M0 = mat2(1.0, 0.0, 0.5, sqrt(3.0) / 2.0);
    mat2 M = inverse(M0);
    
    // Hex grid at patchScale density - only affects which cell we're in
    vec2 hexCoord = uv * patchScale;
    vec2 V = M * hexCoord;
    vec2 I = floor(V);
    
    // Gradients based on ORIGINAL uv - preserves texture detail
    vec2 Gx = dFdx(uv);
    vec2 Gy = dFdy(uv);
    
    // Mean color for contrast correction
    vec3 meanColor = useContrastCorrection ? texture2D(samp, uv, 99.0).rgb : vec3(0.0);
    
    // Sample at ORIGINAL uv with hex offset - no zoom change
    // Using texture2D - let GPU handle mipmap selection automatically
    #define HEX_SAMPLE(cellId) (texture2D(samp, uv - hexHash(cellId)).rgb - meanColor * float(useContrastCorrection))
    
    vec3 F = vec3(fract(V), 0.0);
    F.z = 1.0 - F.x - F.y;
    vec3 W;
    vec3 fragColor = vec3(0.0);
    
    float textureSampleExp = 8.0;
    float skipThreshold = 0.01;
    
    if (F.z > 0.0) {
      W = vec3(F.z, F.y, F.x);
      W = pow(W, vec3(textureSampleExp));
      W = W / dot(W, vec3(1.0));
      
      if (W.x > skipThreshold) fragColor += HEX_SAMPLE(I) * W.x;
      if (W.y > skipThreshold) fragColor += HEX_SAMPLE(I + vec2(0.0, 1.0)) * W.y;
      if (W.z > skipThreshold) fragColor += HEX_SAMPLE(I + vec2(1.0, 0.0)) * W.z;
    } else {
      W = vec3(-F.z, 1.0 - F.y, 1.0 - F.x);
      W = pow(W, vec3(textureSampleExp));
      W = W / dot(W, vec3(1.0));
      
      if (W.x > skipThreshold) fragColor += HEX_SAMPLE(I + vec2(1.0, 1.0)) * W.x;
      if (W.y > skipThreshold) fragColor += HEX_SAMPLE(I + vec2(1.0, 0.0)) * W.y;
      if (W.z > skipThreshold) fragColor += HEX_SAMPLE(I + vec2(0.0, 1.0)) * W.z;
    }
    
    #undef HEX_SAMPLE
    
    if (useContrastCorrection) {
      fragColor = meanColor + fragColor / length(W);
    }
    
    return clamp(fragColor, 0.0, 1.0);
  }
`;
