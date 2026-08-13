import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import devServer from '@hono/vite-dev-server'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))
const analyticsConfig = JSON.parse(readFileSync(path.resolve(__dirname, 'src/shared/lib/analytics/config.json'), 'utf-8'))
const viteCacheDir = process.env.VITE_CACHE_DIR ? path.resolve(__dirname, process.env.VITE_CACHE_DIR) : undefined

export default defineConfig({
  cacheDir: viteCacheDir,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __AUTH_MODE__: JSON.stringify(process.env.AUTH_MODE === 'true'),
    __E2E_MOCK__: JSON.stringify(process.env.E2E_MOCK === 'true'),
    __WEB__: JSON.stringify(true), // web bundle → browser/path history (Hono SPA fallback)
    __AMPLITUDE_API_KEY__: JSON.stringify(process.env.AMPLITUDE_API_KEY || analyticsConfig.defaultAmplitudeKey),
    __RENDER_TRACKING__: JSON.stringify(process.env.RENDER_TRACKING === 'true'),
    'process.env.MESSAGES_PAGE_LIMIT': JSON.stringify(process.env.MESSAGES_PAGE_LIMIT ?? ''),
    'process.env.MESSAGES_PAGE_OLDER_LIMIT': JSON.stringify(process.env.MESSAGES_PAGE_OLDER_LIMIT ?? ''),
    'globalThis.__PLATFORM_BASE_URL__': JSON.stringify(process.env.PLATFORM_BASE_URL || ''),
    'globalThis.__PLATFORM_PROXY_URL__': JSON.stringify(process.env.PLATFORM_PROXY_URL || ''),
    'globalThis.__PLATFORM_AUTH_ISSUER_URL__': JSON.stringify(process.env.PLATFORM_AUTH_ISSUER_URL || ''),
  },
  plugins: [
    react(),
    // Web-only precaching service worker (this config never builds the Electron
    // renderer — that's electron.vite.config.ts). After first paint the SW pulls
    // the FULL hashed asset set in the background, so:
    //  - lazy route chunks are already local when a surface is first visited
    //    (instant navigation; unvisited surfaces survive flaky/offline networks)
    //  - each deploy activates as one atomic asset set — a stale open tab keeps
    //    being served its own version's chunks instead of 404ing mid-deploy
    // Registration is hand-rolled in main.tsx (gated __WEB__ + PROD), NOT
    // injected here, so the gate is visible in app code. No runtime caching is
    // configured: /api/* (including SSE) is never touched by the SW.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false, // keep the hand-authored public/manifest.webmanifest
      workbox: {
        // Both explicit (registerType alone does NOT set clientsClaim in
        // vite-plugin-pwa 1.x): a new deploy's SW activates immediately and
        // takes over open pages, and the very first visit is controlled as
        // soon as install finishes — without claim, offline navigateFallback
        // wouldn't apply until a second visit.
        skipWaiting: true,
        clientsClaim: true,
        // Everything the UI is made of; hdr-*.mp4 stay network-only (decorative).
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        // Offline deep links get the app shell; /api and /auth (SSO launcher) must hit the network.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//],
        // Vendor chunk exceeds workbox's 2MB default before compression.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        inlineWorkboxRuntime: true, // single sw.js file, nothing extra at the dist root
        sourcemap: false,
      },
    }),
    devServer({
      entry: 'src/api/index.ts',
      exclude: [/^(?!\/api).*/], // Only handle /api/* routes
    }),
    {
      name: 'server-lifecycle',
      configureServer(server) {
        // Sync process.env.PORT to the actual bound port so that
        // getAppPort() returns the right value even when Vite auto-assigns.
        server.httpServer?.on('listening', () => {
          const addr = server.httpServer?.address()
          if (addr && typeof addr === 'object') {
            process.env.PORT = String(addr.port)
          }
        })
        if (server.httpServer) {
          server.ssrLoadModule(path.resolve(__dirname, 'src/shared/lib/startup.ts')).then(
            ({ setupServerHandlers, afterBindInitialize }) => {
              setupServerHandlers(server.httpServer as any)
              void afterBindInitialize()
            },
          )
        }
        server.httpServer?.on('close', async () => {
          const { shutdownServices } = await server.ssrLoadModule(
            path.resolve(__dirname, 'src/shared/lib/startup.ts'),
          )
          await shutdownServices()
          console.log('All services stopped.')
        })
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './src/shared'),
      '@renderer': path.resolve(__dirname, './src/renderer'),
    },
  },
  root: './src/renderer',
  // outDir sits OUTSIDE the Vite root, so Vite does not clean it by default —
  // consecutive builds would accumulate old hashed chunks, and the SW precache
  // manifest globs the output dir, so stale generations would be precached as
  // dead weight. (Docker builds were immune — fresh workspace — but local
  // `npm run preview` and the PWA E2E suite were not.)
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: {
    port: parseInt(process.env.PORT || '47891', 10),
    host: '0.0.0.0',
    allowedHosts: [
      'host.docker.internal',
      'host.containers.internal',
      ...((process.env.TRUSTED_ORIGINS || '').split(',').map(o => { try { return new URL(o.trim()).hostname } catch { return '' } }).filter(Boolean)),
    ],
  },
})
