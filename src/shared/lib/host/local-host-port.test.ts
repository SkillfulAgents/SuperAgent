import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  publish: vi.fn(),
  afterSessionSettled: vi.fn(),
}))

// The feed only hints to clients; here it reaches no one, so whatever the
// host does next cannot have come through it.
vi.mock('@shared/lib/notifications/global-feed', () => ({ globalFeed: { publish: mocks.publish } }))
vi.mock('@shared/lib/services/widget-refresh-service', () => ({
  widgetRefreshService: { afterSessionSettled: mocks.afterSessionSettled },
}))
vi.mock('@shared/lib/notifications/notification-manager', () => ({ notificationManager: {} }))
vi.mock('@shared/lib/analytics/server-analytics', () => ({ trackServerEvent: vi.fn() }))

import { localHostPort } from './local-host-port'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the local host port: an actor\'s feed events', () => {
  it('hands the event to the feed before send returns', () => {
    const event = { type: 'session_active', agentSlug: 'a', sessionId: 's', isActive: true }

    localHostPort.send('global', event)

    expect(mocks.publish).toHaveBeenCalledWith(event)
  })

  it('runs the after-run widget sweep itself when a session settles', async () => {
    localHostPort.send('global', { type: 'session_idle', agentSlug: 'a', sessionId: 's', isActive: false })

    await vi.waitFor(() => expect(mocks.afterSessionSettled).toHaveBeenCalledWith('a'))
  })

  it('publishes agent-wide requests as feed hints only', async () => {
    const event = { type: 'user_request_created', agentSlug: 'a', request: { id: 'r', kind: 'proxy_review', scope: { agentSlug: 'a' } } }

    localHostPort.send('global', event)

    await settle()
    expect(mocks.publish).toHaveBeenCalledWith(event)
    expect(mocks.afterSessionSettled).not.toHaveBeenCalled()
  })

  it('does no host work for an event that is only a hint', async () => {
    for (const type of ['session_active', 'session_error', 'user_request_resolved', 'session_updated']) {
      localHostPort.send('global', { type, agentSlug: 'a', sessionId: 's' })
    }
    await settle()
    await settle()

    expect(mocks.publish).toHaveBeenCalledTimes(4)
    expect(mocks.afterSessionSettled).not.toHaveBeenCalled()
  })
})

describe('the local host port: computer use under the mock E2E runtime', () => {
  beforeEach(() => {
    vi.stubEnv('E2E_MOCK', 'true')
  })

  it('places a call by the app its command line names, as the machine would', async () => {
    expect(await localHostPort.call('computerUseTargetApp', { method: 'snapshot', params: { argv: ['--app=Safari'] } })).toBe('Safari')
    expect(await localHostPort.call('computerUseTargetApp', { method: 'snapshot', params: { app: 'Notes' } })).toBe('Notes')
    expect(await localHostPort.call('computerUseTargetApp', { method: 'clipboard-get', params: { argv: [] } })).toBe('Clipboard')
    expect(await localHostPort.call('computerUseTargetApp', { method: 'click', params: { argv: ['--', '@s1:e1'] } })).toBeUndefined()
  })

  it('reports the app a mock run acted in: the one it was approved for, else the one it names', async () => {
    const caller = { sessionId: 's', agentSlug: 'a' }
    expect(await localHostPort.call('computerUse', { method: 'snapshot', params: { argv: ['--app=Safari'] }, caller }))
      .toEqual({ output: '[mock] snapshot executed successfully', app: 'Safari' })
    expect(await localHostPort.call('computerUse', { method: 'click', params: { argv: ['--', '@s1:e1'] }, caller, app: 'Notes' }))
      .toEqual({ output: '[mock] click executed successfully', app: 'Notes' })
  })
})
