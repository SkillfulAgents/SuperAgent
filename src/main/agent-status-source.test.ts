import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerTasks } from '@shared/lib/background-work/testing/register-tasks'
import type { ApiTarget } from '@shared/lib/api-target'
import type { AgentInfo } from './agent-status'
import {
  AGENT_STATUS_DEBOUNCE_MS,
  AGENT_STATUS_POLL_INTERVAL_MS,
  AgentStatusSource,
  isAgentStatusEvent,
  type AgentStatusPusher,
} from './agent-status-source'

const LOCAL = 'http://localhost:4000'
// The real cloud base carries the per-boot proxy key in its path.
const CLOUD = 'http://localhost:4000/cloud/SECRET-PROXY-KEY'

interface Row {
  slug: string
  name: string
  status: 'running' | 'stopped'
  hasActiveSessions?: boolean
  hasSessionsAwaitingInput?: boolean
}

const row = (slug: string, extra: Partial<Row> = {}): Row => ({ slug, name: slug, status: 'running', ...extra })
const info = (slug: string, activityStatus: AgentInfo['activityStatus'] = 'idle'): AgentInfo => ({ slug, name: slug, activityStatus })

/** Both Superagents behind fetch, each with its own agents. */
function fakeApi() {
  const agents = new Map<string, Row[]>([[LOCAL, []], [CLOUD, []]])
  const requests: string[] = []
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    requests.push(url)
    for (const [base, list] of agents) {
      if (url === `${base}/api/agents`) return Response.json(list)
      if (url === `${base}/api/user-settings`) return Response.json({})
    }
    return new Response('{}', { status: 404 })
  })
  return {
    fetch: fetch as unknown as typeof globalThis.fetch,
    requests,
    set(base: string, list: Row[]) {
      agents.set(base, list)
    },
    listRequests(base: string) {
      return requests.filter((url) => url === `${base}/api/agents`).length
    },
  }
}

/** A window's WebContents, as far as the source looks at one. */
class FakeWindow extends EventEmitter implements AgentStatusPusher {
  destroyed = false
  isDestroyed() {
    return this.destroyed
  }
  close() {
    this.destroyed = true
    this.emit('destroyed')
  }
  reload() {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  }
}

function setup(initial: ApiTarget = 'local') {
  const api = fakeApi()
  const state = { target: initial }
  const source = new AgentStatusSource()
  source.configure({
    activeTarget: async () => ({ target: state.target, baseUrl: state.target === 'cloud' ? CLOUD : LOCAL }),
    fetch: api.fetch,
  })
  registerTasks(source)
  const tray = vi.fn<(agents: AgentInfo[]) => void>()
  const menu = vi.fn<(agents: AgentInfo[]) => void>()
  source.subscribe(tray)
  source.subscribe(menu)
  return { api, state, source, tray, menu }
}

/** Lets the fetches in flight answer and their results apply. */
const settle = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('one source for the tray and the app menu', () => {
  it('makes one fetch for both consumers, and none per agent', async () => {
    const { api, source, tray, menu } = setup()
    api.set(LOCAL, [row('a', { hasActiveSessions: true }), row('b'), row('c', { hasSessionsAwaitingInput: true })])
    source.start()
    await settle()

    expect(api.requests.sort()).toEqual([`${LOCAL}/api/agents`, `${LOCAL}/api/user-settings`])
    expect(api.requests.some((url) => url.includes('/sessions'))).toBe(false)
    const expected = [info('a', 'working'), info('b'), info('c', 'awaiting_input')]
    expect(tray.mock.calls).toEqual([[expected]])
    expect(menu.mock.calls).toEqual([[expected]])
    source.stop()
  })

  it('polls every interval with no window, and stops when stopped', async () => {
    const { api, source } = setup()
    source.start()
    source.start()
    await settle()
    expect(api.listRequests(LOCAL)).toBe(1)
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS - 1)
    expect(api.listRequests(LOCAL)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.listRequests(LOCAL)).toBe(2)
    source.stop()
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS * 3)
    expect(api.listRequests(LOCAL)).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rebuilds nothing when the list is unchanged, and both when it changes', async () => {
    const { api, source, tray, menu } = setup()
    api.set(LOCAL, [row('a'), row('b')])
    source.start()
    await settle()
    expect(tray).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS * 3)
    expect(api.listRequests(LOCAL)).toBe(4)
    expect(tray).toHaveBeenCalledTimes(1)
    expect(menu).toHaveBeenCalledTimes(1)

    // Each of the three things a menu shows is a change: activity, name, order.
    api.set(LOCAL, [row('a', { hasActiveSessions: true }), row('b')])
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS)
    expect(tray).toHaveBeenCalledTimes(2)
    api.set(LOCAL, [{ ...row('a', { hasActiveSessions: true }), name: 'Renamed' }, row('b')])
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS)
    expect(tray).toHaveBeenCalledTimes(3)
    api.set(LOCAL, [row('b'), { ...row('a', { hasActiveSessions: true }), name: 'Renamed' }])
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS)
    expect(tray).toHaveBeenCalledTimes(4)
    expect(menu).toHaveBeenCalledTimes(4)
    source.stop()
  })

  it('hands a late subscriber the current list at once', async () => {
    const { api, source } = setup()
    api.set(LOCAL, [row('a')])
    source.start()
    await settle()
    const late = vi.fn()
    const unsubscribe = source.subscribe(late)
    expect(late.mock.calls).toEqual([[[info('a')]]])

    unsubscribe()
    api.set(LOCAL, [])
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS)
    expect(late).toHaveBeenCalledTimes(1)
    source.stop()
  })

  it('lists no agents when the base URL cannot be resolved', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const api = fakeApi()
    const source = new AgentStatusSource()
    source.configure({ activeTarget: () => Promise.reject(new Error('database is locked')), fetch: api.fetch })
    registerTasks(source)
    const menu = vi.fn()
    source.subscribe(menu)
    source.start()
    await settle()
    expect(menu.mock.calls).toEqual([[[]]])
    expect(api.requests).toEqual([])
    source.stop()
    error.mockRestore()
  })
})

describe('a target switch', () => {
  it('fetches the new target at once', async () => {
    const { api, state, source, tray } = setup()
    api.set(LOCAL, [row('local-agent')])
    api.set(CLOUD, [row('cloud-agent')])
    source.start()
    await settle()

    state.target = 'cloud'
    source.targetSwitched()
    await settle()
    expect(api.listRequests(CLOUD)).toBe(1)
    expect(tray).toHaveBeenLastCalledWith([info('cloud-agent')])
    source.stop()
  })

  it('never lets an older fetch land over a newer one', async () => {
    // The base URL is sampled before the await: a poll started against the
    // previous target can answer after the switch's fetch already painted.
    const answers: Array<(list: Row[]) => void> = []
    const state = { target: 'local' as ApiTarget }
    const source = new AgentStatusSource()
    source.configure({
      activeTarget: async () => ({ target: state.target, baseUrl: state.target === 'cloud' ? CLOUD : LOCAL }),
      fetch: (async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/user-settings')) return Response.json({})
        return Response.json(await new Promise<Row[]>((resolve) => answers.push(resolve)))
      }) as typeof fetch,
    })
    registerTasks(source)
    const menu = vi.fn()
    source.subscribe(menu)
    source.start()
    await settle()
    state.target = 'cloud'
    source.targetSwitched()
    await settle()
    expect(answers).toHaveLength(2)

    answers[1]([row('cloud-agent')])
    await settle()
    expect(menu.mock.calls).toEqual([[[info('cloud-agent')]]])

    answers[0]([row('local-agent')])
    await settle()
    expect(menu).toHaveBeenCalledTimes(1)
    source.stop()
  })

  it('drops the list the previous target\'s window pushed, and refuses a late one from it', async () => {
    const { api, state, source, tray } = setup()
    api.set(CLOUD, [row('cloud-agent')])
    source.start()
    await settle()
    const window = new FakeWindow()
    expect(await source.acceptPush(window, { target: 'local', agents: [info('local-agent')] })).toBe(true)

    state.target = 'cloud'
    source.targetSwitched()
    expect(source.isPushed).toBe(false)
    await settle()
    expect(tray).toHaveBeenLastCalledWith([info('cloud-agent')])

    // The document has not reloaded yet and its list changes once more.
    expect(await source.acceptPush(window, { target: 'local', agents: [info('local-agent', 'working')] })).toBe(false)
    expect(source.isPushed).toBe(false)
    expect(tray).toHaveBeenLastCalledWith([info('cloud-agent')])

    // Reloaded onto the new target, it is taken again.
    expect(await source.acceptPush(window, { target: 'cloud', agents: [info('cloud-agent', 'working')] })).toBe(true)
    expect(tray).toHaveBeenLastCalledWith([info('cloud-agent', 'working')])
    source.stop()
  })
})

describe('a window pushing its list', () => {
  it('applies a valid list to both consumers, and skips an unchanged one', async () => {
    const { api, source, tray, menu } = setup()
    source.start()
    await settle()
    tray.mockClear()
    menu.mockClear()
    const window = new FakeWindow()
    const list = [info('a', 'working'), info('b', 'sleeping')]

    expect(await source.acceptPush(window, { target: 'local', agents: list })).toBe(true)
    expect(tray.mock.calls).toEqual([[list]])
    expect(menu.mock.calls).toEqual([[list]])

    expect(await source.acceptPush(window, { target: 'local', agents: [...list] })).toBe(true)
    expect(tray).toHaveBeenCalledTimes(1)
    expect(api.listRequests(LOCAL)).toBe(1)
    source.stop()
  })

  it('stops polling while the window pushes', async () => {
    const { api, source } = setup()
    source.start()
    await settle()
    expect(api.listRequests(LOCAL)).toBe(1)
    await source.acceptPush(new FakeWindow(), { target: 'local', agents: [info('a')] })

    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS * 5)
    expect(api.requests).toHaveLength(2)
    source.stop()
  })

  it.each([
    ['is closed', (window: FakeWindow) => window.close()],
    ['crashes', (window: FakeWindow) => window.emit('render-process-gone', {}, { reason: 'crashed' })],
    ['reloads', (window: FakeWindow) => window.reload()],
  ])('polls again, starting at once, when the window %s', async (_name, gone) => {
    const { api, source, tray } = setup()
    api.set(LOCAL, [row('from-api')])
    source.start()
    await settle()
    const window = new FakeWindow()
    await source.acceptPush(window, { target: 'local', agents: [info('from-window')] })
    expect(tray).toHaveBeenLastCalledWith([info('from-window')])

    gone(window)
    expect(source.isPushed).toBe(false)
    await settle()
    expect(api.listRequests(LOCAL)).toBe(2)
    expect(tray).toHaveBeenLastCalledWith([info('from-api')])
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS)
    expect(api.listRequests(LOCAL)).toBe(3)
    source.stop()
  })

  it('keeps the list through an in-page navigation and a frame\'s load', async () => {
    const { source } = setup()
    source.start()
    await settle()
    const window = new FakeWindow()
    await source.acceptPush(window, { target: 'local', agents: [info('a')] })
    window.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    window.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(source.isPushed).toBe(true)
    source.stop()
  })

  it('polls again when the window withdraws its list', async () => {
    const { api, source } = setup()
    source.start()
    await settle()
    const window = new FakeWindow()
    await source.acceptPush(window, { target: 'local', agents: [info('a')] })

    expect(await source.acceptPush(window, null)).toBe(false)
    expect(source.isPushed).toBe(false)
    await settle()
    expect(api.listRequests(LOCAL)).toBe(2)
    source.stop()
  })

  it.each([
    ['not an object', 'agents'],
    ['no target', { agents: [] }],
    ['an unknown target', { target: 'elsewhere', agents: [] }],
    ['an unknown activity', { target: 'local', agents: [{ slug: 'a', name: 'a', activityStatus: 'exploding' }] }],
    ['an agent with no slug', { target: 'local', agents: [{ slug: '', name: 'a', activityStatus: 'idle' }] }],
    ['a name that is not text', { target: 'local', agents: [{ slug: 'a', name: { toString: 1 }, activityStatus: 'idle' }] }],
  ])('rejects a payload with %s, and keeps polling', async (_name, payload) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api, source, tray } = setup()
    api.set(LOCAL, [row('from-api')])
    source.start()
    await settle()

    expect(await source.acceptPush(new FakeWindow(), payload)).toBe(false)
    expect(source.isPushed).toBe(false)
    expect(tray.mock.calls).toEqual([[[info('from-api')]]])
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS)
    expect(api.listRequests(LOCAL)).toBe(2)
    source.stop()
    warn.mockRestore()
  })

  it('stops trusting a window whose next payload is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { api, source } = setup()
    source.start()
    await settle()
    const window = new FakeWindow()
    await source.acceptPush(window, { target: 'local', agents: [info('a')] })

    expect(await source.acceptPush(window, { target: 'local', agents: 'none' })).toBe(false)
    expect(source.isPushed).toBe(false)
    await settle()
    expect(api.listRequests(LOCAL)).toBe(2)
    source.stop()
    warn.mockRestore()
  })

  it('drops a fetch in flight when a push lands first', async () => {
    const answers: Array<(list: Row[]) => void> = []
    const source = new AgentStatusSource()
    source.configure({
      activeTarget: async () => ({ target: 'local', baseUrl: LOCAL }),
      fetch: (async (input: string | URL | Request) => {
        if (String(input).endsWith('/api/user-settings')) return Response.json({})
        return Response.json(await new Promise<Row[]>((resolve) => answers.push(resolve)))
      }) as typeof fetch,
    })
    registerTasks(source)
    const menu = vi.fn()
    source.subscribe(menu)
    source.start()
    await settle()

    await source.acceptPush(new FakeWindow(), { target: 'local', agents: [info('from-window')] })
    answers[0]([row('from-api')])
    await settle()
    expect(menu.mock.calls).toEqual([[[info('from-window')]]])
    source.stop()
  })
})

describe('this computer\'s notification stream', () => {
  it('names the events that can move an agent\'s row', () => {
    for (const type of [
      'connected', 'session_active', 'session_idle', 'session_error', 'session_awaiting_input',
      'session_input_provided', 'agent_status_changed', 'agent_created', 'agent_updated',
    ]) {
      expect(isAgentStatusEvent(type)).toBe(true)
    }
    expect(isAgentStatusEvent('os_notification')).toBe(false)
    expect(isAgentStatusEvent('session_updated')).toBe(false)
    expect(isAgentStatusEvent(undefined)).toBe(false)
  })

  it('covers a burst of events with one fetch, the debounce after the last', async () => {
    const { api, source } = setup()
    source.start()
    await settle()
    expect(api.listRequests(LOCAL)).toBe(1)

    source.requestRefresh()
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_DEBOUNCE_MS - 1)
    source.requestRefresh()
    source.requestRefresh()
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_DEBOUNCE_MS - 1)
    expect(api.listRequests(LOCAL)).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.listRequests(LOCAL)).toBe(2)
    source.stop()
  })

  it('asks nothing while a window is pushing', async () => {
    const { api, source } = setup()
    source.start()
    await settle()
    await source.acceptPush(new FakeWindow(), { target: 'local', agents: [info('a')] })

    source.requestRefresh()
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_DEBOUNCE_MS * 2)
    expect(api.listRequests(LOCAL)).toBe(1)
    source.stop()
  })

  it('asks nothing of the cloud workspace, which the stream says nothing about', async () => {
    const { api, source } = setup('cloud')
    source.start()
    await settle()
    expect(api.listRequests(CLOUD)).toBe(1)

    source.requestRefresh()
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_DEBOUNCE_MS * 2)
    expect(api.listRequests(CLOUD)).toBe(1)
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_POLL_INTERVAL_MS)
    expect(api.listRequests(CLOUD)).toBe(2)
    source.stop()
  })

  it('forgets a request waiting on the debounce when stopped', async () => {
    const { api, source } = setup()
    source.start()
    await settle()
    source.requestRefresh()
    source.stop()
    source.requestRefresh()
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_DEBOUNCE_MS * 2)
    expect(api.listRequests(LOCAL)).toBe(1)
  })
})
