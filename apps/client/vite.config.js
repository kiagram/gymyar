import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/* The dev server proxies /api to the API, so it has to agree with the API about the port —
 * and the API's port lives in the repo's .env, which nothing loads for a `vite` started by
 * npm. Reading it here means one file configures the whole dev stack instead of two that
 * drift. Absent or unreadable is the normal case in CI and in a production build. */
try { process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))) } catch { /* no .env */ }

const backend = process.env.API_TARGET ||
  'http://127.0.0.1:' + (process.env.PORT || 3000)
const media = process.env.MEDIA_TARGET || 'http://127.0.0.1:8888'

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      /* Uploaded media. There is no nginx in the dev stack, so the API serves the bytes
       * itself — which is what STORAGE_ACCEL being off means, and why this proxies to the
       * backend rather than to the exercise-media server two lines down. */
      '/media': { target: backend, changeOrigin: true },
      '/img': { target: media, changeOrigin: true },
      '/gif': { target: media, changeOrigin: true }
    }
  },
  build: { chunkSizeWarningLimit: 1500 }
})
