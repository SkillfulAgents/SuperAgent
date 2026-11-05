import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appState } from '@shared/lib/app-state'

vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformBaseUrl: () => 'https://platform.example.com' }))

import { platformPlanCache, platformPlanChanges, platformPlanChannel, type PlatformPlanKey, type PlatformPlanPolicy } from './platform-plan-cache'
import { backgroundSettled } from '@shared/lib/background'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const PRO_30: PlatformPlanPolicy = { planName: 'Pro 30', deniedModels: ['claude-fable-'] }
const PRO_200: PlatformPlanPolicy = { planName: 'Pro 200', deniedModels: [] }
const KEY = platformPlanCache.key('org_1', 'member_a', 'token_1')

async function remember(key: PlatformPlanKey, policy: PlatformPlanPolicy | null) {
  return platformPlanCache.remember(key, policy, await platformPlanCache.beginRead())
}

/** A second process: its own module state (loads in flight), the same AppState. */
async function anotherProcess() {
  vi.resetModules()
  return (await import('./platform-plan-cache')).platformPlanCache
}

/** A load that waits, with a way to tell it has started. */
function slowLoad() {
  let finish!: (policy: PlatformPlanPolicy | null) => void
  let markStarted!: () => void
  const answer = new Promise<PlatformPlanPolicy | null>((resolve) => { finish = resolve })
  const hasStarted = new Promise<void>((resolve) => { markStarted = resolve })
  const load = vi.fn(() => {
    markStarted()
    return answer
  })
  return { load, finish, started: () => hasStarted }
}

beforeEach(async () => {
  vi.useFakeTimers()
  await platformPlanCache.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('platformPlanCache (SUP-1124)', () => {
  it('keys by platform host, workspace, member and connection', () => {
    expect(platformPlanCache.key('org_1', 'member_a', 'token_1')).not.toEqual(platformPlanCache.key('org_1', 'member_b', 'token_1'))
    expect(platformPlanCache.key('org_1', 'member_a', 'token_1')).not.toEqual(platformPlanCache.key('org_2', 'member_a', 'token_1'))
    expect(platformPlanCache.key('org_1', 'member_a', 'token_1')).not.toEqual(platformPlanCache.key('org_1', 'member_a', 'token_2'))
  })

  it('waits for the first load, then serves the cached policy without loading', async () => {
    const load = vi.fn(async () => PRO_30)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('shares one load between concurrent readers', async () => {
    const load = vi.fn(async () => PRO_30)
    await Promise.all([platformPlanCache.get(KEY, load), platformPlanCache.get(KEY, load)])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('serves an expired policy while it reloads in the background', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    vi.advanceTimersByTime(61 * MINUTE)
    const reload = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(KEY, reload)).toEqual(PRO_30)
    await vi.waitFor(() => expect(reload).toHaveBeenCalled())
    await vi.waitFor(async () => expect(await platformPlanCache.get(KEY, reload)).toEqual(PRO_200))
  })

  it('never lets an answer that says nothing replace one that did', async () => {
    await remember(KEY, PRO_30)
    await remember(KEY, null)
    expect(await platformPlanCache.get(KEY, async () => null)).toEqual(PRO_30)
    expect(await platformPlanCache.get(KEY, async () => { throw new Error('offline') }, { fresh: true })).toEqual(PRO_30)
  })

  it('reads an unknown or failed load as no restriction, and asks again sooner', async () => {
    const load = vi.fn(async (): Promise<PlatformPlanPolicy | null> => { throw new Error('offline') })
    expect(await platformPlanCache.get(KEY, load)).toBeNull()
    vi.advanceTimersByTime(11 * MINUTE)
    load.mockResolvedValueOnce(PRO_30)
    await platformPlanCache.get(KEY, load)
    await vi.waitFor(async () => expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30))
  })

  it('a fresh read replaces the cached policy', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    expect(await platformPlanCache.get(KEY, async () => PRO_200, { fresh: true })).toEqual(PRO_200)
  })

  it('does not let a load that began before clear() restore what it cleared', async () => {
    const { load: first, finish, started } = slowLoad()
    const pending = platformPlanCache.get(KEY, first)
    await started()
    await platformPlanCache.clear()
    finish(PRO_30)
    await pending
    const load = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_200)
    expect(load).toHaveBeenCalled()
  })

  it('does not hand a read after clear() the load that began before it', async () => {
    const { load: before, finish, started } = slowLoad()
    const pending = platformPlanCache.get(KEY, before)
    await started()
    await platformPlanCache.clear()

    expect(await platformPlanCache.get(KEY, async () => PRO_200)).toEqual(PRO_200)

    finish(PRO_30)
    await pending
  })
})

describe('across processes', () => {
  it('serves another process what this one learned, without loading', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    const other = await anotherProcess()
    const load = vi.fn(async () => PRO_200)
    expect(await other.get(KEY, load)).toEqual(PRO_30)
    expect(load).not.toHaveBeenCalled()
  })

  it('a clear in one process forgets every account in the others, with no hint delivered', async () => {
    vi.spyOn(appState(), 'publish').mockRejectedValue(new Error('hints are down'))
    await platformPlanCache.get(KEY, async () => PRO_30)
    const other = await anotherProcess()

    await other.clear()

    const load = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_200)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a load in flight in one process does not survive a clear in another', async () => {
    const { load: before, finish, started } = slowLoad()
    const pending = platformPlanCache.get(KEY, before)
    await started()
    const other = await anotherProcess()

    await other.clear()
    finish(PRO_30)
    await pending

    const load = vi.fn(async () => PRO_200)
    expect(await other.get(KEY, load)).toEqual(PRO_200)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_200)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('an account read that began before a clear stays forgotten, however late it answers', async () => {
    const read = await platformPlanCache.beginRead()
    await platformPlanCache.clear()
    await platformPlanCache.remember(KEY, PRO_30, read)
    const load = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_200)
  })

  it('a late answer does not overwrite one from a read that began after it', async () => {
    const earlier = await platformPlanCache.beginRead()
    vi.advanceTimersByTime(1_000)
    await remember(KEY, PRO_200)
    await platformPlanCache.remember(KEY, PRO_30, earlier)
    expect(await platformPlanCache.get(KEY, async () => null)).toEqual(PRO_200)
  })

  it('switching accounts: another connection never reads this one\'s entry, even if the clear was lost', async () => {
    vi.spyOn(appState(), 'set').mockRejectedValueOnce(new Error('AppState is down'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const noIdentity = platformPlanCache.key(null, null, 'token_a')
    await platformPlanCache.clear()
    await remember(noIdentity, PRO_30)

    const other = await anotherProcess()
    const switched = other.key(null, null, 'token_b')
    const load = vi.fn(async () => PRO_200)

    expect(await other.get(switched, load)).toEqual(PRO_200)
    expect(load).toHaveBeenCalledTimes(1)
    expect(await other.get(noIdentity, load)).toEqual(PRO_30)
  })

  it('switching back with the same token still loads, once the clear landed', async () => {
    const accountA = platformPlanCache.key('org_a', 'member_a', 'token_a')
    await remember(accountA, PRO_30)
    await platformPlanCache.clear()
    await remember(platformPlanCache.key('org_b', 'member_b', 'token_b'), PRO_200)
    await platformPlanCache.clear()

    const load = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(accountA, load)).toEqual(PRO_200)
    expect(load).toHaveBeenCalledTimes(1)
  })
})

describe('freshness and retention', () => {
  it('keeps a known answer fresh for an hour, and an unknown one for ten minutes', async () => {
    const reload = vi.fn(async () => PRO_200)
    await remember(KEY, PRO_30)
    vi.advanceTimersByTime(59 * MINUTE)
    await platformPlanCache.get(KEY, reload)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MINUTE)
    await platformPlanCache.get(KEY, reload)
    await backgroundSettled()
    expect(reload).toHaveBeenCalledTimes(1)

    const unknown = platformPlanCache.key('org_1', 'member_b', 'token_1')
    await remember(unknown, null)
    reload.mockClear()
    vi.advanceTimersByTime(9 * MINUTE)
    await platformPlanCache.get(unknown, reload)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(MINUTE)
    await platformPlanCache.get(unknown, reload)
    await backgroundSettled()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('serves a stale answer through failed reloads, up to 24 hours after the platform last gave it', async () => {
    const failing = vi.fn(async () => { throw new Error('offline') })
    await remember(KEY, PRO_30)

    vi.advanceTimersByTime(23 * HOUR + 59 * MINUTE)
    expect(await platformPlanCache.get(KEY, failing)).toEqual(PRO_30)
    await backgroundSettled()
    expect(failing).toHaveBeenCalledTimes(1)

    // That failed reload kept the answer, but no longer than it would have lasted.
    vi.advanceTimersByTime(MINUTE)
    expect(await platformPlanCache.get(KEY, failing)).toBeNull()
  })

  it('counts retention again from a new answer', async () => {
    await remember(KEY, PRO_30)
    vi.advanceTimersByTime(23 * HOUR)
    await remember(KEY, PRO_30)
    vi.advanceTimersByTime(23 * HOUR)
    const load = vi.fn(async () => null)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30)
  })

  it('does not trust freshness stamped by a clock ahead of this one', async () => {
    const now = Date.now()
    vi.setSystemTime(now + 30 * MINUTE)
    await remember(KEY, PRO_30)
    vi.setSystemTime(now)

    const reload = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(KEY, reload)).toEqual(PRO_30)
    await backgroundSettled()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('when AppState fails', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('a failed clear does not fail the caller, and logs', async () => {
    vi.spyOn(appState(), 'set').mockRejectedValueOnce(new Error('AppState is down'))
    await expect(platformPlanCache.clear()).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not clear'), expect.any(Error))
  })

  it('reads the platform when the epoch or the entry cannot be read', async () => {
    await remember(KEY, PRO_30)
    const get = vi.spyOn(appState(), 'get').mockRejectedValue(new Error('AppState is down'))
    expect(await platformPlanCache.get(KEY, async () => PRO_200)).toEqual(PRO_200)
    get.mockRestore()

    await remember(KEY, PRO_30)
    vi.spyOn(appState(), 'get')
      .mockImplementationOnce(() => Promise.resolve(null))
      .mockRejectedValueOnce(new Error('AppState is down'))
    expect(await platformPlanCache.get(platformPlanCache.key('org_9', 'member_9', 'token_9'), async () => PRO_200)).toEqual(PRO_200)
  })

  it('shares one load while AppState is down', async () => {
    vi.spyOn(appState(), 'get').mockRejectedValue(new Error('AppState is down'))
    const load = vi.fn(async () => PRO_30)
    await Promise.all([platformPlanCache.get(KEY, load), platformPlanCache.get(KEY, load)])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('a write it cannot make leaves the answer with its caller', async () => {
    vi.spyOn(appState(), 'set').mockRejectedValue(new Error('AppState is down'))
    expect(await platformPlanCache.get(KEY, async () => PRO_30)).toEqual(PRO_30)
  })

  it('files nothing when it could not read the epoch before the request', async () => {
    const get = vi.spyOn(appState(), 'get').mockRejectedValueOnce(new Error('AppState is down'))
    const read = await platformPlanCache.beginRead()
    get.mockRestore()
    expect(read.epoch).toBeNull()
    expect(await platformPlanCache.remember(KEY, PRO_30, read)).toEqual(PRO_30)
    const load = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_200)
  })

  it('refuses a value the schema refuses, and the caller still gets its answer', async () => {
    const malformed = { planName: 7, deniedModels: 'all' } as unknown as PlatformPlanPolicy
    expect(await remember(KEY, malformed)).toEqual(malformed)
    const load = vi.fn(async () => PRO_30)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30)
  })

  it('a hint that cannot be published changes nothing else', async () => {
    vi.spyOn(appState(), 'publish').mockRejectedValue(new Error('hints are down'))
    await expect(remember(KEY, PRO_30)).resolves.toEqual(PRO_30)
    expect(await platformPlanCache.get(KEY, async () => null)).toEqual(PRO_30)
    await expect(platformPlanCache.clear()).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('hint'), expect.any(Error))
  })
})

describe('hints', () => {
  async function listen(channel: ReturnType<typeof platformPlanChannel>) {
    const events: unknown[] = []
    await appState().subscribe([channel], (event) => { events.push(event) })
    return events
  }

  it('says the account\'s answer changed with a revision and nothing else, and only when it did', async () => {
    const events = await listen(platformPlanChannel(KEY))
    await remember(KEY, PRO_30)
    await remember(KEY, PRO_30)
    await remember(KEY, null)
    await remember(KEY, PRO_200)
    await backgroundSettled()
    expect(events).toEqual([{ revision: expect.any(String) }, { revision: expect.any(String) }])
  })

  it('announces a clear on its own channel', async () => {
    const events = await listen(platformPlanChanges.channel('all-accounts'))
    await platformPlanCache.clear()
    await backgroundSettled()
    expect(events).toEqual([{ revision: expect.any(String) }])
  })
})
