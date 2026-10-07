import { describe, expect, it } from 'vitest'
import { CredentialRefreshError } from '../../../../agent-container/src/credential-refresh-error'
import { MessageNotAcceptedError } from '../container/message-dispatch-error'
import { credentialRefreshErrorBody, credentialRefreshUserStatus, findCredentialRefreshError } from './credential-refresh-response'

describe('findCredentialRefreshError', () => {
  it('finds the refresh failure behind a rejected session start', () => {
    const refresh = new CredentialRefreshError(401)
    const wrapped = new MessageNotAcceptedError('unavailable', refresh.message, { cause: refresh })
    expect(findCredentialRefreshError(wrapped)).toBe(refresh)
  })

  it('ignores unrelated errors', () => {
    expect(findCredentialRefreshError(new Error('Container unavailable', { cause: new Error('ECONNREFUSED') }))).toBeNull()
    expect(findCredentialRefreshError('boom')).toBeNull()
  })
})

describe('credentialRefreshErrorBody', () => {
  it('asks the user to reconnect when the provider rejected the sign-in', () => {
    const error = new CredentialRefreshError(401)
    expect(credentialRefreshErrorBody(error)).toEqual({
      error: error.message,
      code: 'provider_reconnect_required',
      errorPresentation: { severity: 'error', message: error.message, icon: 'info' },
    })
    expect(credentialRefreshUserStatus(error)).toBe(424)
  })

  it('reports a temporary refresh outage as a warning', () => {
    const error = new CredentialRefreshError(503)
    expect(credentialRefreshErrorBody(error)).toMatchObject({ code: 'provider_refresh_unavailable', errorPresentation: { severity: 'warning' } })
    expect(credentialRefreshUserStatus(error)).toBe(503)
  })
})
