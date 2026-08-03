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

function isBundleExternal(name: string): boolean {
  if (
    name === 'better-sqlite3' ||
    name === '@skillful-agents/agent-computer' ||
    name === 'electron' ||
    name === 'require-in-the-middle' ||
    name === 'import-in-the-middle'
  ) {
    return true
  }
  if (name.startsWith('@sentry/') || name.startsWith('@opentelemetry/')) return true
  return false
}

const dependencyNames = Object.keys(pkg.dependencies ?? {})

export default defineConfig({
  entry: ['src/web/server.ts'],
  format: ['esm'],
  outDir: 'dist/web',
  // One file so the createRequire banner applies to all inlined CJS (ws, etc.).
  splitting: false,
  // Bundle most deps for cold-wake; leave natives + Sentry/OTel in node_modules.
  noExternal: dependencyNames.filter((name) => !isBundleExternal(name)),
  external: [
    'better-sqlite3',
    '@skillful-agents/agent-computer',
    'electron',
    'require-in-the-middle',
    'import-in-the-middle',
    /^@sentry\//,
    /^@opentelemetry\//,
  ],
  // esbuild's ESM __require shim needs a real require for CJS deps that call require('events').
  banner: {
    js: "import { createRequire as __coldWakeCreateRequire } from 'module'; const require = __coldWakeCreateRequire(import.meta.url);",
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  esbuildPlugins: [rawLoaderPlugin],
})
