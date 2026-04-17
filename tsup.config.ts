import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { defineConfig } from 'tsup'
import type { Plugin } from 'esbuild'
import pkg from './package.json'

// Handle Vite-style `?raw` imports (e.g. `import md from './foo.md?raw'`)
// so they bundle the file contents as a string, matching Vite's behavior.
const rawLoaderPlugin: Plugin = {
  name: 'raw-loader',
  setup(build) {
    build.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: resolve(args.resolveDir, args.path.replace(/\?raw$/, '')),
      namespace: 'raw-loader',
    }))
    build.onLoad({ filter: /.*/, namespace: 'raw-loader' }, async (args) => ({
      contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))}`,
      loader: 'js',
    }))
  },
}

export default defineConfig({
  entry: ['src/web/server.ts'],
  format: ['esm'],
  outDir: 'dist/web',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  esbuildPlugins: [rawLoaderPlugin],
})
