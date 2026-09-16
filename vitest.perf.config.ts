/**
 * Perf suite: API routes measured under simulated NFS latency (see perf/README.md).
 *
 * Deliberately separate from vitest.config.ts: these tests assert wall-clock
 * and must run alone, one file at a time, in a single process, so nothing else
 * on the machine competes for the event loop. `npm run test:perf`.
 */
import { defineConfig } from 'vitest/config'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __AUTH_MODE__: JSON.stringify(false),
    __RENDER_TRACKING__: JSON.stringify(false),
    __WEB__: JSON.stringify(true),
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['perf/**/*.perf.ts'],
    setupFiles: ['perf/setup.ts'],
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The suite exists to measure; keep every run's numbers in the log.
    silent: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './src/shared'),
      '@renderer': path.resolve(__dirname, './src/renderer'),
    },
  },
})
