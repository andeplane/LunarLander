import { defineConfig } from 'vite'

export default defineConfig({
  // TypeScript is handled automatically by Vite
  // Asset handling is configured by default
  server: {
    port: 3000,
    open: true
  }
})
