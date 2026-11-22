/**
 * Rock prototype build benchmark (NOT part of the normal test run).
 *
 *   npx vitest bench --run src/environment/rockBuild.bench.ts
 *
 * Times RockBuilder.generate() at every detail of ROCK_DETAIL_LADDER. The
 * chunk-tier details are built on the main thread during idle time, so they
 * must stay well under a frame; the finer near-camera details are built in
 * a worker (rockPrototypeWorker.ts).
 */
import { bench, describe } from 'vitest';
import { RockBuilder } from './RockBuilder';
import { ROCK_DETAIL_LADDER, ROCK_TIERS } from './rockPrototypes';

const CHUNK_TIER_DETAILS = new Set(ROCK_TIERS.map((tier) => tier.detail));

describe('RockBuilder.generate', () => {
  for (const detail of ROCK_DETAIL_LADDER) {
    let seed = 0;
    const where = CHUNK_TIER_DETAILS.has(detail) ? 'main thread' : 'worker';
    bench(`detail ${detail} (${where})`, () => {
      RockBuilder.generate(seed++ % 30, { detail });
    });
  }
});
