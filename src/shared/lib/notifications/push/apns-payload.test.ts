import { describe, it, expect } from 'vitest'
import { buildApnsAlertPush, buildApnsBackgroundPush } from './apns-payload'
import type { ApnsDeviceRow } from './apns-device-service'
import type { NotificationEvent } from '../notification-event'

const NOW_MS = 1_755_200_000_000

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    notificationId: 'notif-1',
    type: 'session_complete',
    sessionId: 'sess-1',
    agentSlug: 'agent-x',
    title: 'Session Complete',
    body: 'Demo Agent has finished running',
    navigatePath: '/agents/agent-x/sessions/sess-1',
    ...overrides,
  }
}

function makeDevice(overrides: Partial<ApnsDeviceRow> = {}): ApnsDeviceRow {
  return {
    id: 'dev-row-1',
    token: 'a'.repeat(64),
    environment: 'production',
    userId: null,
    mobileDeviceId: 'family-1',
    workspaceTag: 'ws-1',
    deviceName: 'iPhone',
    platform: 'ios',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

describe('buildApnsAlertPush', () => {
  it('builds the full alert push shape', () => {
    const push = buildApnsAlertPush(makeEvent(), makeDevice(), NOW_MS)

    expect(push).toEqual({
      deviceToken: 'a'.repeat(64),
      environment: 'production',
      kind: 'alert',
      alert: { title: 'Session Complete', body: 'Demo Agent has finished running' },
      data: {
        type: 'session_complete',
        notificationId: 'notif-1',
        sessionId: 'sess-1',
        agentSlug: 'agent-x',
        navigatePath: '/agents/agent-x/sessions/sess-1',
        workspaceId: 'ws-1',
      },
      collapseId: 'sess-1',
      expiration: NOW_MS / 1000 + 60 * 60,
    })
  })

  it('echoes the device workspaceTag as workspaceId; a null tag becomes undefined', () => {
    const push = buildApnsAlertPush(makeEvent(), makeDevice({ workspaceTag: null }), NOW_MS)
    expect(push.data.workspaceId).toBeUndefined()
  })

  it('carries the sandbox environment through for dev-build tokens', () => {
    const push = buildApnsAlertPush(makeEvent(), makeDevice({ environment: 'sandbox' }), NOW_MS)
    expect(push.environment).toBe('sandbox')
  })

  it('sanitizes the collapse id — strips non [A-Za-z0-9_-] and caps at 64 chars', () => {
    const push = buildApnsAlertPush(
      makeEvent({ sessionId: 'sess/1:evil?' + 'x'.repeat(100) }),
      makeDevice(),
      NOW_MS
    )
    expect(push.collapseId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(push.collapseId!.length).toBeLessThanOrEqual(64)
    expect(push.collapseId!.startsWith('sess1evil')).toBe(true)
  })

  it('actionable session_waiting pushes carry a short TTL — stale prompts expire', () => {
    const push = buildApnsAlertPush(makeEvent({ type: 'session_waiting' }), makeDevice(), NOW_MS)
    expect(push.expiration).toBe(NOW_MS / 1000 + 10 * 60)
  })
})

describe('buildApnsBackgroundPush', () => {
  it('builds a silent push: no alert, no collapse id, minimal data', () => {
    const push = buildApnsBackgroundPush(
      makeEvent({ type: 'session_scheduled' }),
      makeDevice(),
      NOW_MS
    )

    expect(push).toEqual({
      deviceToken: 'a'.repeat(64),
      environment: 'production',
      kind: 'background',
      data: {
        type: 'session_scheduled',
        sessionId: 'sess-1',
        agentSlug: 'agent-x',
        workspaceId: 'ws-1',
      },
      expiration: NOW_MS / 1000 + 60 * 60,
    })
    expect(push.alert).toBeUndefined()
    expect(push.collapseId).toBeUndefined()
  })

  it('uses the default TTL for types without a specific one', () => {
    const push = buildApnsBackgroundPush(
      makeEvent({ type: 'session_webhook' }),
      makeDevice(),
      NOW_MS
    )
    expect(push.expiration).toBe(NOW_MS / 1000 + 60 * 60)
  })
})
