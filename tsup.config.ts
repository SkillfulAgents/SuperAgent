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

// Keep the generated browser SDK as its own build entry. In development Vite
// resolves the source dynamic import normally; the production server instead
// points at the sibling emitted module so the 170 KB payload is not parsed at
// API boot.
const lazyDashboardSdkPlugin: Plugin = {
  name: 'lazy-dashboard-sdk',
  setup(build) {
    const apiEntryPath = resolve('src/api/index.ts')
    // Any specifier for the module (relative or aliased), but not the entry
    // point itself — entries resolve with their .ts extension.
    build.onResolve({ filter: /llm-sdk-bundle$/ }, (args) => {
      if (args.kind === 'dynamic-import' && resolve(args.importer) === apiEntryPath) {
        return { path: './llm-sdk-bundle.mjs', external: true }
      }
      // Any other import would silently inline the 170 KB payload back into
      // the boot artifact — fail the build instead.
      return {
        errors: [{
          text: `llm-sdk-bundle must only be loaded via the dynamic import in src/api/index.ts; found a ${args.kind} in ${args.importer}. Route it through that import (or extend lazy-dashboard-sdk in tsup.config.ts) so the payload stays out of the API boot artifact.`,
        }],
      }
    })
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
  entry: {
    server: 'src/web/server.ts',
    'llm-sdk-bundle': 'src/api/llm-sdk-bundle.ts',
  },
  format: ['esm'],
  outDir: 'dist/web',
  splitting: false,
  noExternal: dependencies.filter((name) => !isExternal(name)),
  // Pass externalExact directly (not filtered through pkg.dependencies):
  // require/import-in-the-middle are transitive deps of Sentry/OTel, so a
  // dependency filter would silently drop them from esbuild's external list.
  external: [
    ...externalExact,
    ...externalPrefix.map((p) => new RegExp(`^${p}`)),
  ],
  // Inlined CJS may call require('events'); give the ESM bundle a real require.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  esbuildPlugins: [rawLoaderPlugin, lazyDashboardSdkPlugin],
})
