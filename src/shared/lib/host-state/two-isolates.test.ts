/**
 * The API on two "isolates" (two module graphs over one database file), each
 * request with its own empty data dir and no background services started:
 * the shape a Workers for Platforms deployment serves requests in.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-1410-'))
const dbUrl = `file:${path.join(tmp, 'org.db')}`

function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
}

/** Runs `fn` with a fresh, empty data dir and returns what it left there. */
async function withEmptyDataDir<T>(fn: () => Promise<T>): Promise<{ result: T; leftFiles: string[] }> {
  const dir = fs.mkdtempSync(path.join(tmp, 'fs-'))
  const previous = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = dir
  try {
    const result = await fn()
    return { result, leftFiles: fs.readdirSync(dir, { recursive: true }) as string[] }
  } finally {
    process.env.SUPERAGENT_DATA_DIR = previous
  }
}

async function bootIsolate() {
  vi.resetModules()
  const { openDatabase } = await import('@shared/lib/db/open-database')
  const { libsql } = await import('@shared/lib/db/drivers/libsql')
  const { databaseHostStateStore } = await import('./store')
  const { runWithHostState } = await import('./scope')
  const { hostStateMiddleware } = await import('./middleware')

  const db = await openDatabase({
    driver: libsql(dbUrl),
    dataMigrationScope: (db, run) => runWithHostState(databaseHostStateStore(db), run),
  })
  const api = (await import('../../../api')).default
  const app = new Hono()
  app.use('*', hostStateMiddleware(databaseHostStateStore(db)))
  app.route('/', api)
  return {
    request: (url: string, init?: RequestInit) => withEmptyDataDir(() => Promise.resolve(app.request(url, init))),
  }
}

let isolateA: Awaited<ReturnType<typeof bootIsolate>>
let isolateB: Awaited<ReturnType<typeof bootIsolate>>
let timersBefore: number
let bootLeftFiles: string[]

beforeAll(async () => {
  timersBefore = activeTimers()
  const booted = await withEmptyDataDir(async () => {
    isolateA = await bootIsolate()
    isolateB = await bootIsolate()
  })
  bootLeftFiles = booted.leftFiles
}, 120_000)

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the API on two isolates with no process state', () => {
  it('boots without writing host files', () => {
    expect(bootLeftFiles).toEqual([])
  })

  it('sees on isolate B a setting saved on isolate A, with nothing left on disk', async () => {
    const saved = await isolateA.request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app: { theme: 'dark' } }),
    })
    expect(saved.result.status).toBe(200)
    expect(saved.leftFiles).toEqual([])

    const read = await isolateB.request('/api/settings')
    expect(read.result.status).toBe(200)
    expect((await read.result.json()).app.theme).toBe('dark')
    expect(read.leftFiles).toEqual([])
  }, 60_000)

  it('starts no timers', () => {
    expect(activeTimers()).toBe(timersBefore)
  })
})
