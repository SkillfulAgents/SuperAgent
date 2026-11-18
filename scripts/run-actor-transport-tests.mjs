// Run the unit tests with every agent actor reached through the serializing
// test transport (src/shared/lib/agent-actor/serializing-actor.ts): arguments
// and results structured-cloned, a macrotask on each side of every op, errors
// carried as data. A caller that holds a reference into an actor's state, uses
// an op's result without awaiting it, or counts on two ops running back to
// back fails here, as it would against an actor across a wire.
//
//   npm run test:actor-transport
//
// Every test file runs except those in scripts/actor-transport-exceptions.txt,
// each listed with why it cannot hold across a wire. The list only shrinks: a
// new test that fails here is a caller to fix, not a file to add.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const listPath = path.resolve('scripts/actor-transport-exceptions.txt')
const exceptions = readFileSync(listPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))

const result = spawnSync('npx', ['vitest', 'run', ...exceptions.flatMap((file) => ['--exclude', file])], {
  stdio: 'inherit',
  env: { ...process.env, SUPERAGENT_ACTOR_TRANSPORT: 'serializing' },
})
process.exit(result.status ?? 1)
