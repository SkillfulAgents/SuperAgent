import { afterEach, describe, expect, it } from 'vitest'
import { clearSettingsCache, getSettings, updateSettings } from '@shared/lib/config/settings'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BRAIN_INDEX_FILENAME } from '@shared/lib/config/data-dir'
import { PAGE_BODY_MAX_BYTES } from '@shared/lib/types/brain-schema'
import {
  BrainCuratorNotFoundError,
  BrainIndexProtectedError,
  BrainPageTooLargeError,
  clearCuratorIfSlug,
  deletePage,
  getCuratorSlug,
  isTeamBrainEnabled,
  readPage,
  setCuratorSlug,
  writePage,
} from './brain-service'

describe('readPage', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  function useTmp() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-read-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
  }

  it('seeds and reads INDEX.md', () => {
    useTmp()
    const page = readPage('INDEX.md')
    expect(page?.name).toBe(BRAIN_INDEX_FILENAME)
    expect(page?.description).toBe('Team Brain')
    expect(page?.body).toMatch(/Curator-owned catalog/)
  })

  it('reads a kebab page and misses an unknown one', () => {
    useTmp()
    const dir = path.join(tmp, 'brain')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'pricing-decisions.md'), '# Why seat pricing\n')
    expect(readPage('pricing-decisions')?.body).toBe('# Why seat pricing\n')
    expect(readPage('missing-page')).toBeNull()
  })

  it('rejects a page over the byte cap', () => {
    useTmp()
    const dir = path.join(tmp, 'brain')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'huge.md'), 'x'.repeat(PAGE_BODY_MAX_BYTES + 1))
    expect(() => readPage('huge')).toThrow(BrainPageTooLargeError)
  })
})

describe('writePage / deletePage', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  function useTmp() {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-write-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
  }

  it('upserts a kebab page', () => {
    useTmp()
    expect(writePage('pricing-decisions', '# Why\n')).toEqual({
      name: 'pricing-decisions.md',
      updatedAt: expect.any(String),
    })
    expect(readPage('pricing-decisions')?.body).toBe('# Why\n')
    writePage('pricing-decisions', '# Updated\n')
    expect(readPage('pricing-decisions')?.body).toBe('# Updated\n')
  })

  it('lets the curator rewrite INDEX.md', () => {
    useTmp()
    writePage('INDEX.md', '# Catalog\n- pricing-decisions — why\n')
    expect(readPage('INDEX.md')?.body).toBe('# Catalog\n- pricing-decisions — why\n')
  })

  it('refuses to delete INDEX.md', () => {
    useTmp()
    readPage('INDEX.md')
    expect(() => deletePage('INDEX.md')).toThrow(BrainIndexProtectedError)
    expect(readPage('INDEX.md')).not.toBeNull()
  })

  it('deletes a named page', () => {
    useTmp()
    writePage('scratch', 'tmp')
    expect(deletePage('scratch')).toEqual({ name: 'scratch.md' })
    expect(readPage('scratch')).toBeNull()
    expect(deletePage('scratch')).toBeNull()
  })
})

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
