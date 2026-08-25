import { afterEach, describe, expect, it } from 'vitest'
import { clearSettingsCache, getSettings, updateSettings } from '@shared/lib/config/settings'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  BrainCuratorNotFoundError,
  clearCuratorIfSlug,
  getCuratorSlug,
  isTeamBrainEnabled,
  setCuratorSlug,
} from './brain-service'

describe('curator slug', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  it('stores one slug and clears it', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-curator-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    fs.mkdirSync(path.join(tmp, 'agents', 'sales-bot'), { recursive: true })
    expect(getCuratorSlug()).toBeNull()
    expect(await setCuratorSlug('sales-bot')).toBe('sales-bot')
    expect(getCuratorSlug()).toBe('sales-bot')
    expect(await setCuratorSlug(null)).toBeNull()
    expect(getCuratorSlug()).toBeNull()
  })

  it('rejects an unknown agent', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-curator-miss-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    await expect(setCuratorSlug('missing-bot')).rejects.toThrow(BrainCuratorNotFoundError)
  })

  it('replaces the slug and clears only a matching delete', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-curator-swap-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    fs.mkdirSync(path.join(tmp, 'agents', 'sales-bot'), { recursive: true })
    fs.mkdirSync(path.join(tmp, 'agents', 'curator-bot'), { recursive: true })

    await setCuratorSlug('sales-bot')
    expect(await setCuratorSlug('curator-bot')).toBe('curator-bot')
    expect(getCuratorSlug()).toBe('curator-bot')

    clearCuratorIfSlug('sales-bot')
    expect(getCuratorSlug()).toBe('curator-bot')
    clearCuratorIfSlug('curator-bot')
    expect(getCuratorSlug()).toBeNull()
  })
})

describe('isTeamBrainEnabled', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  afterEach(() => {
    clearSettingsCache()
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  it('is off until the workspace setting is on', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-flag-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    clearSettingsCache()
    expect(isTeamBrainEnabled()).toBe(false)
    updateSettings({ ...getSettings(), teamBrain: true })
    expect(isTeamBrainEnabled()).toBe(true)
  })
})
