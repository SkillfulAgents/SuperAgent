import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getTenantId } from './tenant-id'

describe('getTenantId on desktop', () => {
  let dataDir: string

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-id-test-'))
    process.env.SUPERAGENT_DATA_DIR = dataDir
  })

  afterEach(() => {
    delete process.env.SUPERAGENT_DATA_DIR
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('makes an id once and returns the same one after', () => {
    const first = getTenantId()
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(getTenantId()).toBe(first)
    expect(fs.readFileSync(path.join(dataDir, 'tenant-id'), 'utf-8').trim()).toBe(first)
  })

  it('replaces an empty file left by a write cut short with a new id', () => {
    fs.writeFileSync(path.join(dataDir, 'tenant-id'), '')
    const id = getTenantId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fs.readFileSync(path.join(dataDir, 'tenant-id'), 'utf-8').trim()).toBe(id)
    expect(getTenantId()).toBe(id)
  })
})
