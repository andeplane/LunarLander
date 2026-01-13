import { generateTerrain } from './terrain';

export interface TerrainWorkerMessage {
  terrainArgs: Parameters<typeof generateTerrain>[0];
  gridKey: string;
  lodLevel: number;
}

export interface TerrainWorkerResult {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  biome?: ArrayLike<number>;
  index?: ArrayLike<number>;
  gridKey: string;
  lodLevel: number;
  resolution: number;
}

self.onmessage = (m: MessageEvent<TerrainWorkerMessage>) => {
    const { terrainArgs, gridKey, lodLevel } = m.data;
    const geometry = generateTerrain(terrainArgs);

    // Extract attributes into transferable objects
    const index = geometry.index?.array; // keep full TypedArray, not just buffer

    const result: TerrainWorkerResult = {
        positions: geometry.attributes.position.array,
        normals: geometry.attributes.normal.array,
        uvs: geometry.attributes.uv?.array,
        biome: geometry.attributes.biome?.array,
        index,
        gridKey,
        lodLevel,
        resolution: terrainArgs.resolution,
    };

    postMessage(result);
};
