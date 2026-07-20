/**
 * Benchmark Page Entry Point
 *
 * Wires up the UI controls with the BenchmarkRunner to execute
 * terrain, rock, and chunk generation benchmarks.
 */

import {
  runTerrainBenchmark,
  runRockBenchmark,
  runChunkBenchmark,
  runAllBenchmarks,
  type BenchmarkResult,
} from './BenchmarkRunner';
import { sanitizeIterations } from './stats';

// ============================================================================
// DOM Elements
// ============================================================================

interface BenchmarkElements {
  // Terrain controls
  terrainResolutions: HTMLDivElement;
  terrainIterations: HTMLInputElement;
  runTerrain: HTMLButtonElement;

  // Rock controls
  rockDetails: HTMLDivElement;
  rockLibrarySize: HTMLInputElement;
  rockIterations: HTMLInputElement;
  runRocks: HTMLButtonElement;

  // Chunk controls
  chunkLods: HTMLDivElement;
  chunkIterations: HTMLInputElement;
  runChunks: HTMLButtonElement;

  // Actions
  runAll: HTMLButtonElement;
  clearResults: HTMLButtonElement;
  exportResults: HTMLButtonElement;
  sortByTime: HTMLButtonElement;
  sortByCategory: HTMLButtonElement;

  // Status
  status: HTMLDivElement;
  progressContainer: HTMLDivElement;
  progressFill: HTMLDivElement;

  // Results
  resultsBody: HTMLTableSectionElement;
}

/**
 * Look up all required elements, collecting every missing id instead of
 * blowing up on the first unchecked cast. Returns null (after surfacing a
 * visible error) if the page markup is out of sync with this script.
 */
function initElements(): BenchmarkElements | null {
  const missing: string[] = [];
  const get = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) {
      missing.push(id);
    }
    // Only dereferenced if `missing` stays empty (checked below)
    return el as T;
  };

  const elements: BenchmarkElements = {
    terrainResolutions: get<HTMLDivElement>('terrain-resolutions'),
    terrainIterations: get<HTMLInputElement>('terrain-iterations'),
    runTerrain: get<HTMLButtonElement>('run-terrain'),

    rockDetails: get<HTMLDivElement>('rock-details'),
    rockLibrarySize: get<HTMLInputElement>('rock-library-size'),
    rockIterations: get<HTMLInputElement>('rock-iterations'),
    runRocks: get<HTMLButtonElement>('run-rocks'),

    chunkLods: get<HTMLDivElement>('chunk-lods'),
    chunkIterations: get<HTMLInputElement>('chunk-iterations'),
    runChunks: get<HTMLButtonElement>('run-chunks'),

    runAll: get<HTMLButtonElement>('run-all'),
    clearResults: get<HTMLButtonElement>('clear-results'),
    exportResults: get<HTMLButtonElement>('export-results'),
    sortByTime: get<HTMLButtonElement>('sort-by-time'),
    sortByCategory: get<HTMLButtonElement>('sort-by-category'),

    status: get<HTMLDivElement>('status'),
    progressContainer: get<HTMLDivElement>('progress-container'),
    progressFill: get<HTMLDivElement>('progress-fill'),

    resultsBody: get<HTMLTableSectionElement>('results-body'),
  };

  if (missing.length > 0) {
    const message = `Benchmark page failed to initialize: missing element id(s): ${missing.join(', ')}`;
    console.error(message);
    const banner = document.createElement('div');
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;padding:12px 16px;' +
      'background:#7f1d1d;color:#fff;font:13px/1.5 monospace;';
    banner.textContent = message;
    document.body.appendChild(banner);
    return null;
  }

  return elements;
}

// ============================================================================
// Pure Helpers
// ============================================================================

function getSelectedValues(container: HTMLDivElement): number[] {
  const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => parseInt((cb as HTMLInputElement).value, 10));
}

function readIterations(input: HTMLInputElement): number {
  return sanitizeIterations(parseInt(input.value, 10));
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function formatTime(ms: number): string {
  if (ms < 1) return ms.toFixed(3);
  if (ms < 10) return ms.toFixed(2);
  if (ms < 100) return ms.toFixed(1);
  return Math.round(ms).toString();
}

function getTimeClass(ms: number, category: string): string {
  // Different thresholds for different categories
  if (category === 'terrain') {
    if (ms < 10) return 'fast';
    if (ms < 50) return 'medium';
    return 'slow';
  }
  if (category === 'rock') {
    if (ms < 50) return 'fast';
    if (ms < 200) return 'medium';
    return 'slow';
  }
  // chunk
  if (ms < 20) return 'fast';
  if (ms < 100) return 'medium';
  return 'slow';
}

function getCategoryLabel(category: string): string {
  switch (category) {
    case 'terrain': return 'Terrain';
    case 'rock': return 'Rock';
    case 'chunk': return 'Chunk';
    default: return category;
  }
}

// ============================================================================
// Page Wiring
// ============================================================================

function initBenchmarkPage(elements: BenchmarkElements): void {
  // --- State ---
  let results: BenchmarkResult[] = [];
  let isRunning = false;
  let sortBy: 'time' | 'category' = 'category';

  // --- UI helpers ---

  function setStatus(text: string, state: 'ready' | 'running' | 'complete') {
    const statusEl = elements.status;
    statusEl.className = `status-indicator ${state}`;
    const textEl = statusEl.querySelector('.text');
    if (textEl) textEl.textContent = text;
  }

  function setProgress(current: number, total: number) {
    const percent = total > 0 ? (current / total) * 100 : 0;
    elements.progressFill.style.width = `${percent}%`;
  }

  function showProgress(show: boolean) {
    elements.progressContainer.style.display = show ? 'block' : 'none';
  }

  function setButtonsDisabled(disabled: boolean) {
    elements.runTerrain.disabled = disabled;
    elements.runRocks.disabled = disabled;
    elements.runChunks.disabled = disabled;
    elements.runAll.disabled = disabled;
  }

  // --- Render ---

  function renderResults() {
    if (results.length === 0) {
      elements.resultsBody.innerHTML = `
        <tr>
          <td colspan="8">
            <div class="empty-state">
              <div class="empty-state-icon">⏱</div>
              <div>Run a benchmark to see results</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    // Sort results
    const sorted = [...results];
    if (sortBy === 'time') {
      sorted.sort((a, b) => a.mean - b.mean);
    } else {
      // Sort by category, then by config
      sorted.sort((a, b) => {
        if (a.category !== b.category) {
          const order = { terrain: 0, rock: 1, chunk: 2 };
          return (order[a.category] ?? 99) - (order[b.category] ?? 99);
        }
        return a.config.localeCompare(b.config, undefined, { numeric: true });
      });
    }

    elements.resultsBody.innerHTML = sorted.map(r => `
      <tr>
        <td class="category">${getCategoryLabel(r.category)}</td>
        <td>${r.config}</td>
        <td class="number ${getTimeClass(r.mean, r.category)}">${formatTime(r.mean)}</td>
        <td class="number">${formatTime(r.min)}</td>
        <td class="number">${formatTime(r.max)}</td>
        <td class="number">${r.vertices > 0 ? formatNumber(r.vertices) : '—'}</td>
        <td class="number">${r.triangles > 0 ? formatNumber(r.triangles) : '—'}</td>
        <td>${r.throughput}</td>
      </tr>
    `).join('');
  }

  // --- Benchmark runners ---

  async function runTerrainBenchmarkUI() {
    if (isRunning) return;

    const resolutions = getSelectedValues(elements.terrainResolutions);
    const iterations = readIterations(elements.terrainIterations);

    if (resolutions.length === 0) {
      alert('Please select at least one resolution');
      return;
    }

    isRunning = true;
    setButtonsDisabled(true);
    setStatus('Running terrain benchmark...', 'running');
    showProgress(true);
    setProgress(0, 1);

    try {
      const newResults = await runTerrainBenchmark(resolutions, iterations, (current, total, message) => {
        setProgress(current, total);
        setStatus(message, 'running');
      });

      // Remove old terrain results and add new ones
      results = results.filter(r => r.category !== 'terrain');
      results.push(...newResults);
      renderResults();

      setStatus(`Completed ${newResults.length} terrain benchmarks`, 'complete');
    } catch (error) {
      console.error('Terrain benchmark failed:', error);
      setStatus('Benchmark failed!', 'ready');
    } finally {
      isRunning = false;
      setButtonsDisabled(false);
      showProgress(false);
    }
  }

  async function runRockBenchmarkUI() {
    if (isRunning) return;

    const details = getSelectedValues(elements.rockDetails);
    const librarySize = parseInt(elements.rockLibrarySize.value, 10) || 30;
    const iterations = readIterations(elements.rockIterations);

    if (details.length === 0) {
      alert('Please select at least one detail level');
      return;
    }

    isRunning = true;
    setButtonsDisabled(true);
    setStatus('Running rock benchmark...', 'running');
    showProgress(true);
    setProgress(0, 1);

    try {
      const newResults = await runRockBenchmark(details, librarySize, iterations, (current, total, message) => {
        setProgress(current, total);
        setStatus(message, 'running');
      });

      // Remove old rock results and add new ones
      results = results.filter(r => r.category !== 'rock');
      results.push(...newResults);
      renderResults();

      setStatus(`Completed ${newResults.length} rock benchmarks`, 'complete');
    } catch (error) {
      console.error('Rock benchmark failed:', error);
      setStatus('Benchmark failed!', 'ready');
    } finally {
      isRunning = false;
      setButtonsDisabled(false);
      showProgress(false);
    }
  }

  async function runChunkBenchmarkUI() {
    if (isRunning) return;

    const lods = getSelectedValues(elements.chunkLods);
    const iterations = readIterations(elements.chunkIterations);

    if (lods.length === 0) {
      alert('Please select at least one LOD level');
      return;
    }

    isRunning = true;
    setButtonsDisabled(true);
    setStatus('Running chunk benchmark...', 'running');
    showProgress(true);
    setProgress(0, 1);

    try {
      const newResults = await runChunkBenchmark(lods, iterations, (current, total, message) => {
        setProgress(current, total);
        setStatus(message, 'running');
      });

      // Remove old chunk results and add new ones
      results = results.filter(r => r.category !== 'chunk');
      results.push(...newResults);
      renderResults();

      setStatus(`Completed ${newResults.length} chunk benchmarks`, 'complete');
    } catch (error) {
      console.error('Chunk benchmark failed:', error);
      setStatus('Benchmark failed!', 'ready');
    } finally {
      isRunning = false;
      setButtonsDisabled(false);
      showProgress(false);
    }
  }

  async function runAllBenchmarksUI() {
    if (isRunning) return;

    const terrainResolutions = getSelectedValues(elements.terrainResolutions);
    const terrainIterations = readIterations(elements.terrainIterations);
    const rockDetails = getSelectedValues(elements.rockDetails);
    const rockLibrarySize = parseInt(elements.rockLibrarySize.value, 10) || 30;
    const rockIterations = readIterations(elements.rockIterations);
    const chunkLods = getSelectedValues(elements.chunkLods);
    const chunkIterations = readIterations(elements.chunkIterations);

    if (terrainResolutions.length === 0 && rockDetails.length === 0 && chunkLods.length === 0) {
      alert('Please select at least one benchmark to run');
      return;
    }

    isRunning = true;
    setButtonsDisabled(true);
    setStatus('Running all benchmarks...', 'running');
    showProgress(true);
    setProgress(0, 1);

    try {
      const newResults = await runAllBenchmarks(
        terrainResolutions,
        terrainIterations,
        rockDetails,
        rockLibrarySize,
        rockIterations,
        chunkLods,
        chunkIterations,
        (current, total, message) => {
          setProgress(current, total);
          setStatus(message, 'running');
        }
      );

      results = newResults;
      renderResults();

      setStatus(`Completed ${newResults.length} benchmarks`, 'complete');
    } catch (error) {
      console.error('Benchmarks failed:', error);
      setStatus('Benchmark failed!', 'ready');
    } finally {
      isRunning = false;
      setButtonsDisabled(false);
      showProgress(false);
    }
  }

  function clearResultsUI() {
    results = [];
    renderResults();
    setStatus('Ready', 'ready');
  }

  function exportResultsUI() {
    if (results.length === 0) {
      alert('No results to export');
      return;
    }

    const data = {
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
      results: results.map(r => ({
        ...r,
        // Include all timing data
      })),
    };

    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `benchmark-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // --- Event listeners ---

  // Checkbox toggle styling
  document.querySelectorAll('.checkbox-item').forEach(item => {
    const checkbox = item.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (checkbox) {
      checkbox.addEventListener('change', () => {
        item.classList.toggle('selected', checkbox.checked);
      });
    }
  });

  // Run buttons
  elements.runTerrain.addEventListener('click', runTerrainBenchmarkUI);
  elements.runRocks.addEventListener('click', runRockBenchmarkUI);
  elements.runChunks.addEventListener('click', runChunkBenchmarkUI);
  elements.runAll.addEventListener('click', runAllBenchmarksUI);

  // Action buttons
  elements.clearResults.addEventListener('click', clearResultsUI);
  elements.exportResults.addEventListener('click', exportResultsUI);

  // Sort buttons
  elements.sortByTime.addEventListener('click', () => {
    sortBy = 'time';
    renderResults();
  });

  elements.sortByCategory.addEventListener('click', () => {
    sortBy = 'category';
    renderResults();
  });
}

// ============================================================================
// Initialize
// ============================================================================

const elements = initElements();
if (elements) {
  initBenchmarkPage(elements);
  console.log('Lunar Explorer Benchmark Tool initialized');
  console.log('Select benchmarks and click "Run" to measure performance');
}
