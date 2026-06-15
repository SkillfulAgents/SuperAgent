import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock the history factories to return distinguishable sentinels, and isElectron
// so we control the runtime side of the tripwire. `__WEB__` is NOT in
// vitest.config.ts's `define`, so it stays a real global here and `vi.stubGlobal`
// can flip it per case (a baked compile-time literal could not be flipped).
vi.mock('@tanstack/react-router', () => ({
  createBrowserHistory: vi.fn(() => ({ tag: 'browser' })),
  createHashHistory: vi.fn(() => ({ tag: 'hash' })),
}))
vi.mock('@renderer/lib/env', () => ({ isElectron: vi.fn() }))

import { isElectron } from '@renderer/lib/env'

const mockedIsElectron = vi.mocked(isElectron)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function loadCreateAppHistory(web: boolean, electron: boolean) {
  vi.stubGlobal('__WEB__', web)
  mockedIsElectron.mockReturnValue(electron)
  vi.resetModules()
  return (await import('./history')).createAppHistory
}

describe('createAppHistory', () => {
  it('web target (__WEB__=true, not electron) → browser history', async () => {
    const createAppHistory = await loadCreateAppHistory(true, false)
    expect(createAppHistory()).toEqual({ tag: 'browser' })
  })

  it('electron target (__WEB__=false, electron) → hash history', async () => {
    const createAppHistory = await loadCreateAppHistory(false, true)
    expect(createAppHistory()).toEqual({ tag: 'hash' })
  })

  it('build-define drift (__WEB__=true but running in electron) trips the tripwire', async () => {
    const createAppHistory = await loadCreateAppHistory(true, true)
    expect(() => createAppHistory()).toThrow(/drift/)
  })

  it('build-define drift (__WEB__=false but running on web) trips the tripwire', async () => {
    const createAppHistory = await loadCreateAppHistory(false, false)
    expect(() => createAppHistory()).toThrow(/drift/)
  })
})
