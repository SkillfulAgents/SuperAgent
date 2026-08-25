import { afterEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BRAIN_INDEX_FILENAME, ensureBrainDir, getBrainDir, getDataDir, getDatabasePath } from './data-dir'

describe('getDataDir / getDatabasePath', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  const prevDbPath = process.env.SUPERAGENT_DB_PATH

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
    if (prevDbPath === undefined) delete process.env.SUPERAGENT_DB_PATH
    else process.env.SUPERAGENT_DB_PATH = prevDbPath
  })

  it('defaults DB path to ~/.superagent/superagent.db', () => {
    delete process.env.SUPERAGENT_DATA_DIR
    delete process.env.SUPERAGENT_DB_PATH
    expect(getDataDir()).toBe(path.join(os.homedir(), '.superagent'))
    expect(getDatabasePath()).toBe(path.join(os.homedir(), '.superagent', 'superagent.db'))
  })

  it('places the DB under SUPERAGENT_DATA_DIR when set', () => {
    process.env.SUPERAGENT_DATA_DIR = '/tmp/sa-data'
    delete process.env.SUPERAGENT_DB_PATH
    expect(getDataDir()).toBe(path.resolve('/tmp/sa-data'))
    expect(getDatabasePath()).toBe(path.join(path.resolve('/tmp/sa-data'), 'superagent.db'))
  })

  it('lets SUPERAGENT_DB_PATH win over SUPERAGENT_DATA_DIR', () => {
    process.env.SUPERAGENT_DATA_DIR = '/tmp/sa-data'
    process.env.SUPERAGENT_DB_PATH = '/sqlite/superagent.db'
    expect(getDataDir()).toBe(path.resolve('/tmp/sa-data'))
    expect(getDatabasePath()).toBe(path.resolve('/sqlite/superagent.db'))
  })

  it('resolves a relative SUPERAGENT_DB_PATH', () => {
    delete process.env.SUPERAGENT_DATA_DIR
    process.env.SUPERAGENT_DB_PATH = 'relative/superagent.db'
    expect(getDatabasePath()).toBe(path.resolve('relative/superagent.db'))
  })
})

describe('getBrainDir / ensureBrainDir', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  let tmp: string

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
  })

  it('sits beside agents/, not under it', () => {
    process.env.SUPERAGENT_DATA_DIR = '/tmp/sa-brain-path'
    expect(getBrainDir()).toBe(path.join(path.resolve('/tmp/sa-brain-path'), 'brains', 'global'))
    expect(getBrainDir()).not.toMatch(/\/agents\//)
  })

  it('creates the directory and is idempotent', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    const first = ensureBrainDir()
    const second = ensureBrainDir()
    expect(first).toBe(path.join(tmp, 'brains', 'global'))
    expect(first).toBe(second)
    expect(fs.statSync(first).isDirectory()).toBe(true)
  })

  it('seeds INDEX.md once and leaves curator edits alone', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-brain-'))
    process.env.SUPERAGENT_DATA_DIR = tmp
    const dir = ensureBrainDir()
    const indexPath = path.join(dir, BRAIN_INDEX_FILENAME)
    expect(fs.readFileSync(indexPath, 'utf8')).toMatch(/Curator-owned catalog/)
    fs.writeFileSync(indexPath, '# edited by curator\n')
    ensureBrainDir()
    expect(fs.readFileSync(indexPath, 'utf8')).toBe('# edited by curator\n')
  })
})
