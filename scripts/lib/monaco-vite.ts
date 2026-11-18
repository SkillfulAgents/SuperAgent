import { fileURLToPath } from 'node:url'
import type { Plugin } from 'esbuild'

const patchedSanitizer = fileURLToPath(
  new URL('../../node_modules/dompurify/dist/purify.es.mjs', import.meta.url),
)

// Monaco vendors DOMPurify and imports this relative path instead of the npm
// dependency. Use our patched package in both the web and Electron renderer.
export const monacoAliases = {
  './dompurify/dompurify.js': patchedSanitizer,
}

// Vite's dependency optimizer only applies resolve.alias to bare JS imports.
// Handle Monaco's relative import there too, or dev still embeds the old copy.
export const monacoOptimizerPlugin: Plugin = {
  name: 'monaco-patched-sanitizer',
  setup(build) {
    build.onResolve({ filter: /^\.\/dompurify\/dompurify\.js$/ }, ({ importer }) => {
      if (importer.replaceAll('\\', '/').endsWith('/monaco-editor/esm/vs/base/browser/domSanitize.js')) {
        return { path: patchedSanitizer }
      }
      return undefined
    })
  },
}
