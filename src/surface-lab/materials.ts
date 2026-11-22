import { MirroredRepeatWrapping, TextureLoader, Uniform, Vector3 } from 'three';
import { MoonMaterial } from '../shaders/MoonMaterial';
import grainUrl from './grain.png?url';
import { proceduralRegolith } from './proceduralRegolith';

export async function createLabMaterials(maxAnisotropy: number) {
  const reference = new MoonMaterial({ broadRelief: 'atlas' });
  const flight = new MoonMaterial();
  const procedural = new MoonMaterial();
  const loader = new TextureLoader();
  const grain = await loader.loadAsync(grainUrl);
  grain.wrapS = grain.wrapT = MirroredRepeatWrapping;
  grain.anisotropy = Math.min(maxAnisotropy, 8);
  const hybrid = new Uniform(true);
  const channel = new Uniform(0);
  const relief = new Uniform(1);
  const sunDirection = new Uniform(new Vector3());

  procedural.setParams({ enableColorVariation: false, enableDetail: false });

  for (const material of [reference, flight, procedural]) {
    material.setParam('enableCurvature', false);
    const isProcedural = material === procedural;
    const compileGame = material.onBeforeCompile.bind(material);
    const gameKey = material.customProgramCacheKey();
    material.customProgramCacheKey = () => `${gameKey}/lab/${isProcedural ? 'field' : 'game'}`;
    material.onBeforeCompile = (shader, renderer) => {
      compileGame(shader, renderer);
      shader.uniforms.uSunDirection = sunDirection;
      shader.uniforms.uLabChannel = channel;
      shader.fragmentShader = `uniform int uLabChannel;\n${shader.fragmentShader}`;
      if (isProcedural) {
        shader.uniforms.uLabRelief = relief;
        shader.uniforms.uLabHybrid = hybrid;
        shader.uniforms.uLabGrainMap = new Uniform(grain);
        shader.fragmentShader = `uniform float uLabRelief;\nuniform bool uLabHybrid;\nuniform sampler2D uLabGrainMap;\n${proceduralRegolith}\n${shader.fragmentShader}`;
        // Replace the inputs to the existing lighting pipeline. Camera, sun,
        // exposure and reflectance model are shared by both sides of the lab.
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <roughnessmap_fragment>',
            `#include <roughnessmap_fragment>
          vec2 ground = vWorldPosition.xz;
          vec3 field = sampleProceduralRegolith(ground, dFdx(ground), dFdy(ground));
          diffuseColor.rgb = vec3(0.122, 0.110, 0.094) * (1.0 + field.z) * uBrightnessBoost;`
          )
          .replace(
            '#include <normal_fragment_maps>',
            `#include <normal_fragment_maps>
          vec3 surfaceNormal = normalize(vWorldNormal - vec3(field.x, 0.0, field.y) * uLabRelief);
          normal = normalize(mat3(viewMatrix) * surfaceNormal);
          nonPerturbedNormal = normal;`
          );
      }
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        `if (uLabChannel == 1) outgoingLight = diffuseColor.rgb;
         if (uLabChannel == 2) outgoingLight = inverseTransformDirection(normal, viewMatrix) * 0.5 + 0.5;
         #include <opaque_fragment>`
      );
    };
  }
  return { reference, flight, procedural, channel, relief, sunDirection, hybrid };
}
