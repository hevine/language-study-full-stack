import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: false,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4399',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: false,
    sourcemap: false,
  },
});
