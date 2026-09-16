import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The web entry's boot order: error reporting first, then the database, then
// the bind. A failed open is the first thing that can end the process, and
// its fatal report must have a provider to reach and time to send.
const calls: string[] = []
const openDatabase = vi.fn(async () => {
  calls.push('openDatabase')
})
const initErrorReporting = vi.fn(() => {
  calls.push('initErrorReporting')
})
const flushErrorReporting = vi.fn(async () => {
  calls.push('flushErrorReporting')
  return true
})
const bindServerWithRetry = vi.fn(async () => {
  calls.push('bind')
  return { server: { close: vi.fn() }, port: 47891 }
})
const afterBindInitialize = vi.fn(async () => {
  calls.push('afterBindInitialize')
})

vi.mock('../api', async () => {
  const { Hono } = await import('hono')
  return { default: new Hono() }
})
vi.mock('@shared/lib/db', () => ({ openDatabase }))
vi.mock('@shared/lib/error-reporting', () => ({ initErrorReporting, flushErrorReporting }))
vi.mock('@shared/lib/server-bind', () => ({ bindServerWithRetry }))
vi.mock('@shared/lib/startup', () => ({
  afterBindInitialize,
  setupServerHandlers: vi.fn(),
  shutdownServices: vi.fn(),
}))
vi.mock('@shared/lib/boot-timing', () => ({ markBoot: vi.fn() }))

async function boot() {
  vi.resetModules()
  await import('./server')
  // start() is fire-and-forget at module load; let its chain settle.
  await vi.waitFor(() => expect(calls.includes('afterBindInitialize') || calls.includes('exit')).toBe(true))
}

let exitSpy: ReturnType<typeof vi.spyOn>
let previousNodeEnv: string | undefined

beforeEach(() => {
  calls.length = 0
  previousNodeEnv = process.env.NODE_ENV
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    calls.push(`exit:${code}`)
    calls.push('exit')
  }) as never)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
  vi.restoreAllMocks()
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
})

describe('web server boot order', () => {
  it('initialises error reporting before opening the database, then binds', async () => {
    process.env.NODE_ENV = 'production'
    await boot()
    expect(calls).toEqual(['initErrorReporting', 'openDatabase', 'bind', 'afterBindInitialize'])
  })

  it('skips error reporting outside production, as afterBindInitialize does', async () => {
    process.env.NODE_ENV = 'test'
    await boot()
    expect(calls).toEqual(['openDatabase', 'bind', 'afterBindInitialize'])
  })

  it('flushes error reporting before exiting when the database fails to open', async () => {
    process.env.NODE_ENV = 'production'
    openDatabase.mockImplementationOnce(async () => {
      calls.push('openDatabase')
      throw new Error('database disk image is malformed')
    })
    await boot()
    expect(calls).toEqual(['initErrorReporting', 'openDatabase', 'flushErrorReporting', 'exit:1', 'exit'])
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
