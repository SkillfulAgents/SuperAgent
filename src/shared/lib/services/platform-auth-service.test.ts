import fs from 'fs'
import os from 'os'
import path from 'path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearSettingsCache } from '@shared/lib/config/settings'

import {
  getPlatformAccessToken,
  savePlatformAuth,
} from './platform-auth-service'

describe('platform-auth-service', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-platform-auth-'))
    process.env.SUPERAGENT_DATA_DIR = tempDir
    clearSettingsCache()
  })

  afterEach(() => {
    clearSettingsCache()
    fs.rmSync(tempDir, { recursive: true, force: true })
    delete process.env.SUPERAGENT_DATA_DIR
  })

  it('stores a token and exposes only redacted status', async () => {
    const status = await savePlatformAuth('local', {
      token: 'plat_superagent_token_1234567890abcdef',
      email: 'user@example.com',
      label: 'SuperAgent',
      orgId: 'org_test_123',
    })

    expect(status).toMatchObject({
      connected: true,
      email: 'user@example.com',
      label: 'SuperAgent',
      orgId: 'org_test_123',
    })
    expect(status.tokenPreview).toBe('plat_s...cdef')
    expect(getPlatformAccessToken('local')).toBe('plat_superagent_token_1234567890abcdef')

    const settingsPath = path.join(tempDir, 'settings.json')
    expect(fs.existsSync(settingsPath)).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(onDisk.platformAuth).toBeDefined()
    expect(onDisk.platformAuth.token).toBe('plat_superagent_token_1234567890abcdef')
  })

})
