import { afterEach, describe, expect, it } from 'vitest'
import {
  closePreparedLogins,
  failPreparedLogin,
  forgetAllPreparedLogins,
  forgetPreparedLogin,
  getPreparedLogin,
  isPreparedLoginClosed,
  putPreparedLogin,
  waitForPreparedLogin,
} from './login-requests'
import type { PreparedLogin } from './login-fill'

const prepared = (toolUseId: string): PreparedLogin => ({
  toolUseId,
  sessionId: 'session-1',
  origin: 'https://github.com',
  url: 'https://github.com/login',
  fields: [{ ref: '@e3', kind: 'username', label: 'Email', inputType: 'email', inputMode: '', autocomplete: 'username', maxLength: -1 }],
  submitRef: '@e5',
  preparedAt: 1,
})

describe('prepared sign-in requests', () => {
  afterEach(() => forgetAllPreparedLogins())

  it('wakes a reader waiting for the tool to finish locating the fields', async () => {
    const waiting = waitForPreparedLogin('t1', 5_000)
    putPreparedLogin(prepared('t1'))
    await expect(waiting).resolves.toEqual({ prepared: prepared('t1') })
    expect(getPreparedLogin('t1')?.origin).toBe('https://github.com')
  })

  it('tells a waiting reader why preparation failed', async () => {
    const waiting = waitForPreparedLogin('t2', 5_000)
    failPreparedLogin('t2', ['@e9 is not visible'])
    await expect(waiting).resolves.toEqual({ problems: ['@e9 is not visible'] })
    expect(getPreparedLogin('t2')).toBeNull()
  })

  it('answers at once when preparation already settled, and null after the wait', async () => {
    putPreparedLogin(prepared('t3'))
    await expect(waitForPreparedLogin('t3', 10)).resolves.toEqual({ prepared: prepared('t3') })
    await expect(waitForPreparedLogin('unknown', 10)).resolves.toBeNull()
  })

  it('forgets one request, or all of them', () => {
    putPreparedLogin(prepared('a'))
    putPreparedLogin(prepared('b'))
    forgetPreparedLogin('a')
    expect(getPreparedLogin('a')).toBeNull()
    expect(getPreparedLogin('b')).not.toBeNull()
    forgetAllPreparedLogins()
    expect(getPreparedLogin('b')).toBeNull()
  })

  it('keeps each request when the browser closes, marked as closed; a later one is not', () => {
    putPreparedLogin(prepared('a'))
    closePreparedLogins()
    expect(getPreparedLogin('a')).not.toBeNull()
    expect(isPreparedLoginClosed('a')).toBe(true)
    // Located in the next browser.
    putPreparedLogin(prepared('b'))
    expect(isPreparedLoginClosed('b')).toBe(false)
    forgetPreparedLogin('a')
    expect(isPreparedLoginClosed('a')).toBe(false)
  })
})
