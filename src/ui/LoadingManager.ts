/**
 * LoadingManager tracks texture loading progress and chunk readiness,
 * displaying a loading overlay with progress bar until everything is ready.
 *
 * Resilient to failures: texture load errors still advance the counter
 * (degraded completion), and a watchdog timer force-completes loading if
 * it stalls for too long, so the overlay can never freeze forever.
 */
export class LoadingManager {
  private texturesLoaded: number = 0;
  private totalTextures: number = 0;
  private chunkReady: boolean = false;
  private overlayElement: HTMLElement | null = null;
  private progressBarElement: HTMLElement | null = null;
  private textElement: HTMLElement | null = null;
  private isComplete: boolean = false;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param watchdogMs Milliseconds before loading is force-completed if
   *                   still incomplete. Pass 0 to disable the watchdog.
   */
  constructor(watchdogMs: number = 20000) {
    if (typeof document !== 'undefined') {
      this.overlayElement = document.getElementById('loading-overlay');
      this.progressBarElement = document.getElementById('loading-bar');
      this.textElement = document.querySelector('.loading-text');

      if (!this.overlayElement || !this.progressBarElement) {
        console.warn('Loading overlay elements not found in DOM');
      }
    }

    if (watchdogMs > 0) {
      this.watchdogTimer = setTimeout(() => {
        if (this.isComplete) return;
        console.warn(
          `Loading stalled (${this.texturesLoaded}/${this.totalTextures} textures, chunk ready: ${this.chunkReady}) — force-completing`
        );
        this.setText('Loading took too long — continuing anyway');
        this.complete();
      }, watchdogMs);
    }
  }

  /**
   * Register the number of textures that will be tracked.
   * Can be called multiple times; counts accumulate.
   */
  registerTextures(count: number): void {
    this.totalTextures += count;
  }

  /**
   * Report that a texture has loaded
   */
  onTextureLoaded(): void {
    if (this.isComplete) return;

    this.texturesLoaded++;
    this.updateProgress();
  }

  /**
   * Report that a texture failed to load.
   * Still advances the counter so loading can complete in a degraded state.
   */
  onTextureError(description?: string): void {
    if (this.isComplete) return;

    console.warn(`Failed to load texture${description ? `: ${description}` : ''}`);
    this.setText('Some textures failed to load');

    this.texturesLoaded++;
    this.updateProgress();
  }

  /**
   * Report that the chunk is ready (terrain available at camera position)
   */
  onChunkReady(): void {
    if (this.isComplete) return;

    this.chunkReady = true;
    this.updateProgress();
  }

  /**
   * Update progress bar based on current loading state
   */
  private updateProgress(): void {
    if (this.isComplete) return;

    // Textures account for 80% of progress, chunk readiness for 20%
    const textureProgress =
      this.totalTextures > 0 ? (this.texturesLoaded / this.totalTextures) * 0.8 : 0.8;
    const chunkProgress = this.chunkReady ? 0.2 : 0;
    const totalProgress = textureProgress + chunkProgress;

    if (this.progressBarElement) {
      this.progressBarElement.style.width = `${totalProgress * 100}%`;
    }

    // Check if everything is complete
    if (this.texturesLoaded >= this.totalTextures && this.chunkReady) {
      this.complete();
    }
  }

  /**
   * Update the loading overlay text
   */
  private setText(text: string): void {
    if (this.textElement) {
      this.textElement.textContent = text;
    }
  }

  /**
   * Hide the loading overlay with fade-out animation
   */
  private complete(): void {
    if (this.isComplete) return;

    this.isComplete = true;

    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }

    // Ensure progress bar is at 100%
    if (this.progressBarElement) {
      this.progressBarElement.style.width = '100%';
    }

    // Wait a brief moment to show 100%, then fade out
    setTimeout(() => {
      if (this.overlayElement) {
        this.overlayElement.classList.add('hidden');

        // Remove from DOM after animation completes
        setTimeout(() => {
          if (this.overlayElement) {
            this.overlayElement.remove();
          }
        }, 500);
      }
    }, 300);
  }

  /**
   * Check if loading is complete
   */
  isLoadingComplete(): boolean {
    return this.isComplete;
  }
}
