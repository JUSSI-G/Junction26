import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `npm run dev` proxies /api to the FastAPI server (make api).
// `npm run dev:mock` (mode "mock") serves web/mocks/*.json instead — no backend needed.
export default defineConfig({
  // Served by the API under /contested/ while the two frontends are merged (/ is the place globe).
  base: '/contested/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.API_URL || 'http://127.0.0.1:8000' },
  },
})
