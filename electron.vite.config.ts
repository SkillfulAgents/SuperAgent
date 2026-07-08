import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))
const analyticsConfig = JSON.parse(readFileSync(path.resolve(__dirname, 'src/shared/lib/analytics/config.json'), 'utf-8'))

export default defineConfig({
  main: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      'globalThis.__PLATFORM_BASE_URL__': JSON.stringify(process.env.PLATFORM_BASE_URL || ''),
      'globalThis.__PLATFORM_PROXY_URL__': JSON.stringify(process.env.PLATFORM_PROXY_URL || ''),
    },
    build: {
      outDir: 'dist/main',
      externalizeDeps: { exclude: ['better-auth'] },
      rollupOptions: { external: ['better-sqlite3', 'ws', 'electron-updater'] },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@shared': path.resolve(__dirname, './src/shared'),
      },
    },
  },
  preload: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      'globalThis.__PLATFORM_BASE_URL__': JSON.stringify(process.env.PLATFORM_BASE_URL || ''),
      'globalThis.__PLATFORM_PROXY_URL__': JSON.stringify(process.env.PLATFORM_PROXY_URL || ''),
    },
    build: {
      outDir: 'dist/preload',
    },
  },
  renderer: {
    plugins: [react()],
    // Relative base so packaged file:// + hash history resolve ./assets/* and the
    // pinned index.html. Explicit so a future electron-vite default change fails
    // loudly instead of silently shipping absolute asset URLs.
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __AUTH_MODE__: JSON.stringify(false),
      __E2E_MOCK__: JSON.stringify(process.env.E2E_MOCK === 'true'),
      __WEB__: JSON.stringify(false), // all Electron (dev http + prod file://) → hash history
      __AMPLITUDE_API_KEY__: JSON.stringify(process.env.AMPLITUDE_API_KEY || analyticsConfig.defaultAmplitudeKey),
      __RENDER_TRACKING__: JSON.stringify(process.env.RENDER_TRACKING === 'true'),
      'globalThis.__PLATFORM_BASE_URL__': JSON.stringify(process.env.PLATFORM_BASE_URL || ''),
      'globalThis.__PLATFORM_PROXY_URL__': JSON.stringify(process.env.PLATFORM_PROXY_URL || ''),
    },
    root: './src/renderer',
    build: {
      outDir: path.resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        // Two entry HTMLs: the main app and the standalone quick-dispatch
        // launcher window (a separate BrowserWindow / renderer process).
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
          quickDispatch: path.resolve(__dirname, 'src/renderer/quick-dispatch.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@shared': path.resolve(__dirname, './src/shared'),
        '@renderer': path.resolve(__dirname, './src/renderer'),
      },
    },
  },
})
