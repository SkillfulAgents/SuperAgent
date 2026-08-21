import { afterEach, describe, expect, it } from 'vitest'
import os from 'os'
import path from 'path'
import { getDataDir, getDatabasePath } from './data-dir'

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
