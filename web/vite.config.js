import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// NetMon web client.
// - Dev server on :5173 proxies /api (REST + SSE) to the Node backend.
// - Use 127.0.0.1 rather than "localhost": Node may resolve localhost to ::1
//   while the backend binds 127.0.0.1 by default.
const API_TARGET = process.env.NETMON_API || 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        // Keep the SSE stream unbuffered through the proxy.
        configure(proxy) {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache';
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: API_TARGET, changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 800,
  },
});
