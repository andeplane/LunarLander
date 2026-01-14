import { defineConfig } from 'vite'

/**
 * Determine the base path for GitHub Pages deployment
 * - If VITE_BASE_PATH is set, use it
 * - If GITHUB_REPOSITORY is set (GitHub Actions), extract repo name and use /repo-name/
 * - Otherwise, default to / for local development
 */
function getBasePath(): string {
  // Check for explicit base path environment variable
  if (process.env.VITE_BASE_PATH) {
    return process.env.VITE_BASE_PATH
  }
  
  // In GitHub Actions, extract repo name from GITHUB_REPOSITORY
  // Format: owner/repo-name
  if (process.env.GITHUB_REPOSITORY) {
    const repoName = process.env.GITHUB_REPOSITORY.split('/')[1]
    return `/${repoName}/`
  }
  
  // Default to root for local development
  return '/'
}

export default defineConfig({
  base: getBasePath(),
  // TypeScript is handled automatically by Vite
  // Asset handling is configured by default
  server: {
    port: 3000,
    open: true
  }
})
