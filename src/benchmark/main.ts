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

// ============================================================================
// State
// ============================================================================

let results: BenchmarkResult[] = [];
let isRunning = false;
let sortBy: 'time' | 'category' = 'category';

// ============================================================================
// DOM Elements
// ============================================================================

const elements = {
  // Terrain controls
  terrainResolutions: document.getElementById('terrain-resolutions') as HTMLDivElement,
  terrainIterations: document.getElementById('terrain-iterations') as HTMLInputElement,
  runTerrain: document.getElementById('run-terrain') as HTMLButtonElement,
  
  // Rock controls
  rockDetails: document.getElementById('rock-details') as HTMLDivElement,
  rockLibrarySize: document.getElementById('rock-library-size') as HTMLInputElement,
  rockIterations: document.getElementById('rock-iterations') as HTMLInputElement,
  runRocks: document.getElementById('run-rocks') as HTMLButtonElement,
  
  // Chunk controls
  chunkLods: document.getElementById('chunk-lods') as HTMLDivElement,
  chunkIterations: document.getElementById('chunk-iterations') as HTMLInputElement,
  runChunks: document.getElementById('run-chunks') as HTMLButtonElement,
  
  // Actions
  runAll: document.getElementById('run-all') as HTMLButtonElement,
  clearResults: document.getElementById('clear-results') as HTMLButtonElement,
  exportResults: document.getElementById('export-results') as HTMLButtonElement,
  sortByTime: document.getElementById('sort-by-time') as HTMLButtonElement,
  sortByCategory: document.getElementById('sort-by-category') as HTMLButtonElement,
  
  // Status
  status: document.getElementById('status') as HTMLDivElement,
  progressContainer: document.getElementById('progress-container') as HTMLDivElement,
  progressFill: document.getElementById('progress-fill') as HTMLDivElement,
  
  // Results
  resultsBody: document.getElementById('results-body') as HTMLTableSectionElement,
};

// ============================================================================
// Helpers
// ============================================================================

function getSelectedValues(container: HTMLDivElement): number[] {
  const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => parseInt((cb as HTMLInputElement).value, 10));
}

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
// Render
// ============================================================================

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

// ============================================================================
// Benchmark Runners
// ============================================================================

async function runTerrainBenchmarkUI() {
  if (isRunning) return;
  
  const resolutions = getSelectedValues(elements.terrainResolutions);
  const iterations = parseInt(elements.terrainIterations.value, 10) || 3;
  
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
  const iterations = parseInt(elements.rockIterations.value, 10) || 3;
  
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
  const iterations = parseInt(elements.chunkIterations.value, 10) || 3;
  
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
  const rockDetails = getSelectedValues(elements.rockDetails);
  const rockLibrarySize = parseInt(elements.rockLibrarySize.value, 10) || 30;
  const chunkLods = getSelectedValues(elements.chunkLods);
  const iterations = parseInt(elements.terrainIterations.value, 10) || 3;
  
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
      rockDetails,
      rockLibrarySize,
      chunkLods,
      iterations,
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

// ============================================================================
// Event Listeners
// ============================================================================

// Checkbox toggle styling
document.querySelectorAll('.checkbox-item').forEach(item => {
  const checkbox = item.querySelector('input[type="checkbox"]') as HTMLInputElement;
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

// ============================================================================
// Initialize
// ============================================================================

console.log('Lunar Explorer Benchmark Tool initialized');
console.log('Select benchmarks and click "Run" to measure performance');
