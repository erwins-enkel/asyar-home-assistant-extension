import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath, URL } from 'url';
import { resolve } from 'path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  // Relative base: the bundle is served from asyar-extension://<id>/ (or
  // http://asyar-extension.localhost/<id>/ on Windows), not from a host root.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        worker: resolve(__dirname, 'worker.html'),
        view: resolve(__dirname, 'view.html'),
      },
      output: {
        // The manifest points `background.main` at dist/worker.js, so these
        // two entries must keep their exact names.
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
