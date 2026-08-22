import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
    pool: 'threads',
  },
  plugins: [
    react(),
    !process.env.VITEST && tailwindcss(),
  ].filter(Boolean),

  // Tauri expects a fixed, predictable dev server port.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      // Don't reload the frontend when Rust files change under src-tauri.
      ignored: ['**/src-tauri/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    // Tauri uses Chromium on Linux (via webkit2gtk) -- target modern ES,
    // don't minify in debug builds so Rust panics/JS errors map cleanly.
    target: process.env.TAURI_ENV_DEBUG ? 'esnext' : 'es2021',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    cssMinify: 'esbuild',
    assetsDir: 'assets',
    chunkSizeWarningLimit: 1000,
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) return 'vendor-react';
          if (id.includes('node_modules/motion')) return 'vendor-motion';
          if (id.includes('node_modules/lucide-react')) return 'vendor-ui';
          if (id.includes('node_modules/recharts')) return 'vendor-charts';
          if (id.includes('node_modules/leaflet')) return 'vendor-maps';
          if (id.includes('node_modules/mermaid')) return 'vendor-mermaid';
          if (id.includes('node_modules/three')) return 'vendor-three';
          if (id.includes('node_modules/pdfjs-dist')) return 'vendor-pdf';
          if (id.includes('node_modules/pdf-lib')) return 'vendor-pdf-lib';
          if (id.includes('node_modules/katex')) return 'vendor-katex';
          if (id.includes('node_modules/zod')) return 'vendor-zod';
          if (id.includes('node_modules/zustand')) return 'vendor-state';
          if (id.includes('node_modules/qrcode')) return 'vendor-qrcode';
        },
      },
    },
  },
})
