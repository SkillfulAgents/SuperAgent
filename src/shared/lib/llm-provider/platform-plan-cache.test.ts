import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@shared/lib/platform-auth/config', () => ({ getPlatformBaseUrl: () => 'https://platform.example.com' }))

import { platformPlanCache, type PlatformPlanPolicy } from './platform-plan-cache'

const PRO_30: PlatformPlanPolicy = { planName: 'Pro 30', deniedModels: ['claude-fable-'] }
const PRO_200: PlatformPlanPolicy = { planName: 'Pro 200', deniedModels: [] }
const KEY = platformPlanCache.key('org_1', 'member_a')

beforeEach(() => {
  vi.useFakeTimers()
  platformPlanCache.clear()
})
afterEach(() => vi.useRealTimers())

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

  it('serves an expired policy while it reloads in the background', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    vi.advanceTimersByTime(61 * 60_000)
    const reload = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(KEY, reload)).toEqual(PRO_30)
    await vi.waitFor(() => expect(reload).toHaveBeenCalled())
    await vi.waitFor(async () => expect(await platformPlanCache.get(KEY, reload)).toEqual(PRO_200))
  })

  it('never lets an answer that says nothing replace one that did', async () => {
    platformPlanCache.remember(KEY, PRO_30)
    platformPlanCache.remember(KEY, null)
    expect(await platformPlanCache.get(KEY, async () => null)).toEqual(PRO_30)
    expect(await platformPlanCache.get(KEY, async () => { throw new Error('offline') }, { fresh: true })).toEqual(PRO_30)
  })

  it('reads an unknown or failed load as no restriction, and asks again sooner', async () => {
    const load = vi.fn(async (): Promise<PlatformPlanPolicy | null> => { throw new Error('offline') })
    expect(await platformPlanCache.get(KEY, load)).toBeNull()
    vi.advanceTimersByTime(11 * 60_000)
    load.mockResolvedValueOnce(PRO_30)
    await platformPlanCache.get(KEY, load)
    await vi.waitFor(async () => expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_30))
  })

  it('a fresh read replaces the cached policy', async () => {
    await platformPlanCache.get(KEY, async () => PRO_30)
    expect(await platformPlanCache.get(KEY, async () => PRO_200, { fresh: true })).toEqual(PRO_200)
  })

  it('does not let a load that began before clear() restore what it cleared', async () => {
    let finish: ((policy: PlatformPlanPolicy) => void) | undefined
    const pending = platformPlanCache.get(KEY, () => new Promise((resolve) => { finish = resolve }))
    await vi.waitFor(() => expect(finish).toBeDefined())
    platformPlanCache.clear()
    finish!(PRO_30)
    await pending
    const load = vi.fn(async () => PRO_200)
    expect(await platformPlanCache.get(KEY, load)).toEqual(PRO_200)
    expect(load).toHaveBeenCalled()
  })
})
