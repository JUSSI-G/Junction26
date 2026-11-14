import { defineConfig } from 'vite';

// `npm run dev` proxies /api to the FastAPI server; `npm run build` writes web/dist, which
// api.py serves itself.
export default defineConfig({
  base: '/globe/',            // hidden from the navigation; / is the editor app
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
  build: { chunkSizeWarningLimit: 2500 },
});
