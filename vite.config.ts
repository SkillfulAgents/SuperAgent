import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './src/shared'),
      '@renderer': path.resolve(__dirname, './src/renderer'),
    },
  },
  root: './src/renderer',
  build: { outDir: '../../dist/renderer' },
  server: {
    port: 3000,
    proxy: { '/api': 'http://localhost:47891' },
  },
})
