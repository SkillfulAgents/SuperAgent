import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let tempDir: string

vi.mock('@shared/lib/config/data-dir', () => ({
  getDataDir: () => tempDir,
}))

import { getOrCreateHostToken } from './host-token-store'

describe('host-token-store', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-token-store-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates a token per agent and returns the same one on later calls', () => {
    const first = getOrCreateHostToken('agent-a')
    expect(first).toMatch(/^hostc_[0-9a-f]{64}$/)
    expect(getOrCreateHostToken('agent-a')).toBe(first)
    expect(getOrCreateHostToken('agent-b')).not.toBe(first)
  })

  it('persists tokens across reads (survives a host restart)', () => {
    const token = getOrCreateHostToken('agent-a')
    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'host-container-tokens.json'), 'utf-8'))
    expect(onDisk['agent-a']).toBe(token)
  })

  it('writes the token file owner-read/write only', () => {
    getOrCreateHostToken('agent-a')
    const mode = fs.statSync(path.join(tempDir, 'host-container-tokens.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('regenerates from scratch when the file is corrupt', () => {
    fs.writeFileSync(path.join(tempDir, 'host-container-tokens.json'), 'not-json')
    const token = getOrCreateHostToken('agent-a')
    expect(token).toMatch(/^hostc_/)
    expect(getOrCreateHostToken('agent-a')).toBe(token)
  })
})
