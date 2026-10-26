import { describe, expect, it } from 'vitest'
import { CREDENTIAL_BODY_ROUTE, scrubCredentialRequestBody } from './sentry-provider'

describe('credential request bodies in error reports', () => {
  it('matches the routes whose bodies carry credentials', () => {
    for (const path of ['fill-login', 'fill-login-credential', 'provide-secret', 'browser-credentials/verify']) {
      expect(CREDENTIAL_BODY_ROUTE.test(`http://localhost:47891/api/agents/a1/sessions/s-1/${path}`)).toBe(true)
      expect(CREDENTIAL_BODY_ROUTE.test(`/api/agents/a1/sessions/s-1/${path}?x=1`)).toBe(true)
    }
    for (const path of ['messages', 'login-request', 'complete-login', 'browser-credentials']) {
      expect(CREDENTIAL_BODY_ROUTE.test(`/api/agents/a1/sessions/s-1/${path}`)).toBe(false)
    }
  })

  it('drops the body of an event raised while filling a sign-in form', () => {
    const event = { request: { url: '/api/agents/a1/sessions/s-1/fill-login', data: '{"values":["me","hunter2"]}' } }
    expect(scrubCredentialRequestBody(event).request).toEqual({ url: '/api/agents/a1/sessions/s-1/fill-login' })
  })

  it('keeps other bodies', () => {
    const event = { request: { url: '/api/agents/a1/sessions/s-1/messages', data: '{"content":"hi"}' } }
    expect(scrubCredentialRequestBody(event).request?.data).toBe('{"content":"hi"}')
  })
})
