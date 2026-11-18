import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  forgetLoginValues,
  getLoginRequestState,
  loginRequestKey,
  recallLoginValues,
  rememberLoginValues,
  resetLoginRequestStore,
  runLoginAction,
} from './login-request-store'

const FIELDS = [
  { kind: 'username', label: 'Email' },
  { kind: 'password', label: 'Password' },
  { kind: 'otp', label: 'Code' },
  { kind: 'text', label: 'Company' },
]

describe('login request store', () => {
  beforeEach(() => resetLoginRequestStore())
  afterEach(() => vi.useRealTimers())

  it('runs one action per request: a second surface clicking at once is refused', async () => {
    const key = loginRequestKey('agent', 's1', 'tu-1')
    let release!: () => void
    const first = runLoginAction(key, 'fill', () => new Promise<{ status: 'manual' }>((resolve) => { release = () => resolve({ status: 'manual' }) }))
    expect(getLoginRequestState(key)).toEqual({ status: 'submitting', action: 'fill' })
    await expect(runLoginAction(key, 'decline', async () => ({ status: 'declined' as const }))).resolves.toBeNull()
    release()
    await expect(first).resolves.toEqual({ status: 'manual' })
    // Settled: nothing more can be sent for it.
    await expect(runLoginAction(key, 'fill', async () => ({ status: 'manual' as const }))).resolves.toBeNull()
  })

  it('returns to idle with the error, so the user can retry', async () => {
    const key = loginRequestKey('agent', 's1', 'tu-2')
    await runLoginAction(key, 'fill', async () => { throw new Error('The browser is unavailable') })
    expect(getLoginRequestState(key)).toEqual({ status: 'idle', error: 'The browser is unavailable' })
    await expect(runLoginAction(key, 'fill', async () => ({ status: 'declined' as const }))).resolves.toEqual({ status: 'declined' })
  })

  it('keeps requests of different sessions and agents apart', () => {
    expect(loginRequestKey('a', 's', 't')).not.toBe(loginRequestKey('a', 's2', 't'))
    expect(loginRequestKey('a', 's', 't')).not.toBe(loginRequestKey('b', 's', 't'))
  })

  it('recalls only the identifier: never a password, code or other field', () => {
    rememberLoginValues('agent', 's1', 'https://github.com', FIELDS, ['octocat', 'pw-1', '123456', 'Acme'])
    expect(recallLoginValues('agent', 's1', 'https://github.com', FIELDS)).toEqual(['octocat', '', '', ''])
  })

  it('recalls nothing for another site, session or agent', () => {
    rememberLoginValues('agent', 's1', 'https://github.com', FIELDS, ['octocat', 'pw', '', ''])
    expect(recallLoginValues('agent', 's1', 'https://gitlab.com', FIELDS)).toEqual(['', '', '', ''])
    expect(recallLoginValues('other', 's1', 'https://github.com', FIELDS)).toEqual(['', '', '', ''])
    expect(recallLoginValues('agent', 's2', 'https://github.com', FIELDS)).toEqual(['', '', '', ''])
  })

  it('drops what it remembers after ten minutes, and when the signed-in user changes', () => {
    vi.useFakeTimers()
    rememberLoginValues('agent', 's1', 'https://github.com', FIELDS, ['octocat', '', '', ''])
    vi.advanceTimersByTime(9 * 60 * 1000)
    expect(recallLoginValues('agent', 's1', 'https://github.com', FIELDS)[0]).toBe('octocat')
    vi.advanceTimersByTime(2 * 60 * 1000)
    expect(recallLoginValues('agent', 's1', 'https://github.com', FIELDS)[0]).toBe('')

    rememberLoginValues('agent', 's1', 'https://github.com', FIELDS, ['octocat', '', '', ''])
    forgetLoginValues()
    expect(recallLoginValues('agent', 's1', 'https://github.com', FIELDS)[0]).toBe('')
  })

  it('matches remembered values to fields by kind and label, not position', () => {
    rememberLoginValues('agent', 's1', 'https://github.com', FIELDS, ['octocat', 'pw', '', ''])
    const reordered = [{ kind: 'password', label: 'password' }, { kind: 'username', label: 'EMAIL' }]
    expect(recallLoginValues('agent', 's1', 'https://github.com', reordered)).toEqual(['', 'octocat'])
  })
})
