import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetApiTargetForTest,
  getActiveTarget,
  getTargetFallbackReason,
  setActiveTarget,
  targetIsRemote,
  switchTarget,
  switchToLocalTarget,
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

describe('switching target', () => {
  // Switching is a reload, and it must not reload *in place*: agent ids are
  // per-deployment, so the route you are standing on almost certainly does not
  // exist on the other side. Electron uses hash history (the route is the
  // fragment, the document must stay pinned to index.html); web uses path
  // history, where '/' is the document.
  const assign = vi.fn()
  const reload = vi.fn()

  function stubLocation(initialHash: string) {
    const location = { assign, reload, hash: initialHash }
    vi.stubGlobal('window', {
      location,
      electronAPI: { setPreferredApiTarget: vi.fn().mockResolvedValue(undefined) },
    })
    return location
  }

  beforeEach(() => {
    assign.mockClear()
    reload.mockClear()
  })

  it('sends an Electron window back to the root route, not the current one', async () => {
    vi.stubGlobal('__WEB__', false)
    const location = stubLocation('#/agents/cloud-only-agent')

    await switchTarget('local')

    expect(location.hash).toBe('#/')
    expect(reload).toHaveBeenCalled()
    expect(assign).not.toHaveBeenCalled()
  })

  it('navigates a web window to the root path', async () => {
    vi.stubGlobal('__WEB__', true)
    stubLocation('')

    await switchTarget('cloud')

    expect(assign).toHaveBeenCalledWith('/')
    expect(reload).not.toHaveBeenCalled()
  })

  it('records the preference before reloading', async () => {
    vi.stubGlobal('__WEB__', false)
    stubLocation('#/')
    const setPreferredApiTarget = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      location: { assign, reload, hash: '#/' },
      electronAPI: { setPreferredApiTarget },
    })

    await switchTarget('cloud')

    expect(setPreferredApiTarget).toHaveBeenCalledWith('cloud')
  })

  it('switchToLocalTarget is just the local case', async () => {
    vi.stubGlobal('__WEB__', false)
    const setPreferredApiTarget = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      location: { assign, reload, hash: '#/agents/x' },
      electronAPI: { setPreferredApiTarget },
    })

    await switchToLocalTarget()

    expect(setPreferredApiTarget).toHaveBeenCalledWith('local')
  })

  it('raises the switch overlay before reloading, not after', async () => {
    // Order is the whole feature: the band exists to cover the reload, so one
    // raised afterwards is a band over the blank it was meant to hide.
    vi.stubGlobal('__WEB__', false)
    const order: string[] = []
    vi.stubGlobal('window', {
      location: { assign, reload: () => order.push('reload'), hash: '#/' },
      electronAPI: {
        setPreferredApiTarget: vi.fn().mockResolvedValue(undefined),
        beginTargetSwitch: vi.fn(async () => {
          order.push('overlay')
        }),
      },
    })

    await switchTarget('cloud')

    expect(order).toEqual(['overlay', 'reload'])
  })

  it('still switches in a window with no overlay to raise', async () => {
    // Web has no main process, and an older main has no handler for it.
    vi.stubGlobal('__WEB__', true)
    stubLocation('')

    await switchTarget('cloud')

    expect(assign).toHaveBeenCalledWith('/')
  })
})
