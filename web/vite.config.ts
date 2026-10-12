import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev: the UI runs on Vite (5173) and proxies /api (HTTP + WebSocket) to `whales serve` on 7777.
// Start the server with WHALES_DEV_ORIGIN=http://localhost:5173 so it accepts the dev origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:7777', ws: true, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
