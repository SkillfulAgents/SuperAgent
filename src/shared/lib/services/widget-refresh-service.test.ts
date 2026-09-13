import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ApiAgentWidget } from '@shared/lib/widgets/widget-schema'

const mocks = vi.hoisted(() => ({
  listWidgets: vi.fn<() => Promise<ApiAgentWidget[]>>(),
  cachedStatus: 'running' as 'running' | 'stopped',
  ensureRunning: vi.fn(),
  clientFetch: vi.fn(),
  broadcastGlobal: vi.fn(),
  globalListener: null as ((event: unknown) => void) | null,
  openRepair: vi.fn(async () => ({ started: false, reason: 'cooldown' })),
}))

vi.mock('./widget-service', () => ({
  listWidgetsFromFilesystem: (...args: unknown[]) => (mocks.listWidgets as any)(...args),
}))
vi.mock('./widget-repair-service', () => ({
  openWidgetRepairSession: (...args: unknown[]) => (mocks.openRepair as any)(...args),
}))
vi.mock('@shared/lib/container/container-host', async () => {
  const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
  return {
    containerHost: hostFromManagerMock({
      getCachedInfo: () => ({ status: mocks.cachedStatus }),
      ensureRunning: (...args: unknown[]) => mocks.ensureRunning(...args),
      getClient: () => ({ fetch: mocks.clientFetch }),
    }),
  }
})
vi.mock('@shared/lib/container/message-persister', () => ({
  messagePersister: {
    broadcastGlobal: (...args: unknown[]) => mocks.broadcastGlobal(...args),
    addGlobalNotificationClient: (cb: (event: unknown) => void) => {
      mocks.globalListener = cb
      return () => {
        mocks.globalListener = null
      }
    },
  },
}))

const { widgetRefreshService } = await import('./widget-refresh-service')

const AGENT = 'agent-1'

function widget(overrides: Partial<ApiAgentWidget> = {}): ApiAgentWidget {
  return {
    slug: 'macros',
    name: 'Macros',
    description: '',
    size: 'small',
    hasDashboard: false,
    hasScript: true,
    hasHtml: true,
    htmlHash: 'abc',
    refreshOnTurnEnd: false,
    generatedAt: null,
    validUntil: null,
    lastError: null,
    isStale: true,
    refreshing: false,
    ...overrides,
  }
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-09-07T12:00:00Z',
    validUntil: '2026-09-07T13:00:00Z',
    validityDefaulted: false,
    htmlHash: 'def',
    renderedSizes: [],
    scriptRan: true,
    durationMs: 12,
    lastError: null,
    ...overrides,
  }
}

function okResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('widgetRefreshService', () => {
  beforeEach(() => {
    widgetRefreshService.resetForTests()
    mocks.listWidgets.mockReset()
    mocks.ensureRunning.mockReset()
    mocks.clientFetch.mockReset()
    mocks.broadcastGlobal.mockReset()
    mocks.openRepair.mockClear()
    mocks.cachedStatus = 'running'
    mocks.ensureRunning.mockResolvedValue({ fetch: mocks.clientFetch })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('refreshWidget: wakes the container, posts to it, and broadcasts start + ready', async () => {
    mocks.clientFetch.mockResolvedValue(okResponse(snapshot()))

    const outcome = await widgetRefreshService.refreshWidget(AGENT, 'macros', { wake: true, reason: 'manual' })

    expect(outcome).toEqual({ ok: true, snapshot: snapshot() })
    expect(mocks.ensureRunning).toHaveBeenCalledWith(AGENT)
    expect(mocks.clientFetch).toHaveBeenCalledWith(
      '/artifacts/macros/widget/refresh',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(mocks.broadcastGlobal.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual([
      'widget_refresh_started',
      'widget_snapshot_ready',
    ])
    expect(mocks.broadcastGlobal.mock.calls[1][0]).toMatchObject({
      agentSlug: AGENT,
      widgetSlug: 'macros',
      htmlHash: 'def',
      error: null,
    })
  })

  it('refreshWidget with wake:false skips a sleeping container without touching it', async () => {
    mocks.cachedStatus = 'stopped'
    const outcome = await widgetRefreshService.refreshWidget(AGENT, 'macros', { wake: false, reason: 'after-run' })
    expect(outcome).toEqual({ ok: false, error: 'Agent is not running', skipped: true })
    expect(mocks.ensureRunning).not.toHaveBeenCalled()
    expect(mocks.clientFetch).not.toHaveBeenCalled()
    expect(mocks.broadcastGlobal).not.toHaveBeenCalled()
  })

  it('refreshWidget reports a container failure and broadcasts widget_refresh_failed', async () => {
    mocks.clientFetch.mockResolvedValue(okResponse({ error: 'script exploded' }, 500))
    const outcome = await widgetRefreshService.refreshWidget(AGENT, 'macros', { wake: true, reason: 'manual' })
    expect(outcome).toEqual({ ok: false, error: 'script exploded' })
    expect(mocks.broadcastGlobal.mock.calls.at(-1)?.[0]).toMatchObject({
      type: 'widget_refresh_failed',
      widgetSlug: 'macros',
      error: 'script exploded',
    })
    // The container never answered — the platform's problem, not the agent's.
    expect(mocks.openRepair).not.toHaveBeenCalled()
  })

  it('a failed script asks the agent to fix it; a clean run does not', async () => {
    mocks.clientFetch.mockResolvedValue(okResponse(snapshot({ lastError: 'Refresh script failed (exit code 1): boom' })))
    await widgetRefreshService.refreshWidget(AGENT, 'macros', { wake: false, reason: 'after-run' })
    expect(mocks.openRepair).toHaveBeenCalledWith(AGENT, 'macros', 'Refresh script failed (exit code 1): boom')

    mocks.openRepair.mockClear()
    mocks.clientFetch.mockResolvedValue(okResponse(snapshot()))
    await widgetRefreshService.refreshWidget(AGENT, 'other', { wake: false, reason: 'after-run' })
    expect(mocks.openRepair).not.toHaveBeenCalled()
  })

  it('refreshWidget is single-flight per widget', async () => {
    let resolveFetch: (r: Response) => void = () => {}
    mocks.clientFetch.mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve }))

    const a = widgetRefreshService.refreshWidget(AGENT, 'macros', { wake: true, reason: 'stale' })
    const b = widgetRefreshService.refreshWidget(AGENT, 'macros', { wake: true, reason: 'manual' })
    expect(a).toBe(b)
    expect(widgetRefreshService.isRefreshing(AGENT, 'macros')).toBe(true)
    expect(widgetRefreshService.refreshingSlugs(AGENT)).toEqual(['macros'])

    resolveFetch(okResponse(snapshot()))
    await a
    await flush()
    expect(mocks.clientFetch).toHaveBeenCalledTimes(1)
    expect(widgetRefreshService.isRefreshing(AGENT, 'macros')).toBe(false)
  })

  it('refreshStale starts only stale widgets and throttles repeat sweeps', async () => {
    mocks.listWidgets.mockResolvedValue([
      widget({ slug: 'stale-one', isStale: true }),
      widget({ slug: 'fresh', isStale: false }),
    ])
    let resolveFetch: (r: Response) => void = () => {}
    mocks.clientFetch.mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve }))

    const first = await widgetRefreshService.refreshStale(AGENT, { wake: true })
    expect(first.refreshing).toEqual(['stale-one'])
    await flush()
    expect(mocks.clientFetch).toHaveBeenCalledTimes(1)

    // A second mount moments later reports what is in flight but starts nothing new.
    mocks.listWidgets.mockResolvedValue([widget({ slug: 'another', isStale: true })])
    const second = await widgetRefreshService.refreshStale(AGENT, { wake: true })
    expect(second.refreshing).toEqual(['stale-one'])
    expect(mocks.listWidgets).toHaveBeenCalledTimes(1)

    resolveFetch(okResponse(snapshot()))
    await flush()
  })

  it('after a session settles, stale and opted-in widgets re-run without waking the container', async () => {
    vi.useFakeTimers()
    widgetRefreshService.start()
    expect(mocks.globalListener).not.toBeNull()
    mocks.listWidgets.mockResolvedValue([
      // Fresh and not opted in: the script said how long it stays true.
      widget({ slug: 'scripted-fresh', hasScript: true, isStale: false }),
      widget({ slug: 'scripted-expired', hasScript: true, isStale: true }),
      widget({ slug: 'every-turn', hasScript: true, isStale: false, refreshOnTurnEnd: true }),
      widget({ slug: 'static-fresh', hasScript: false, isStale: false }),
      widget({ slug: 'static-rewritten', hasScript: false, isStale: true }),
    ])
    // A fresh Response per call: one body cannot be read twice.
    mocks.clientFetch.mockImplementation(async () => okResponse(snapshot()))

    mocks.globalListener!({ type: 'session_idle', agentSlug: AGENT, sessionId: 's1', isActive: false })
    mocks.globalListener!({ type: 'session_idle', agentSlug: AGENT, sessionId: 's2', isActive: false })
    mocks.globalListener!({ type: 'session_complete', agentSlug: AGENT })
    await vi.advanceTimersByTimeAsync(3_500)

    const posted = mocks.clientFetch.mock.calls.map((c) => c[0]).sort()
    expect(posted).toEqual([
      '/artifacts/every-turn/widget/refresh',
      '/artifacts/scripted-expired/widget/refresh',
      '/artifacts/static-rewritten/widget/refresh',
    ])
    expect(mocks.ensureRunning).not.toHaveBeenCalled()
  })

  it('the after-run sweep does nothing when the container has gone to sleep', async () => {
    mocks.cachedStatus = 'stopped'
    mocks.listWidgets.mockResolvedValue([widget({ slug: 'scripted', hasScript: true })])
    expect(await widgetRefreshService.runPostRun(AGENT)).toEqual([])
    expect(mocks.listWidgets).not.toHaveBeenCalled()
  })

  it('the after-run sweep leaves an opted-in widget alone that was refreshed a moment ago', async () => {
    mocks.clientFetch.mockResolvedValue(okResponse(snapshot()))
    await widgetRefreshService.refreshWidget(AGENT, 'every-turn', { wake: true, reason: 'manual' })
    await flush()
    mocks.clientFetch.mockClear()

    mocks.listWidgets.mockResolvedValue([
      widget({ slug: 'every-turn', hasScript: true, isStale: false, refreshOnTurnEnd: true }),
    ])
    expect(await widgetRefreshService.runPostRun(AGENT)).toEqual([])
    expect(mocks.clientFetch).not.toHaveBeenCalled()
  })
})
