import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { resolveChromiumExecutable } from './dashboard-screenshot'

describe('resolveChromiumExecutable', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pw-resolver-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns the path when the binary exists and is executable', () => {
    const bin = path.join(tmpDir, 'chromium-current')
    fs.writeFileSync(bin, '#!/bin/sh\necho stub\n')
    fs.chmodSync(bin, 0o755)
    expect(resolveChromiumExecutable(bin)).toBe(bin)
  })

  it('returns null when the binary is missing', () => {
    const bin = path.join(tmpDir, 'chromium-current')
    expect(resolveChromiumExecutable(bin)).toBeNull()
  })

  it('returns null when the file exists but is not executable', () => {
    const bin = path.join(tmpDir, 'chromium-current')
    fs.writeFileSync(bin, '')
    fs.chmodSync(bin, 0o644)
    expect(resolveChromiumExecutable(bin)).toBeNull()
  })
})

// End-to-end capture behaviour is exercised by the Dockerfile build-time
// assertion (scripts/assert-chromium-available.ts) and the E2E suite; unit
// testing the thin playwright-core glue without mocking the whole library
// gives little signal for the effort, so we rely on the resolver tests and
// the build canary to catch regressions.
