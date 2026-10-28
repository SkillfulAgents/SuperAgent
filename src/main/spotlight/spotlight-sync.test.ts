import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiTarget } from '@shared/lib/api-target'
import type { SpotlightChanges, SpotlightIndex } from './spotlight-bridge'
import { itemsForTarget, parseSpotlightId, workspaceItems } from './spotlight-items'
import { FIRST_PASS_DELAY_MS, SESSIONS_MAX_AGE_MS, SESSIONS_PER_AGENT, SpotlightSync } from './spotlight-sync'

const LOCAL = 'http://localhost:4000'
// The real cloud base carries the per-boot proxy key in its path.
const CLOUD = 'http://localhost:4000/cloud/SECRET-PROXY-KEY'

interface Agent {
  slug: string
  name: string
  lastActivityAt?: string
  sessionCount?: number
  dashboards?: { slug: string; name: string }[]
}

interface Session {
  id: string
  name: string
  lastActivityAt?: string
}

/** A body to answer with, or the HTTP status to fail with. */
type Answer<T> = T[] | number

/** A pair of Superagents behind fetch: agents and their sessions, per base URL. */
function fakeServers() {
  const agents = new Map<string, Answer<unknown>>()
  const sessions = new Map<string, Answer<Session>>()
  const requests: string[] = []
  const sessionsUrl = (base: string, slug: string) =>
    `${base}/api/agents/${encodeURIComponent(slug)}/sessions?sort_by=last_activity_at&limit=${SESSIONS_PER_AGENT}`

  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    const body = url.endsWith('/api/agents') ? agents.get(url.slice(0, -'/api/agents'.length)) : sessions.get(url)
    if (body === undefined) return new Response('{}', { status: 404 })
    if (typeof body === 'number') return new Response('{}', { status: body })
    return Response.json(body)
  })

  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    setAgents(base: string, list: Answer<unknown>) {
      agents.set(base, list)
    },
    setSessions(base: string, slug: string, list: Answer<Session>) {
      sessions.set(sessionsUrl(base, slug), list)
    },
    agentRequests(base: string) {
      return requests.filter((url) => url === `${base}/api/agents`).length
    },
    sessionRequests(base: string, slug: string) {
      return requests.filter((url) => url === sessionsUrl(base, slug)).length
    },
  }
}

function fakeIndex() {
  const applied: SpotlightChanges[] = []
  let failNext = false
  const index: SpotlightIndex = {
    async apply(changes) {
      if (failNext) {
        failNext = false
        throw new Error('Spotlight said no')
      }
      applied.push(changes)
    },
  }
  return {
    index,
    applied,
    failNextApply() {
      failNext = true
    },
  }
}

const finance: Agent = {
  slug: 'finance',
  name: 'Finance',
  lastActivityAt: '2026-10-20T10:00:00.000Z',
  sessionCount: 1,
  dashboards: [{ slug: 'revenue', name: 'Revenue' }],
}
const research: Agent = { slug: 'research', name: 'Research', lastActivityAt: '2026-10-18T10:00:00.000Z', sessionCount: 0 }
const q3: Session = { id: 's1', name: 'Q3 reconciliation', lastActivityAt: '2026-10-20T10:00:00.000Z' }

function setup(options: { cloud?: boolean; active?: ApiTarget } = {}) {
  const servers = fakeServers()
  const { index, applied, failNextApply } = fakeIndex()
  const bases: Record<ApiTarget, string | null> = { local: LOCAL, cloud: options.cloud === false ? null : CLOUD }
  const state = { active: options.active ?? 'cloud' }
  let now = Date.parse('2026-10-20T12:00:00.000Z')

  servers.setAgents(LOCAL, [finance])
  servers.setSessions(LOCAL, 'finance', [q3])
  servers.setAgents(CLOUD, [research])
  servers.setSessions(CLOUD, 'research', [])

  const sync = new SpotlightSync({
    index,
    baseUrl: (target) => bases[target],
    activeTarget: () => state.active,
    fetch: servers.fetch,
    now: () => now,
  })
  return {
    sync,
    servers,
    applied,
    failNextApply,
    bases,
    state,
    advance(ms: number) {
      now += ms
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SpotlightSync', () => {
  it('replaces each domain whole on its first pass', async () => {
    const { sync, applied } = setup()
    await sync.sync()

    expect(applied).toEqual([
      { deleteDomains: ['local'], index: itemsForTarget('local', [finance], new Map([['finance', [q3]]])) },
      { deleteDomains: ['cloud'], index: itemsForTarget('cloud', [research], new Map([['research', []]])) },
      { deleteDomains: ['workspace'], index: workspaceItems() },
    ])
  })

  it('sends nothing on a pass where nothing changed, and only the difference after a change', async () => {
    const { sync, servers, applied } = setup()
    await sync.sync()
    await sync.sync()
    expect(applied).toHaveLength(3)

    const renamed = { ...q3, name: 'Q3 close', lastActivityAt: '2026-10-20T11:00:00.000Z' }
    servers.setAgents(LOCAL, [{ ...finance, lastActivityAt: renamed.lastActivityAt, dashboards: [] }])
    servers.setSessions(LOCAL, 'finance', [renamed])
    await sync.sync()

    expect(applied).toHaveLength(4)
    const change = applied[3]
    expect(change.deleteIds?.map(parseSpotlightId)).toEqual([
      { kind: 'dashboard', target: 'local', agentSlug: 'finance', dashboardSlug: 'revenue' },
    ])
    expect(change.index?.map((item) => item.title)).toEqual(['Finance', 'Q3 close'])
  })

  it('re-lists an agent’s sessions only when its activity moves, or the list is an hour old', async () => {
    const { sync, servers, advance } = setup()
    await sync.sync()
    await sync.sync()
    expect(servers.sessionRequests(LOCAL, 'finance')).toBe(1)

    servers.setAgents(LOCAL, [{ ...finance, sessionCount: 2 }])
    await sync.sync()
    expect(servers.sessionRequests(LOCAL, 'finance')).toBe(2)

    advance(SESSIONS_MAX_AGE_MS + 1)
    await sync.sync()
    expect(servers.sessionRequests(LOCAL, 'finance')).toBe(3)
  })

  it('reads the cloud side once while the app is on this computer, and again after each switch', async () => {
    const { sync, servers, state } = setup({ active: 'local' })
    await sync.sync()
    await sync.sync()
    expect(servers.agentRequests(LOCAL)).toBe(2)
    expect(servers.agentRequests(CLOUD)).toBe(1)

    state.active = 'cloud'
    await sync.sync()
    await sync.sync()
    expect(servers.agentRequests(CLOUD)).toBe(3)

    state.active = 'local'
    await sync.sync()
    await sync.sync()
    expect(servers.agentRequests(CLOUD)).toBe(4)
  })

  it('tries an idle cloud side again until it has answered once', async () => {
    const { sync, servers } = setup({ active: 'local' })
    servers.setAgents(CLOUD, 503)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sync.sync()
    servers.setAgents(CLOUD, [research])
    await sync.sync()
    await sync.sync()

    expect(servers.agentRequests(CLOUD)).toBe(2)
  })

  it('leaves a Superagent’s entries alone while it cannot be reached', async () => {
    const { sync, servers, applied } = setup()
    await sync.sync()

    servers.setAgents(CLOUD, 503)
    servers.setAgents(LOCAL, [finance, research])
    servers.setSessions(LOCAL, 'research', [])
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sync.sync()

    expect(applied).toHaveLength(4)
    expect(applied[3].deleteIds).toEqual([])
    expect(applied[3].index?.every((item) => item.domain === 'local')).toBe(true)
  })

  it('still offers the switch-to results when the workspace exists but did not answer', async () => {
    const { sync, servers, applied } = setup()
    servers.setAgents(CLOUD, 503)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sync.sync()

    expect(applied.map((change) => change.deleteDomains)).toEqual([['local'], ['workspace']])
  })

  it.each([401, 403])('removes the cloud entries when the workspace refuses us (%i)', async (status) => {
    const { sync, servers, applied } = setup()
    await sync.sync()

    servers.setAgents(CLOUD, status)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sync.sync()

    expect(applied.slice(3)).toEqual([{ deleteDomains: ['cloud'] }, { deleteDomains: ['workspace'] }])
  })

  it('clears the cloud entries once, when the workspace is disconnected', async () => {
    const { sync, applied, bases } = setup()
    await sync.sync()

    bases.cloud = null
    await sync.sync()
    await sync.sync()

    expect(applied.slice(3)).toEqual([{ deleteDomains: ['cloud'] }, { deleteDomains: ['workspace'] }])
  })

  it('clears what a previous run may have left when there is no workspace at launch', async () => {
    const { sync, applied } = setup({ cloud: false })
    await sync.sync()

    expect(applied.map((change) => change.deleteDomains)).toEqual([['local'], ['cloud'], ['workspace']])
    expect(applied[1].index).toBeUndefined()
  })

  it('drops a malformed agent or session rather than the whole side', async () => {
    const { sync, servers, applied } = setup()
    servers.setAgents(LOCAL, [finance, { slug: '', name: null }, { name: 'No slug' }])
    servers.setSessions(LOCAL, 'finance', [q3, { id: '', name: 'No id' } as Session])
    await sync.sync()

    expect(applied[0].index?.map((item) => item.title)).toEqual(['Finance', 'Revenue', 'Q3 reconciliation'])
  })

  it('replaces a domain whole after a write fails', async () => {
    const { sync, servers, applied, failNextApply } = setup()
    await sync.sync()

    servers.setSessions(LOCAL, 'finance', [{ ...q3, name: 'Renamed' }])
    servers.setAgents(LOCAL, [{ ...finance, sessionCount: 2 }])
    failNextApply()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sync.sync()
    await sync.sync()

    const last = applied.at(-1)
    expect(last?.deleteDomains).toEqual(['local'])
    expect(last?.index?.map((item) => item.title)).toEqual(['Finance', 'Revenue', 'Renamed'])
  })

  it('keeps an agent’s sessions when only its session list fails', async () => {
    const { sync, servers, applied } = setup()
    await sync.sync()

    servers.setAgents(LOCAL, [{ ...finance, sessionCount: 2 }])
    servers.setSessions(LOCAL, 'finance', 500)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sync.sync()

    expect(applied).toHaveLength(3)
  })

  it('never logs the cloud base URL, which carries the proxy key', async () => {
    const { sync, servers } = setup()
    servers.setAgents(CLOUD, 503)
    servers.setSessions(LOCAL, 'finance', 500)
    servers.setAgents(LOCAL, [{ ...finance, sessionCount: 9 }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await sync.sync()
    servers.setAgents(CLOUD, 401)
    await sync.sync()

    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-PROXY-KEY')
  })

  it('folds a pass requested mid-pass into one follow-up', async () => {
    const { sync, servers } = setup()
    await Promise.all([sync.sync(), sync.sync(), sync.sync()])

    expect(servers.agentRequests(LOCAL)).toBe(2)
  })

  it('waits out the window’s boot before its first pass', async () => {
    vi.useFakeTimers()
    const { sync, servers } = setup()
    sync.start()
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS - 1)
    expect(servers.requests).toEqual([])

    await vi.advanceTimersByTimeAsync(1)
    expect(servers.agentRequests(LOCAL)).toBe(1)
    sync.stop()
  })
})
