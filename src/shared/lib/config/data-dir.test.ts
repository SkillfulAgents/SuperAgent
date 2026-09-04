import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getCacheDir, getDataDir, getDatabasePath, getVolumeDir, getVolumesDataDir, storageSubPath } from './data-dir'

describe('getDataDir / getDatabasePath', () => {
  const prevDataDir = process.env.SUPERAGENT_DATA_DIR
  const prevDbPath = process.env.SUPERAGENT_DB_PATH
  const prevCacheDir = process.env.SUPERAGENT_CACHE_DIR

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prevDataDir
    if (prevDbPath === undefined) delete process.env.SUPERAGENT_DB_PATH
    else process.env.SUPERAGENT_DB_PATH = prevDbPath
    if (prevCacheDir === undefined) delete process.env.SUPERAGENT_CACHE_DIR
    else process.env.SUPERAGENT_CACHE_DIR = prevCacheDir
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

  it('defaults cache dir to getDataDir()/skillset-cache', () => {
    delete process.env.SUPERAGENT_DATA_DIR
    delete process.env.SUPERAGENT_CACHE_DIR
    expect(getCacheDir()).toBe(path.join(os.homedir(), '.superagent', 'skillset-cache'))
  })

  it('uses SUPERAGENT_CACHE_DIR when set', () => {
    process.env.SUPERAGENT_DATA_DIR = '/tmp/sa-data'
    process.env.SUPERAGENT_CACHE_DIR = '/tmp/sa-cache'
    expect(getCacheDir()).toBe(path.resolve('/tmp/sa-cache'))
    expect(getDataDir()).toBe(path.resolve('/tmp/sa-data'))
  })

  it('places a volume dir under SUPERAGENT_DATA_DIR/volumes/<id>', () => {
    process.env.SUPERAGENT_DATA_DIR = '/tmp/sa-data'
    expect(getVolumesDataDir()).toBe(path.join(path.resolve('/tmp/sa-data'), 'volumes'))
    expect(getVolumeDir('abc')).toBe(path.join(path.resolve('/tmp/sa-data'), 'volumes', 'abc'))
  })
})

describe('storageSubPath', () => {
  let dataDir: string
  let outside: string
  const prev = process.env.SUPERAGENT_DATA_DIR

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-data-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-outside-'))
    fs.mkdirSync(path.join(dataDir, 'volumes', 'abc'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'agents', 'x', 'workspace'), { recursive: true })
    process.env.SUPERAGENT_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.SUPERAGENT_DATA_DIR
    else process.env.SUPERAGENT_DATA_DIR = prev
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('maps a shared volume dir to volumes/<id>', () => {
    expect(storageSubPath(path.join(dataDir, 'volumes', 'abc'))).toBe('volumes/abc')
  })

  it('maps an agent workspace to agents/<slug>/workspace', () => {
    expect(storageSubPath(path.join(dataDir, 'agents', 'x', 'workspace'))).toBe('agents/x/workspace')
  })

  it('resolves a symlinked data dir to the same sub-path', () => {
    const link = path.join(os.tmpdir(), `sa-link-${process.pid}`)
    fs.symlinkSync(dataDir, link)
    try {
      process.env.SUPERAGENT_DATA_DIR = link
      expect(storageSubPath(path.join(link, 'volumes', 'abc'))).toBe('volumes/abc')
      expect(storageSubPath(path.join(dataDir, 'volumes', 'abc'))).toBe('volumes/abc')
    } finally {
      fs.unlinkSync(link)
    }
  })

  it('refuses a path outside the data dir', () => {
    expect(storageSubPath(outside)).toBeNull()
  })

  it('refuses the data dir itself', () => {
    expect(storageSubPath(dataDir)).toBeNull()
  })

  it('refuses a path that does not exist', () => {
    expect(storageSubPath(path.join(dataDir, 'volumes', 'missing'))).toBeNull()
  })
})
