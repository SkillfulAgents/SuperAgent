import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { captureMessage, flushErrorReporting, getErrorReporter } from '@shared/lib/error-reporting'
import {
  recordFatalError,
  reportCrashMarkerFromLastRun,
  toReportableError,
  getCrashMarkerPath,
} from './crash-marker'
import { crashMarkerSchema } from './crash-marker-schema'

vi.mock('@shared/lib/error-reporting', () => ({
  captureMessage: vi.fn(() => 'event-id'),
  flushErrorReporting: vi.fn(async () => true),
  getErrorReporter: vi.fn(() => ({}) as never),
}))

let tmpDir: string
let savedDataDir: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-marker-test-'))
  savedDataDir = process.env.SUPERAGENT_DATA_DIR
  process.env.SUPERAGENT_DATA_DIR = tmpDir
  vi.mocked(captureMessage).mockClear()
  vi.mocked(flushErrorReporting).mockClear()
  vi.mocked(flushErrorReporting).mockResolvedValue(true)
  vi.mocked(getErrorReporter).mockReturnValue({} as never)
})

afterEach(() => {
  if (savedDataDir === undefined) {
    delete process.env.SUPERAGENT_DATA_DIR
  } else {
    process.env.SUPERAGENT_DATA_DIR = savedDataDir
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function readMarkerFile() {
  return crashMarkerSchema.parse(JSON.parse(fs.readFileSync(getCrashMarkerPath(), 'utf8')))
}

describe('toReportableError', () => {
  it('passes Error instances through unchanged', () => {
    const err = new TypeError('boom')
    expect(toReportableError(err)).toBe(err)
  })

  it('describes an undefined reason instead of producing "Error: undefined"', () => {
    const err = toReportableError(undefined)
    expect(err.message).toContain('Non-Error fatal reason')
    expect(err.message).toContain('undefined')
  })

  it('inspects non-Error object reasons', () => {
    const err = toReportableError({ code: 'ECONNRESET', attempt: 3 })
    expect(err.message).toContain('ECONNRESET')
    expect(err.message).toContain('attempt')
  })
})

describe('recordFatalError', () => {
  it('writes a schema-valid marker with the error details', () => {
    const boom = new Error('it broke')
    recordFatalError('uncaughtException', boom)

    const marker = readMarkerFile()
    expect(marker.entries).toHaveLength(1)
    expect(marker.entries[0]).toMatchObject({
      type: 'uncaughtException',
      name: 'Error',
      message: 'it broke',
    })
    expect(marker.entries[0].stack).toContain('it broke')
    expect(marker.reportAttempts).toBe(0)
  })

  it('records an undefined rejection reason with usable context', () => {
    recordFatalError('unhandledRejection', undefined)

    const marker = readMarkerFile()
    expect(marker.entries[0].message).toContain('Non-Error fatal reason')
  })

  it('appends pile-on fatals without displacing the original, capped at 5', () => {
    recordFatalError('unhandledRejection', new Error('original cause'))
    for (let i = 0; i < 10; i++) {
      recordFatalError('unhandledRejection', new Error(`pile-on ${i}`))
    }

    const marker = readMarkerFile()
    expect(marker.entries).toHaveLength(5)
    expect(marker.entries[0].message).toBe('original cause')
  })

  it('creates the data dir if missing and never throws', () => {
    process.env.SUPERAGENT_DATA_DIR = path.join(tmpDir, 'does', 'not', 'exist')
    expect(() => recordFatalError('uncaughtException', new Error('boom'))).not.toThrow()
    expect(fs.existsSync(getCrashMarkerPath())).toBe(true)
  })

  it('does not throw even when the marker path is unwritable', () => {
    // A file where the data dir should be makes mkdir/write fail.
    const blocked = path.join(tmpDir, 'blocked')
    fs.writeFileSync(blocked, '')
    process.env.SUPERAGENT_DATA_DIR = path.join(blocked, 'nested')
    expect(() => recordFatalError('uncaughtException', new Error('boom'))).not.toThrow()
  })

  it('truncates oversized messages and stacks', () => {
    const huge = new Error('x'.repeat(10_000))
    recordFatalError('uncaughtException', huge)

    const marker = readMarkerFile()
    expect(marker.entries[0].message.length).toBeLessThanOrEqual(2000)
    expect((marker.entries[0].stack ?? '').length).toBeLessThanOrEqual(8000)
  })
})

describe('reportCrashMarkerFromLastRun', () => {
  it('does nothing when no marker exists', async () => {
    await reportCrashMarkerFromLastRun()
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('reports the marker as fatal and deletes it once the flush succeeds', async () => {
    recordFatalError('unhandledRejection', new Error('the real cause'))

    await reportCrashMarkerFromLastRun()

    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('the real cause'),
      expect.objectContaining({
        level: 'fatal',
        tags: expect.objectContaining({ type: 'unhandledRejection', crashedLastSession: 'true' }),
      }),
    )
    expect(fs.existsSync(getCrashMarkerPath())).toBe(false)
  })

  it('includes all entries and the crashed version in extra data', async () => {
    recordFatalError('uncaughtException', new Error('first'))
    recordFatalError('unhandledRejection', new Error('second'))

    await reportCrashMarkerFromLastRun()

    const extra = vi.mocked(captureMessage).mock.calls[0][1]?.extra
    expect(extra?.entries).toHaveLength(2)
    expect(extra?.crashedAppVersion).toBeTruthy()
  })

  it('keeps the marker and burns an attempt when the flush fails', async () => {
    vi.mocked(flushErrorReporting).mockResolvedValue(false)
    recordFatalError('uncaughtException', new Error('boom'))

    await reportCrashMarkerFromLastRun()

    expect(captureMessage).toHaveBeenCalled()
    expect(readMarkerFile().reportAttempts).toBe(1)
  })

  it('gives up after the attempt budget is exhausted', async () => {
    recordFatalError('uncaughtException', new Error('boom'))
    const marker = readMarkerFile()
    fs.writeFileSync(getCrashMarkerPath(), JSON.stringify({ ...marker, reportAttempts: 5 }))

    await reportCrashMarkerFromLastRun()

    expect(captureMessage).not.toHaveBeenCalled()
    expect(fs.existsSync(getCrashMarkerPath())).toBe(false)
  })

  it('deletes a corrupt marker without reporting or throwing', async () => {
    fs.writeFileSync(getCrashMarkerPath(), 'not json{{')

    await expect(reportCrashMarkerFromLastRun()).resolves.toBeUndefined()

    expect(captureMessage).not.toHaveBeenCalled()
    expect(fs.existsSync(getCrashMarkerPath())).toBe(false)
  })

  it('leaves the marker untouched when error reporting is not initialized', async () => {
    vi.mocked(getErrorReporter).mockReturnValue(null as never)
    recordFatalError('uncaughtException', new Error('boom'))

    await reportCrashMarkerFromLastRun()

    expect(captureMessage).not.toHaveBeenCalled()
    expect(readMarkerFile().reportAttempts).toBe(0)
  })

  it('survives capture throwing mid-report and keeps the marker', async () => {
    // The crash vector here is deliberately independent of the code under
    // test: the reporting layer itself blows up.
    vi.mocked(captureMessage).mockImplementation(() => {
      throw new Error('reporter exploded')
    })
    recordFatalError('uncaughtException', new Error('boom'))

    await expect(reportCrashMarkerFromLastRun()).resolves.toBeUndefined()
    expect(fs.existsSync(getCrashMarkerPath())).toBe(true)
  })
})
