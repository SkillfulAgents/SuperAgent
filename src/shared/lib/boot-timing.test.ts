import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('boot-timing', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs a grep-friendly boot_timing line with mark keys', async () => {
    const { markBoot, logBootTiming } = await import('./boot-timing')

    markBoot('modulesLoaded')
    markBoot('bound')
    markBoot('settingsRead')
    markBoot('dbReady')
    logBootTiming()

    expect(console.log).toHaveBeenCalledTimes(1)
    const line = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    expect(line.startsWith('boot_timing ')).toBe(true)
    const payload = JSON.parse(line.slice('boot_timing '.length)) as Record<string, unknown>

    expect(typeof payload.processStart).toBe('string')
    expect(payload.processStart).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(typeof payload.modulesLoaded).toBe('number')
    expect(typeof payload.settingsRead).toBe('number')
    expect(typeof payload.dbReady).toBe('number')
    expect(typeof payload.bound).toBe('number')
    expect(typeof payload.totalMs).toBe('number')
    // totalMs is "ready" (log time); bound is listen — ready is not before bound.
    expect(payload.totalMs as number).toBeGreaterThanOrEqual(payload.bound as number)
  })

  it('keeps missing marks null and is idempotent', async () => {
    const { markBoot, logBootTiming } = await import('./boot-timing')

    markBoot('modulesLoaded')
    markBoot('modulesLoaded')
    markBoot('bound')
    logBootTiming()

    const line = (console.log as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string
    const payload = JSON.parse(line.slice('boot_timing '.length)) as Record<string, unknown>

    expect(payload.settingsRead).toBeNull()
    expect(payload.dbReady).toBeNull()
    expect(typeof payload.modulesLoaded).toBe('number')
    expect(typeof payload.bound).toBe('number')
    expect(payload.totalMs as number).toBeGreaterThanOrEqual(payload.bound as number)
  })
})
