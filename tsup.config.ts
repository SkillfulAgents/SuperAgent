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

// Stay in node_modules: natives, Electron, and packages that patch require/import.
const externalExact = new Set([
  'better-sqlite3',
  '@skillful-agents/agent-computer',
  'electron',
  'require-in-the-middle',
  'import-in-the-middle',
])
const externalPrefix = ['@sentry/', '@opentelemetry/']

function isExternal(name: string): boolean {
  return externalExact.has(name) || externalPrefix.some((p) => name.startsWith(p))
}

const dependencies = Object.keys(pkg.dependencies ?? {})

export default defineConfig({
  entry: ['src/web/server.ts'],
  format: ['esm'],
  outDir: 'dist/web',
  splitting: false,
  noExternal: dependencies.filter((name) => !isExternal(name)),
  external: [
    ...dependencies.filter(isExternal),
    ...externalPrefix.map((p) => new RegExp(`^${p}`)),
  ],
  // Inlined CJS may call require('events'); give the ESM bundle a real require.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  esbuildPlugins: [rawLoaderPlugin],
})
