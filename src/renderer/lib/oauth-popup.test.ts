// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareAuthSession } from './oauth-popup'

type Outcome = 'completed' | 'cancelled' | 'failed' | 'browser'

function installSession(outcome: Promise<Outcome>) {
  const api = {
    startPlatformSignIn: vi.fn(() => outcome),
    cancelPlatformSignIn: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
  return api
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('prepareAuthSession', () => {
  it('starts the sheet without waiting for it to close', async () => {
    const api = installSession(new Promise<Outcome>(() => {}))
    const onCancelled = vi.fn()

    await prepareAuthSession(onCancelled).navigate('https://platform.example/auth/superagent')

    expect(api.startPlatformSignIn).toHaveBeenCalledWith('https://platform.example/auth/superagent', false)
    expect(api.openExternal).not.toHaveBeenCalled()
    expect(onCancelled).not.toHaveBeenCalled()
  })

  it('asks main for the Apple prompt first when the attempt is a Sign in with Apple', async () => {
    const api = installSession(new Promise<Outcome>(() => {}))

    await prepareAuthSession(vi.fn(), true).navigate('https://platform.example/auth/superagent')

    expect(api.startPlatformSignIn).toHaveBeenCalledWith('https://platform.example/auth/superagent', true)
  })

  it('reports the person closing the sheet', async () => {
    installSession(Promise.resolve<Outcome>('cancelled'))
    const onCancelled = vi.fn()

    await prepareAuthSession(onCancelled).navigate('https://platform.example/auth/superagent')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onCancelled).toHaveBeenCalledTimes(1)
  })

  it('ends the attempt when the session could not be started at all', async () => {
    installSession(Promise.reject(new Error('no handler')))
    const onCancelled = vi.fn()

    await prepareAuthSession(onCancelled).navigate('https://platform.example/auth/superagent')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onCancelled).toHaveBeenCalledTimes(1)
  })

  it.each<Outcome>(['completed', 'failed', 'browser'])('leaves a %s sign-in to the platform-auth callback', async (outcome) => {
    installSession(Promise.resolve(outcome))
    const onCancelled = vi.fn()

    await prepareAuthSession(onCancelled).navigate('https://platform.example/auth/superagent')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onCancelled).not.toHaveBeenCalled()
  })

  it('closing it cancels the sheet once, and that cancellation is not reported back', async () => {
    let end!: (outcome: Outcome) => void
    const api = installSession(new Promise<Outcome>((resolve) => { end = resolve }))
    const onCancelled = vi.fn()
    const session = prepareAuthSession(onCancelled)
    await session.navigate('https://platform.example/auth/superagent')

    session.close()
    session.close()
    end('cancelled')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(api.cancelPlatformSignIn).toHaveBeenCalledTimes(1)
    expect(onCancelled).not.toHaveBeenCalled()
  })
})
