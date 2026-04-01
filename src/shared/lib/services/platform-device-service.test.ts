import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getOrCreatePlatformClientInstanceId,
  getPlatformDeviceName,
} from './platform-device-service'

describe('platform-device-service', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-platform-device-'))
    process.env.SUPERAGENT_DATA_DIR = tempDir
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
    vi.restoreAllMocks()
  })

  it('persists a stable client instance id', () => {
    const first = getOrCreatePlatformClientInstanceId()
    const second = getOrCreatePlatformClientInstanceId()

    expect(first).toBeTruthy()
    expect(second).toBe(first)
  })

  it('returns a non-empty device name', () => {
    const name = getPlatformDeviceName()
    expect(name).toBeTruthy()
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
  })
})
