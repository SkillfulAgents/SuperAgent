// Emits the Worker's server code for wrangler to bundle, with every import loaded at first use,
// so a new isolate evaluates only the modules its first request reaches. esbuild strips the types,
// then Babel's CommonJS transform with `lazy` defers each import until its first read. The entry
// stays ESM so wrangler sees the Durable Object classes it exports.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync as stripTypes } from 'esbuild'
import { transformSync } from '@babel/core'

const root = fileURLToPath(new URL('../..', import.meta.url))
const out = path.join(root, 'dist/cf-worker')
const sources = ['src/api', 'src/cf', 'src/shared', 'src/web', 'src/main', 'agent-container/src']
const entry = path.join(root, 'src/cf/index.ts')
// A Worker cannot `require('cloudflare:workers')`, so the CommonJS files import it through this ESM file.
const workersModule = path.join(out, 'cloudflare-workers.mjs')

const throughWorkersModule = (dir) => () => ({
  visitor: {
    'ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration'({ node }) {
      if (node.source?.value === 'cloudflare:workers') node.source.value = path.relative(dir, workersModule)
    },
  },
})

function emit(from) {
  const to = path.join(out, path.relative(root, from))
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (from === entry || !/\.tsx?$/.test(from)) return fs.copyFileSync(from, to)
  const esm = stripTypes(fs.readFileSync(from, 'utf8'), {
    loader: from.endsWith('x') ? 'tsx' : 'ts', format: 'esm', jsx: 'automatic', target: 'es2022', sourcefile: from,
  }).code
  // `import.meta` exists only in ESM, so such a file stays ESM and its own imports load eagerly.
  if (esm.includes('import.meta')) return fs.writeFileSync(to.replace(/\.tsx?$/, '.js'), esm)
  const { code } = transformSync(esm, {
    babelrc: false, configFile: false, cwd: root, filename: from, sourceType: 'module',
    plugins: [throughWorkersModule(path.dirname(to)), ['@babel/plugin-transform-modules-commonjs', { lazy: () => true, importInterop: 'babel' }]],
  })
  fs.writeFileSync(to.replace(/\.tsx?$/, '.js'), code)
}

function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const from = path.join(dir, item.name)
    if (item.isDirectory()) { if (item.name !== 'node_modules') walk(from); continue }
    if (!/\.(test|spec)\.tsx?$|\.d\.ts$/.test(item.name)) emit(from)
  }
}

fs.rmSync(out, { recursive: true, force: true })
for (const dir of sources) walk(path.join(root, dir))
fs.writeFileSync(workersModule, "export * from 'cloudflare:workers'\n")
// The same `@/` and `@shared/` paths, now resolved inside the output.
fs.copyFileSync(path.join(root, 'tsconfig.json'), path.join(out, 'tsconfig.json'))
