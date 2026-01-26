import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import devServer from '@hono/vite-dev-server'
import path from 'path'

export default defineConfig({
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
    port: 3000,
  },
})
