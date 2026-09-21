// Run the unit tests that must pass against libsql, the asynchronous,
// batch-only driver that stands in for Cloudflare D1 in CI.
//
//   npm run test:libsql
//
// The list in scripts/libsql-must-pass.txt names test files; a file is added
// once it passes on both drivers, and the list only grows (SUP-865 converts
// directories to awaited access and adds them here as it goes). A file that
// stops passing is a regression, not a reason to remove it.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const listPath = path.resolve('scripts/libsql-must-pass.txt')
const files = readFileSync(listPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))

if (files.length === 0) {
  console.error(`${listPath} names no test files; the libsql must-pass list may only grow.`)
  process.exit(1)
}

const result = spawnSync('npx', ['vitest', 'run', ...files], {
  stdio: 'inherit',
  env: { ...process.env, DB_DRIVER: 'libsql' },
})
process.exit(result.status ?? 1)
