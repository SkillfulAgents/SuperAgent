import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/renderer/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/main/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './src/shared'),
      '@renderer': path.resolve(__dirname, './src/renderer'),
    },
  },
})
