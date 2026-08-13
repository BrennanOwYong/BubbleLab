import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import path from 'path';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), TanStackRouterVite()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['monaco-editor'],
    esbuildOptions: {
      target: 'esnext',
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      // Server-side only: never read from VITE_-prefixed vars here, or the
      // proxy target and the browser-facing API_BASE_URL (env.ts) collapse
      // onto the same var and can't diverge (e.g. browser -> relative "/api",
      // proxy -> absolute local backend, needed to tunnel the frontend
      // without exposing the backend's own port publicly).
      '/api': {
        target:
          process.env.API_PROXY_TARGET ||
          process.env.VITE_API_URL ||
          process.env.VITE_API_ENDPOINT ||
          'http://localhost:3001',
        changeOrigin: true,
        // The real API's routes have no /api prefix (e.g. GET /bubble-flow,
        // not GET /api/bubble-flow) — strip it before forwarding.
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': {
        target:
          process.env.API_PROXY_TARGET ||
          process.env.VITE_API_URL ||
          process.env.VITE_API_ENDPOINT ||
          'http://localhost:3001',
        changeOrigin: true,
        // The real API's routes have no /api prefix (e.g. GET /bubble-flow,
        // not GET /api/bubble-flow) — strip it before forwarding.
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  define: {
    global: 'globalThis',
  },
  // Ensure environment variables are loaded properly
  envPrefix: 'VITE_',
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
        },
      },
    },
  },
});
