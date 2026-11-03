import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/app'),
      '@zero-os/shared': resolve(__dirname, '../../packages/shared/src/browser.ts'),
      '@zero-os/observe': resolve(__dirname, '../../packages/observe/src/browser.ts'),
    },
  },
  server: {
    port: 3000,
    fs: {
      // Vite replaces its default deny list when configured. Retain it alongside ZeRo data.
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem}',
        '**/.git/**',
        '**/.zero/**',
        '**/listeners/inbox.sqlite*',
      ],
    },
    proxy: {
      // Keep the browser Host and client address for the listener API’s local-only boundary.
      '/api/listeners': { target: 'http://localhost:3001', changeOrigin: false, xfwd: true },
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
})
