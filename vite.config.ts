import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import devServer from '@hono/vite-dev-server'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    devServer({
      entry: 'src/api/index.ts',
      exclude: [/^(?!\/api).*/], // Only handle /api/* routes
    }),
    {
      name: 'container-shutdown',
      configureServer(server) {
        server.httpServer?.on('close', async () => {
          const { containerManager } = await import('./src/shared/lib/container/container-manager')
          await containerManager.stopAll()
          console.log('All containers stopped.')
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
