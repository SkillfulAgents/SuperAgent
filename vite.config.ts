import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import devServer from '@hono/vite-dev-server'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __AUTH_MODE__: JSON.stringify(process.env.AUTH_MODE === 'true'),
  },
  plugins: [
    react(),
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
        // Set up server-level handlers (WebSocket proxies, etc.)
        if (server.httpServer) {
          server.ssrLoadModule(path.resolve(__dirname, 'src/shared/lib/startup.ts')).then(({ setupServerHandlers }) => {
            setupServerHandlers(server.httpServer as any)
          })
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
  build: { outDir: '../../dist/renderer' },
  server: {
    port: parseInt(process.env.PORT || '47891', 10),
    host: '0.0.0.0',
    allowedHosts: ['host.docker.internal', 'host.containers.internal'],
  },
})
