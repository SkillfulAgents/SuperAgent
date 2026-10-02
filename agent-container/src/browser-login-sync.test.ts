import { afterEach, describe, expect, it, vi } from 'vitest'
import { finishHostLoginSync, startHostLoginSync } from './browser-login-sync'

describe('host login sync wait', () => {
  afterEach(() => {
    delete process.env.SUPERAGENT_BROWSER_LOGIN_SYNC
    vi.useRealTimers()
  })

  it('does not wait when the host did not say it will answer', () => {
    expect(startHostLoginSync()).toBeNull()
  })

  it('settles when the host reports the sync done', async () => {
    process.env.SUPERAGENT_BROWSER_LOGIN_SYNC = '1'
    const sync = startHostLoginSync()!
    let settled = false
    void sync.done.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    expect(finishHostLoginSync(sync.id)).toBe(true)
    await sync.done
    expect(finishHostLoginSync(sync.id)).toBe(false)
  })

  it('stops waiting after the timeout so browser_open never hangs', async () => {
    vi.useFakeTimers()
    process.env.SUPERAGENT_BROWSER_LOGIN_SYNC = '1'
    const sync = startHostLoginSync(10_000)!
    await vi.advanceTimersByTimeAsync(10_000)
    await sync.done
    expect(finishHostLoginSync(sync.id)).toBe(false)
  })
})
