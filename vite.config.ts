import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'node:fs'

// Single source of truth for the version the UI reports. Previously this came
// from `import.meta.env.VITE_APP_VERSION`, which nothing ever set, so the app
// hardcoded itself to 0.1.0 and the update banner told every user on every
// launch that they were permanently out of date.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string }

// https://tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  // Relative base so the web build works under a GitHub Pages subpath
  // (https://<owner>.github.io/gia-cowork/) as well as Tauri's file://.
  base: './',
  test: {
    globals: true,
    environment: 'happy-dom',
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
    proxy: {
      // Browser dev server (no Tauri shell): the renderer's fetch to Gemini's
      // streaming endpoint dies on CORS (net::ERR_FAILED) and the public CORS
      // proxies are unreliable — a chat message just hangs. Proxing
      // server-side here has no CORS restriction. Tauri/desktop keeps the
      // absolute URL (see providers/gemini.ts resolveGeminiBase).
      '/gemini-proxy': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/gemini-proxy/, ''),
        secure: true,
      },
      // Pollinations (free, keyless): their Turnstile gate 403s any request
      // that carries an http(s) Origin header — which every browser fetch
      // does, so the web dev build can never call them directly. The desktop
      // app (tauri:// origin) passes, and server-side requests (no Origin)
      // pass. So in the dev server we proxy through and STRIP origin/referer:
      // the request leaves this machine with no browser identity and pollinations
      // treats it like any server-side caller.
      '/pollinations-proxy': {
        target: 'https://text.pollinations.ai',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/pollinations-proxy/, ''),
        secure: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
          });
        },
      },
    },
    watch: {
      // Don't reload the frontend when Rust files change under src-tauri.
      ignored: ['**/src-tauri/**'],
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
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
