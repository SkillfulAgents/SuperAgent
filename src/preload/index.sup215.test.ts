// Regression tests for SUP-215: preload `remove*` cleanup methods called
// `ipcRenderer.removeAllListeners(channel)`, which tears down EVERY listener on
// a channel — so a single component unmounting silently killed every other
// component's still-active callback on the same channel (a real, intended
// scenario for concurrent OAuth / deep-link subscribers).
//
// The fix: each `onX` subscription registers a NAMED handler and returns a
// per-listener unsubscribe function (`() => ipcRenderer.removeListener(...)`),
// so cleanup affects only the unmounting component's listener.
//
// Environment is 'node' (see vitest.config.ts). We mock `electron` with a
// `contextBridge` that captures the exposed API and an `ipcRenderer` backed by
// a real Node EventEmitter so on/removeListener/removeAllListeners/emit
// semantics are faithful.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'

const mock = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events')
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  const holder: { api: Record<string, (...args: unknown[]) => unknown> | null } = { api: null }
  // `process.getSystemVersion` is an Electron-only addition; stub it so the
  // preload module can be evaluated under plain Node.
  ;(process as unknown as { getSystemVersion?: () => string }).getSystemVersion = () => '0.0.0'
  return { emitter, holder }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, api: Record<string, (...args: unknown[]) => unknown>) => {
      mock.holder.api = api
    },
  },
  ipcRenderer: {
    on: (channel: string, handler: (...args: unknown[]) => void) => mock.emitter.on(channel, handler),
    off: (channel: string, handler: (...args: unknown[]) => void) => mock.emitter.off(channel, handler),
    removeListener: (channel: string, handler: (...args: unknown[]) => void) =>
      mock.emitter.removeListener(channel, handler),
    removeAllListeners: (channel: string) => mock.emitter.removeAllListeners(channel),
    emit: (channel: string, ...args: unknown[]) => mock.emitter.emit(channel, ...args),
    listenerCount: (channel: string) => mock.emitter.listenerCount(channel),
    invoke: vi.fn(),
    send: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn() },
}))

// Importing the preload module runs `contextBridge.exposeInMainWorld`, which
// populates `mock.holder.api`.
import './index'

type Api = Record<string, (...args: unknown[]) => unknown>

function getApi(): Api {
  if (!mock.holder.api) throw new Error('preload API was not exposed')
  return mock.holder.api
}

// Emit with a leading mock IpcRendererEvent, mirroring how Electron dispatches.
function emit(channel: string, ...payload: unknown[]): void {
  mock.emitter.emit(channel, { sender: null }, ...payload)
}

afterEach(() => {
  mock.emitter.removeAllListeners()
})

describe('SUP-215 preload per-listener unsubscribe (oauth-callback)', () => {
  beforeAll(() => {
    expect(getApi().onOAuthCallback).toBeTypeOf('function')
  })

  it('onOAuthCallback returns a per-listener unsubscribe that leaves co-subscribers intact', () => {
    const api = getApi()
    const h1 = vi.fn()
    const h2 = vi.fn()

    // RED on main: onOAuthCallback returned undefined, so `unsub1` was not a
    // function and there was no way to remove a single listener.
    const unsub1 = api.onOAuthCallback(h1)
    api.onOAuthCallback(h2)

    expect(unsub1).toBeTypeOf('function')
    ;(unsub1 as () => void)()

    emit('oauth-callback', { toolkit: 'slack' })

    expect(h1).not.toHaveBeenCalled()
    expect(h2).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledWith({ toolkit: 'slack' })
  })

  it('unsubscribing one listener does not disturb a later subscriber on the same channel', () => {
    const api = getApi()
    const first = vi.fn()
    const second = vi.fn()

    const unsubFirst = api.onOAuthCallback(first) as () => void
    unsubFirst()
    api.onOAuthCallback(second)

    emit('oauth-callback', { toolkit: 'github' })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

// Lock the whole family: every deep-link / auth channel must return a
// per-listener unsubscribe so concurrent subscribers can be torn down
// independently.
const channels: Array<{ name: string; on: string; channel: string; payload: unknown[] }> = [
  { name: 'onOAuthCallback', on: 'onOAuthCallback', channel: 'oauth-callback', payload: [{ toolkit: 'slack' }] },
  { name: 'onMcpOAuthCallback', on: 'onMcpOAuthCallback', channel: 'mcp-oauth-callback', payload: [{ success: true }] },
  { name: 'onPlatformAuthCallback', on: 'onPlatformAuthCallback', channel: 'platform-auth-callback', payload: [{ success: true }] },
  { name: 'onNavigateToAgent', on: 'onNavigateToAgent', channel: 'navigate-to-agent', payload: ['agent-slug', 'session-id'] },
  { name: 'onOpenSettings', on: 'onOpenSettings', channel: 'open-settings', payload: [] },
  { name: 'onOpenCreateAgent', on: 'onOpenCreateAgent', channel: 'open-create-agent', payload: [] },
  { name: 'onHistoryNavigationCommand', on: 'onHistoryNavigationCommand', channel: 'history-navigation-command', payload: ['back'] },
  // Window-state channels: these had the most concurrent subscribers (useFullScreen
  // is mounted in ~5 places; window-maximized-change is shared by WindowControls +
  // useInsetRadius), so they must honor per-listener unsubscribe too.
  { name: 'onFullScreenChange', on: 'onFullScreenChange', channel: 'fullscreen-change', payload: [true] },
  { name: 'onWindowMaximizedChange', on: 'onWindowMaximizedChange', channel: 'window-maximized-change', payload: [true] },
]

describe.each(channels)('SUP-215 per-listener unsubscribe family — $name', ({ on, channel, payload }) => {
  it('returns an unsubscribe that removes only the unsubscribed listener', () => {
    const api = getApi()
    const subscribe = api[on] as (cb: (...args: unknown[]) => void) => unknown
    const h1 = vi.fn()
    const h2 = vi.fn()

    const unsub1 = subscribe(h1)
    subscribe(h2)

    expect(unsub1).toBeTypeOf('function')
    ;(unsub1 as () => void)()

    emit(channel, ...payload)

    expect(h1).not.toHaveBeenCalled()
    expect(h2).toHaveBeenCalledTimes(1)
  })
})
