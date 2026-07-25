/**
 * Unit coverage for session-creation attribution. The integration suite proves
 * the real endpoints land on the right paths; this proves the mapping itself,
 * the async-local tag, and that nothing but the attribution reaches `details`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const logAuditEventMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@shared/lib/services/audit-log-service', () => ({
  logAuditEvent: logAuditEventMock,
}))

import {
  auditSessionCreated,
  resolveSessionAuditContext,
  withSessionAuditContext,
} from './session-audit'

const SESSION = { id: 'sess_1', userId: 'user_1' }

beforeEach(() => {
  logAuditEventMock.mockClear()
})

describe('resolveSessionAuditContext', () => {
  it.each([
    ['/sign-in/email', 'password'],
    ['/sign-up/email', 'password'],
    ['/callback/:id', 'oidc'],
    ['/oauth2/callback/:providerId', 'oidc'],
    ['/admin/impersonate-user', 'impersonation'],
  ])('maps %s to %s', (path, method) => {
    expect(resolveSessionAuditContext(path).method).toBe(method)
  })

  it('reports an unrecognized endpoint path as unknown rather than guessing', () => {
    expect(resolveSessionAuditContext('/sign-in/passkey').method).toBe('unknown')
  })

  it('reports a session with no endpoint context as unknown', () => {
    expect(resolveSessionAuditContext(undefined).method).toBe('unknown')
    expect(resolveSessionAuditContext(null).method).toBe('unknown')
  })

  it('lets an explicit tag win over the endpoint path', () => {
    withSessionAuditContext({ method: 'token-exchange', orgId: 'org_1' }, () => {
      expect(resolveSessionAuditContext('/sign-in/email')).toEqual({
        method: 'token-exchange',
        orgId: 'org_1',
      })
    })
  })

  it('does not leak a tag outside its scope', () => {
    withSessionAuditContext({ method: 'token-exchange' }, () => {})
    expect(resolveSessionAuditContext(undefined).method).toBe('unknown')
  })

  it('keeps concurrent tags isolated from each other', async () => {
    const seen: string[] = []
    const tagged = (orgId: string, delayMs: number) =>
      withSessionAuditContext({ method: 'token-exchange', orgId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        seen.push(resolveSessionAuditContext(undefined).orgId!)
      })

    await Promise.all([tagged('org_a', 10), tagged('org_b', 0)])

    expect(seen.sort()).toEqual(['org_a', 'org_b'])
  })
})

describe('auditSessionCreated', () => {
  it('writes exactly one session:created row attributed to the session user', async () => {
    await auditSessionCreated(SESSION, '/sign-in/email')

    expect(logAuditEventMock).toHaveBeenCalledOnce()
    expect(logAuditEventMock).toHaveBeenCalledWith({
      userId: 'user_1',
      object: 'session',
      objectId: 'sess_1',
      action: 'created',
      details: { method: 'password' },
    })
  })

  it('records the grant org for a tagged token exchange', async () => {
    await withSessionAuditContext({ method: 'token-exchange', orgId: 'org_9' }, () =>
      auditSessionCreated(SESSION),
    )

    expect(logAuditEventMock.mock.calls[0][0].details).toEqual({
      method: 'token-exchange',
      orgId: 'org_9',
    })
  })

  it('omits orgId entirely when the path did not name one', async () => {
    await auditSessionCreated(SESSION, '/callback/:id')

    expect(Object.keys(logAuditEventMock.mock.calls[0][0].details)).toEqual(['method'])
  })

  it('credits the impersonating admin as the actor, not the impersonated user', async () => {
    await auditSessionCreated(
      { id: 'sess_imp', userId: 'target_user', impersonatedBy: 'admin_user' },
      '/admin/impersonate-user',
    )

    expect(logAuditEventMock).toHaveBeenCalledWith({
      userId: 'admin_user',
      object: 'session',
      objectId: 'sess_imp',
      action: 'created',
      details: { method: 'impersonation', targetUserId: 'target_user' },
    })
  })

  it('recognizes impersonation from the session column even without the path', async () => {
    await auditSessionCreated({ id: 'sess_imp', userId: 'target', impersonatedBy: 'admin' })

    const call = logAuditEventMock.mock.calls[0][0]
    expect(call.userId).toBe('admin')
    expect(call.details.method).toBe('impersonation')
  })

  it('treats an absent or blank impersonatedBy as an ordinary session', async () => {
    await auditSessionCreated({ ...SESSION, impersonatedBy: '' }, '/sign-in/email')
    await auditSessionCreated({ ...SESSION, impersonatedBy: null }, '/sign-in/email')

    for (const [call] of logAuditEventMock.mock.calls) {
      expect(call.userId).toBe('user_1')
      expect(call.details).toEqual({ method: 'password' })
    }
  })

  it('never carries anything beyond the attribution into details', async () => {
    await auditSessionCreated(SESSION, '/oauth2/callback/:providerId')

    const details = logAuditEventMock.mock.calls[0][0].details as Record<string, unknown>
    expect(Object.keys(details).every((key) => key === 'method' || key === 'orgId')).toBe(true)
  })
})
