/**
 * Per-mission best score/stars persistence (ADR-0004 §3),
 * namespaced in localStorage under `lander.highscores.v1`.
 */
import { LANDER_CONFIG } from './config';

export interface MissionBest {
  score: number;
  stars: 0 | 1 | 2 | 3;
}

interface HighscoreData {
  missions: Record<string, MissionBest>;
}

function load(): HighscoreData {
  try {
    const raw = localStorage.getItem(LANDER_CONFIG.storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as HighscoreData;
      if (parsed && typeof parsed.missions === 'object' && parsed.missions !== null) {
        return parsed;
      }
    }
  } catch {
    // Corrupt or unavailable storage — start fresh
  }
  return { missions: {} };
}

export function getMissionBest(missionIndex: number): MissionBest | null {
  return load().missions[String(missionIndex)] ?? null;
}

/**
 * Record a result; returns true when it is a new best score.
 * Storage failures (private browsing quotas etc.) are swallowed —
 * high scores are a nicety, never an error path.
 */
export function recordMissionResult(
  missionIndex: number,
  score: number,
  stars: 0 | 1 | 2 | 3
): boolean {
  const data = load();
  const key = String(missionIndex);
  const previous = data.missions[key];
  const isNewBest = !previous || score > previous.score;
  data.missions[key] = {
    score: isNewBest ? score : previous.score,
    stars: previous ? (Math.max(previous.stars, stars) as MissionBest['stars']) : stars,
  };
  try {
    localStorage.setItem(LANDER_CONFIG.storageKey, JSON.stringify(data));
  } catch {
    // ignore
  }
  return isNewBest;
}

/** Highest mission index with a recorded result, or -1. */
export function highestCompletedMission(): number {
  const data = load();
  let highest = -1;
  for (const key of Object.keys(data.missions)) {
    const index = Number(key);
    if (Number.isFinite(index) && index > highest) {
      highest = index;
    }
  }
  return highest;
}
