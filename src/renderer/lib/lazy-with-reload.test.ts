import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RELOADING_EVENT, reloadOnMissingFile, shouldReload } from './lazy-with-reload'

const missing = new Error('Failed to fetch dynamically imported module: https://acme.ongamut.so/assets/pdf-renderer-DXrySxul.js')

describe('shouldReload', () => {
  it.each([
    missing.message,
    'error loading dynamically imported module: https://acme.ongamut.so/assets/pdf-renderer-DXrySxul.js',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/pdf-renderer-Dbl8kTil.css',
  ])('reloads when a file is missing: %s', (message) => {
    expect(shouldReload(new Error(message), true, null, '0.5.48')).toBe(true)
  })

  it('does not reload for a module that loaded and then threw', () => {
    expect(shouldReload(new TypeError("Cannot read properties of undefined (reading 'PdfRenderer')"), true, null, '0.5.48')).toBe(false)
  })

  it('does not reload for a rejection that is not an Error', () => {
    expect(shouldReload(missing.message, true, null, '0.5.48')).toBe(false)
  })

  it('does not reload while offline', () => {
    expect(shouldReload(missing, false, null, '0.5.48')).toBe(false)
  })

  it('reloads at most once per build', () => {
    expect(shouldReload(missing, true, '0.5.48', '0.5.48')).toBe(false)
    expect(shouldReload(missing, true, '0.5.44', '0.5.48')).toBe(true)
  })
})

describe('reloadOnMissingFile', () => {
  const reload = vi.fn()
  const dispatchEvent = vi.fn()

  beforeEach(() => {
    const stored = new Map<string, string>()
    vi.stubGlobal('navigator', { onLine: true })
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) })
    vi.stubGlobal('window', { location: { reload }, dispatchEvent })
    reload.mockClear()
    dispatchEvent.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reloads once, then lets the same failure through instead of looping', () => {
    void reloadOnMissingFile(missing)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: RELOADING_EVENT }))
    expect(dispatchEvent.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0])

    expect(() => reloadOnMissingFile(missing)).toThrow(missing)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('lets the failure through without reloading while offline', () => {
    vi.stubGlobal('navigator', { onLine: false })
    expect(() => reloadOnMissingFile(missing)).toThrow(missing)
    expect(reload).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('rethrows any other failure without reloading', () => {
    const crash = new TypeError('boom')
    expect(() => reloadOnMissingFile(crash)).toThrow(crash)
    expect(reload).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})
