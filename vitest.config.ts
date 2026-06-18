import { defineConfig } from 'vitest/config'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __AUTH_MODE__: JSON.stringify(process.env.AUTH_MODE === 'true'),
    __RENDER_TRACKING__: JSON.stringify(process.env.RENDER_TRACKING === 'true'),
    // The jsdom/node test env has no electronAPI → isElectron() === false, so the
    // web build define is the consistent value (keeps history.ts's tripwire happy
    // when a unit-tested component pulls in the router singleton via AppLink).
    __WEB__: JSON.stringify(true),
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['src/renderer/test/setup.ts'],
    testTimeout: 15_000,
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
