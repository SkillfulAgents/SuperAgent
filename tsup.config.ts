import { defineConfig } from 'tsup'
import pkg from './package.json'

export default defineConfig({
  entry: ['src/web/server.ts'],
  format: ['esm'],
  outDir: 'dist/web',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
