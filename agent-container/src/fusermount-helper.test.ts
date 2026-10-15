import { execFileSync } from 'child_process'
import path from 'path'
import { it } from 'vitest'

// The helper is Python (Node cannot pass an open file over a socket), so its unit tests run under python3.
it('fusermount helper unit tests pass', () => {
  execFileSync('python3', ['-B', path.join(__dirname, '..', 'fusermount-helper.test.py')], { stdio: 'pipe' })
})
