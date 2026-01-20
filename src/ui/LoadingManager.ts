/**
 * LoadingManager tracks texture loading progress and chunk readiness,
 * displaying a loading overlay with progress bar until everything is ready.
 */
export class LoadingManager {
  private texturesLoaded: number = 0;
  private totalTextures: number = 6; // surface + skybox + 4 earth textures
  private chunkReady: boolean = false;
  private overlayElement: HTMLElement | null = null;
  private progressBarElement: HTMLElement | null = null;
  private isComplete: boolean = false;

  constructor() {
    this.overlayElement = document.getElementById('loading-overlay');
    this.progressBarElement = document.getElementById('loading-bar');
    
    if (!this.overlayElement || !this.progressBarElement) {
      console.warn('Loading overlay elements not found in DOM');
    }
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
   * Report that the chunk is ready (terrain available at camera position)
   */
  onChunkReady(): void {
    if (this.isComplete) return;
    
    this.chunkReady = true;
    this.updateProgress();
  }

  /**
   * Check if chunk is ready by querying height at camera position
   * Returns true if chunk has terrain available
   */
  checkChunkReady(getHeightAt: (x: number, z: number) => number | null, cameraX: number, cameraZ: number): boolean {
    const height = getHeightAt(cameraX, cameraZ);
    return height !== null;
  }

  /**
   * Update progress bar based on current loading state
   */
  private updateProgress(): void {
    if (this.isComplete) return;

    // Textures account for 80% of progress, chunk readiness for 20%
    const textureProgress = (this.texturesLoaded / this.totalTextures) * 0.8;
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
   * Hide the loading overlay with fade-out animation
   */
  private complete(): void {
    if (this.isComplete) return;
    
    this.isComplete = true;
    
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
   * Get current progress (0-1)
   */
  getProgress(): number {
    const textureProgress = (this.texturesLoaded / this.totalTextures) * 0.8;
    const chunkProgress = this.chunkReady ? 0.2 : 0;
    return textureProgress + chunkProgress;
  }

  /**
   * Check if loading is complete
   */
  isLoadingComplete(): boolean {
    return this.isComplete;
  }
}
