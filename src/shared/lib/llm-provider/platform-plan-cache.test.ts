import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformBaseUrl: () => 'https://platform.example.com' }))

import { appState } from '@shared/lib/app-state'
import { platformPlanCache, type PlatformPlanPolicy } from './platform-plan-cache'

const PRO_30: PlatformPlanPolicy = { planName: 'Pro 30', deniedModels: ['claude-fable-'] }
const PRO_200: PlatformPlanPolicy = { planName: 'Pro 200', deniedModels: [] }
const KEY = platformPlanCache.key('org_1', 'member_a')

// The shared setup installs a fresh AppState before every test, so each starts empty.
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('platformPlanCache (SUP-1124)', () => {
  it('keys by platform host, workspace and member', () => {
    expect(platformPlanCache.key('org_1', 'member_a')).not.toBe(platformPlanCache.key('org_1', 'member_b'))
    expect(platformPlanCache.key('org_1', 'member_a')).not.toBe(platformPlanCache.key('org_2', 'member_a'))
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

  it('keeps a policy for an hour, then loads it again', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    const reload = vi.fn(async () => PRO_200)
    vi.advanceTimersByTime(59 * 60_000)
    expect(await platformPlanCache.get(KEY, reload)).toEqual(PRO_30)
    expect(reload).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2 * 60_000)
    expect(await platformPlanCache.get(KEY, reload)).toEqual(PRO_200)
  })

  it('replaces the cached policy with one a platform response carries', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    await platformPlanCache.remember(KEY, PRO_200)
    const load = vi.fn(async () => PRO_30)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_200)
    expect(load).not.toHaveBeenCalled()
  })

  it('never lets an answer that says nothing replace one that did', async () => {
    await platformPlanCache.remember(KEY, PRO_30)
    await platformPlanCache.remember(KEY, null)
    expect(await platformPlanCache.get(KEY, async () => null)).toEqual(PRO_30)
    expect(await platformPlanCache.get(KEY, async () => null, { fresh: true })).toEqual(PRO_30)
    expect(await platformPlanCache.get(KEY, async () => { throw new Error('offline') }, { fresh: true })).toEqual(PRO_30)
    // Nor does it keep the answer longer: it still runs out an hour after it was given.
    vi.advanceTimersByTime(61 * 60_000)
    expect(await platformPlanCache.get(KEY, async () => null)).toBeNull()
  })

  it('reads an unknown or failed load as no restriction, and asks again sooner', async () => {
    const load = vi.fn(async (): Promise<PlatformPlanPolicy | null> => { throw new Error('offline') })
    expect(await platformPlanCache.get(KEY, load)).toBeNull()
    expect(await platformPlanCache.get(KEY, load)).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(11 * 60_000)
    load.mockResolvedValueOnce(PRO_30)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30)
  })

  it('a fresh read replaces the cached policy', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    expect(await platformPlanCache.get(KEY, async () => PRO_200, { fresh: true })).toEqual(PRO_200)
    expect(await platformPlanCache.get(KEY, async () => PRO_30)).toEqual(PRO_200)
  })

  it('serves another process of the tenant without loading (SUP-1634)', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    // A second copy of the module is another process: its own memory, the same AppState.
    vi.resetModules()
    const { platformPlanCache: elsewhere } = await import('./platform-plan-cache')
    expect(elsewhere).not.toBe(platformPlanCache)
    const load = vi.fn(async () => PRO_200)
    expect(await elsewhere.get(KEY, load)).toEqual(PRO_30)
    expect(load).not.toHaveBeenCalled()
  })

  it('reads the account when AppState fails, and does not fail the read or the write', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(appState(), 'get').mockRejectedValue(new Error('store down'))
    vi.spyOn(appState(), 'set').mockRejectedValue(new Error('store down'))
    const load = vi.fn(async () => PRO_30)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30)
    expect(load).toHaveBeenCalledTimes(2)
    await expect(platformPlanCache.remember(KEY, PRO_200)).resolves.toBeUndefined()
  })
})
