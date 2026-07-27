import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetApiTargetForTest,
  getActiveTarget,
  getTargetFallbackReason,
  setActiveTarget,
  targetIsRemote,
  writePreferredTarget,
} from './api-target'

beforeEach(() => {
  _resetApiTargetForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
  _resetApiTargetForTest()
})

describe('active target', () => {
  it('throws rather than guessing before boot has settled it', () => {
    // 'local' would be a plausible wrong answer, and the way that fails is
    // cloud traffic quietly hitting the laptop.
    expect(() => getActiveTarget()).toThrow(/before initApiBaseUrl/)
    expect(() => targetIsRemote()).toThrow(/before initApiBaseUrl/)
  })

  it('reports the settled target', () => {
    setActiveTarget('cloud', null)
    expect(getActiveTarget()).toBe('cloud')
    expect(targetIsRemote()).toBe(true)
  })

  it('reports local as not remote', () => {
    setActiveTarget('local', null)
    expect(targetIsRemote()).toBe(false)
  })

  it('carries the reason a cloud preference was denied', () => {
    setActiveTarget('local', 'no-workspace')
    expect(getTargetFallbackReason()).toBe('no-workspace')
  })

  it('has no fallback reason before anything is denied', () => {
    expect(getTargetFallbackReason()).toBeNull()
  })
})

describe('writePreferredTarget', () => {
  it('hands the choice to main rather than storing it in this renderer', async () => {
    // Renderer-local storage would let the main window and the quick-dispatch
    // launcher disagree about which machine executes work.
    const setPreferredApiTarget = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { electronAPI: { setPreferredApiTarget } })

    await writePreferredTarget('cloud')

    expect(setPreferredApiTarget).toHaveBeenCalledWith('cloud')
  })

  it('does not change the live target, which is frozen until reload', async () => {
    setActiveTarget('local', null)
    vi.stubGlobal('window', {
      electronAPI: { setPreferredApiTarget: vi.fn().mockResolvedValue(undefined) },
    })

    await writePreferredTarget('cloud')

    expect(getActiveTarget()).toBe('local')
  })

  it('survives a main process too old to record a preference', async () => {
    vi.stubGlobal('window', { electronAPI: {} })
    await expect(writePreferredTarget('cloud')).resolves.toBeUndefined()
  })
})
