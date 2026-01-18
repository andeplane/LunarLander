import { ModifiedStandardMaterial } from './ModifiedStandardMaterial';


export class TerrainMaterial extends ModifiedStandardMaterial {

  constructor() {
    super(`
    vec4 diffuseFn() {
      float noise = fbm(v_Position.xz * 3.0, 5);
      
      vec2 p_dist_rock = distortCoords(v_Normal.xy, 0.5, noise);
      float map_rock = clamp(pow(remap(p_dist_rock.y, 0.56, 0.67, 1.0, 0.0), 1.0), 0.0, 1.0);
      
      // Lunar color palette: mare (dark basalt) vs highlands (light anorthosite)
      vec4 mare_color = vec4(0.12, 0.11, 0.13, 1.0);        // Dark gray-brown (mare basalt)
      vec4 highlands_color = vec4(0.35, 0.33, 0.31, 1.0);    // Light gray (highlands anorthosite)
      
      // Base ground color varies between mare and highlands based on biome
      vec4 ground_color_low = mix(mare_color, highlands_color, v_Biome.x);
      vec4 ground_color_high = mix(
        vec4(0.25, 0.24, 0.23, 1.0),  // Medium gray regolith
        vec4(0.40, 0.38, 0.36, 1.0),  // Lighter highlands
        v_Biome.x
      );

      // Surface variation color (for crater effects and local variation)
      vec4 variation_color = mix(
        vec4(0.08, 0.08, 0.10, 1.0),  // Very dark (crater bottoms)
        vec4(0.20, 0.19, 0.18, 1.0),  // Dark variation
        v_Biome.x
      );
      
      // Rock color (darker formations)
      vec4 rock_color = mix(
        vec4(0.22, 0.24, 0.3, 1.0),   // Dark gray with slight blue tint
        vec4(0.35, 0.35, 0.40, 1.0),  // Lighter rock
        v_Biome.x
      );

      // Surface variation based on height and noise (for crater effects)
      float ground_variation = clamp(pow(fbm(v_Position.xz * 0.03, 2) + 0.3, 5.0), 0.0, 1.0);
      
      // Mix low and high ground colors based on height
      vec4 ground_color = mix(ground_color_low, ground_color_high,
        clamp(remap(v_Position.y, -0.0, 2.0, 0.0, 1.0), 0.0, 1.0)
      );
      
      // Add variation for crater effects
      ground_color = mix(ground_color, variation_color, ground_variation);
      
      // Mix regolith with rock based on surface normal (rock appears on steep surfaces)
      vec4 texture_rock_default = mix(rock_color, vec4(0.22, 0.24, 0.3, 1.0), pow(fbm(v_Position.xz * 3.0, 3), 0.5) * 0.4);
      
      // Final terrain texture: mix regolith/ground with rock based on map_rock
      vec4 terrain_texture = mix(ground_color, texture_rock_default, map_rock);
      
      return terrain_texture;
    }
    `);
  }
}
