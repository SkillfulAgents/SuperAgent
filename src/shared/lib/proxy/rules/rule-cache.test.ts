import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { appState, defineNamespace } from '@shared/lib/app-state'
import { backgroundSettled } from '@shared/lib/background'
import { allTargetsEpochKey, cachedRules, invalidateRuleCache, RULE_CACHE_TTL_MS, ruleChanges } from './rule-cache'
import type { CachedRule } from './rule-cache-schema'

const TARGET = { kind: 'api', targetId: 'acct-1' } as const
const OTHER_TARGET = { kind: 'mcp', targetId: 'mcp-1' } as const

function rule(name: string): CachedRule {
  return {
    agentSlug: null,
    active: {
      ruleId: name, versionId: `${name}-v1`, version: 1, kind: 'api', effect: 'allow', name,
      restatement: name, patterns: ['GET /*'], code: '() => true', toolSchemaHash: null,
    },
  }
}
const OLD = [rule('old')]
const NEW = [rule('new')]

/** A second process: its own module state (loads in flight), the same AppState. */
async function anotherProcess() {
  vi.resetModules()
  return import('./rule-cache')
}

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms)
}

/** A load that waits, with a way to tell it has started. */
function slowLoad(rows: CachedRule[]) {
  let finish!: () => void
  let markStarted!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  const hasStarted = new Promise<void>((resolve) => { markStarted = resolve })
  const load = vi.fn(async () => {
    markStarted()
    await gate
    return rows
  })
  return { load, finish, started: () => hasStarted }
}

beforeEach(() => {
  // Date only: AppState's clock moves by hand, and promises run as usual.
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('reading', () => {
  it('loads once, then serves the snapshot', async () => {
    const load = vi.fn(async () => OLD)
    expect(await cachedRules(TARGET, load)).toEqual(OLD)
    expect(await cachedRules(TARGET, load)).toEqual(OLD)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps targets apart', async () => {
    await cachedRules(TARGET, async () => OLD)
    expect(await cachedRules(OTHER_TARGET, async () => NEW)).toEqual(NEW)
    expect(await cachedRules(TARGET, async () => NEW)).toEqual(OLD)
  })

  it('shares one load between concurrent readers of a process', async () => {
    const { load, finish, started } = slowLoad(OLD)
    const readers = [cachedRules(TARGET, load), cachedRules(TARGET, load), cachedRules(TARGET, load)]
    await started()
    const joiner = cachedRules(TARGET, load)
    finish()
    expect(await Promise.all([...readers, joiner])).toEqual([OLD, OLD, OLD, OLD])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('serves another process what this one loaded, without a load there', async () => {
    await cachedRules(TARGET, async () => OLD)
    const other = await anotherProcess()
    const load = vi.fn(async () => NEW)
    expect(await other.cachedRules(TARGET, load)).toEqual(OLD)
    expect(load).not.toHaveBeenCalled()
  })

  it('passes a failed load to its readers and tries again next time', async () => {
    const load = vi.fn<() => Promise<CachedRule[]>>().mockRejectedValueOnce(new Error('database is locked')).mockResolvedValue(OLD)
    const results = await Promise.allSettled([cachedRules(TARGET, load), cachedRules(TARGET, load)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(load).toHaveBeenCalledTimes(1)
    expect(await cachedRules(TARGET, load)).toEqual(OLD)
  })
})

describe('the ceiling, with no invalidation at all', () => {
  it('holds in every process: at the ceiling a read goes to the database', async () => {
    await cachedRules(TARGET, async () => OLD)
    const other = await anotherProcess()
    const load = vi.fn(async () => NEW)

    advance(RULE_CACHE_TTL_MS - 1)
    expect(await other.cachedRules(TARGET, load)).toEqual(OLD)
    expect(load).not.toHaveBeenCalled()

    advance(1)
    expect(await other.cachedRules(TARGET, load)).toEqual(NEW)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('counts from before the database read, so a slow read earns nothing', async () => {
    const { load, finish, started } = slowLoad(OLD)
    const pending = cachedRules(TARGET, load)
    await started()
    advance(3_000)
    finish()
    await pending

    const next = vi.fn(async () => NEW)
    advance(RULE_CACHE_TTL_MS - 3_000 - 1)
    expect(await cachedRules(TARGET, next)).toEqual(OLD)
    advance(1)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
  })

  it('a load that took the whole ceiling publishes nothing, and answers its reader', async () => {
    const { load, finish, started } = slowLoad(OLD)
    const pending = cachedRules(TARGET, load)
    await started()
    advance(RULE_CACHE_TTL_MS)
    finish()
    expect(await pending).toEqual(OLD)

    const next = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
  })

  it('a reader past the ceiling of a stuck load does not join it', async () => {
    const stuck = slowLoad(OLD)
    const pending = cachedRules(TARGET, stuck.load)
    await stuck.started()
    advance(RULE_CACHE_TTL_MS)

    expect(await cachedRules(TARGET, async () => NEW)).toEqual(NEW)

    stuck.finish()
    await pending
  })
})

describe('invalidation against a load in flight', () => {
  it('one process\'s invalidation stops another\'s pre-invalidation load from publishing', async () => {
    const { load, finish, started } = slowLoad(OLD)
    const pending = cachedRules(TARGET, load)
    await started()

    const other = await anotherProcess()
    await other.invalidateRuleCache(TARGET)
    finish()
    expect(await pending).toEqual(OLD)

    const next = vi.fn(async () => NEW)
    expect(await other.cachedRules(TARGET, next)).toEqual(NEW)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('stops a load that started from an expired snapshot', async () => {
    await cachedRules(TARGET, async () => OLD)
    advance(RULE_CACHE_TTL_MS)
    const { load, finish, started } = slowLoad(OLD)
    const pending = cachedRules(TARGET, load)
    await started()

    await invalidateRuleCache(TARGET)
    finish()
    await pending

    const next = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
  })

  it('a slow load outliving the invalidation record still refuses itself', async () => {
    const { load, finish, started } = slowLoad(OLD)
    const pending = cachedRules(TARGET, load)
    await started()
    await invalidateRuleCache(TARGET)
    advance(RULE_CACHE_TTL_MS + 1)
    finish()
    await pending

    const next = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('a read after the invalidation does not join the load from before it', async () => {
    const before = slowLoad(OLD)
    const pending = cachedRules(TARGET, before.load)
    await before.started()
    await invalidateRuleCache(TARGET)

    expect(await cachedRules(TARGET, async () => NEW)).toEqual(NEW)

    before.finish()
    await pending
    const next = vi.fn(async () => OLD)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
    expect(next).not.toHaveBeenCalled()
  })

  it('of two processes filling at once, one publishes, and an invalidation stops both', async () => {
    const other = await anotherProcess()
    const a = slowLoad(OLD)
    const b = slowLoad(OLD)
    const pending = [cachedRules(TARGET, a.load), other.cachedRules(TARGET, b.load)]
    await Promise.all([a.started(), b.started()])

    await other.invalidateRuleCache(TARGET)
    a.finish()
    b.finish()
    await Promise.all(pending)

    const next = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
  })
})

describe('invalidating every target', () => {
  it('retires every snapshot in every process at once', async () => {
    await cachedRules(TARGET, async () => OLD)
    await cachedRules(OTHER_TARGET, async () => OLD)
    const other = await anotherProcess()

    await other.invalidateRuleCache()

    const load = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, load)).toEqual(NEW)
    expect(await other.cachedRules(OTHER_TARGET, load)).toEqual(NEW)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('a load that read the old epoch can publish, and nobody reads what it published', async () => {
    const { load, finish, started } = slowLoad(OLD)
    const pending = cachedRules(TARGET, load)
    await started()

    await invalidateRuleCache()
    finish()
    await pending

    const next = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
    expect(next).toHaveBeenCalledTimes(1)
    expect(await cachedRules(TARGET, next)).toEqual(NEW)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('a read after it does not join a load from before it', async () => {
    const before = slowLoad(OLD)
    const pending = cachedRules(TARGET, before.load)
    await before.started()
    await invalidateRuleCache()

    expect(await cachedRules(TARGET, async () => NEW)).toEqual(NEW)

    before.finish()
    await pending
  })

  it('caches again under the new epoch', async () => {
    await invalidateRuleCache()
    const load = vi.fn(async () => NEW)
    await cachedRules(TARGET, load)
    await cachedRules(TARGET, load)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps the epoch record past any load, so absence cannot read as "never invalidated"', async () => {
    await invalidateRuleCache()
    const epoch = await appState().get(allTargetsEpochKey)
    advance(30 * 24 * 60 * 60_000)
    expect((await appState().get(allTargetsEpochKey))?.value.epoch).toBe(epoch?.value.epoch)
    expect(epoch?.expiresAt).toBeNull()
  })

  it('competing invalidations each retire what came before them', async () => {
    const other = await anotherProcess()
    await cachedRules(TARGET, async () => OLD)
    await Promise.all([invalidateRuleCache(), other.invalidateRuleCache(), invalidateRuleCache(TARGET)])
    const load = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, load)).toEqual(NEW)
  })
})

describe('when AppState fails', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('a failed invalidation does not throw, is logged, and the ceiling still holds', async () => {
    await cachedRules(TARGET, async () => OLD)
    vi.spyOn(appState(), 'set').mockRejectedValueOnce(new Error('AppState is down'))

    await expect(invalidateRuleCache(TARGET)).resolves.toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Could not invalidate'), expect.any(Error))

    const load = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, load)).toEqual(OLD)
    advance(RULE_CACHE_TTL_MS)
    expect(await cachedRules(TARGET, load)).toEqual(NEW)
  })

  it('an invalidation whose answer was lost landed anyway', async () => {
    await cachedRules(TARGET, async () => OLD)
    const set = appState().set.bind(appState())
    vi.spyOn(appState(), 'set').mockImplementationOnce(async (...args: Parameters<typeof set>) => {
      await set(...args)
      throw new Error('connection lost')
    })

    await expect(invalidateRuleCache(TARGET)).resolves.toBeUndefined()

    const load = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, load)).toEqual(NEW)
  })

  it('a hint that cannot be published takes nothing from the invalidation', async () => {
    await cachedRules(TARGET, async () => OLD)
    vi.spyOn(appState(), 'publish').mockRejectedValue(new Error('hints are down'))

    await expect(invalidateRuleCache(TARGET)).resolves.toBeUndefined()

    const load = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, load)).toEqual(NEW)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('hint'), expect.any(Error))
  })

  it('reads the database when the cache cannot answer', async () => {
    vi.spyOn(appState(), 'getMany').mockRejectedValue(new Error('AppState is down'))
    expect(await cachedRules(TARGET, async () => NEW)).toEqual(NEW)
    expect(console.warn).toHaveBeenCalled()
  })

  it('still answers from the database when a load cannot claim or publish', async () => {
    const claim = vi.spyOn(appState(), 'insertIfAbsent').mockRejectedValueOnce(new Error('AppState is down'))
    const noPublish = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, noPublish)).toEqual(NEW)
    claim.mockRestore()
    // Nothing to publish over, so nothing was published.
    const load = vi.fn(async () => OLD)
    expect(await cachedRules(TARGET, load)).toEqual(OLD)
    expect(load).toHaveBeenCalledTimes(1)

    vi.spyOn(appState(), 'compareAndSet').mockRejectedValueOnce(new Error('AppState is down'))
    expect(await cachedRules(OTHER_TARGET, async () => NEW)).toEqual(NEW)
  })

  it('reads the database rather than trust a stored record the schema refuses', async () => {
    const loose = defineNamespace({ name: 'cache:proxy-rules', consistency: 'strong', schema: z.unknown(), expiry: { ttlMs: 5_000, onUpdate: 'reset' } })
    await appState().set(loose.key(TARGET.kind, TARGET.targetId), { epoch: null, rules: [{ agentSlug: 3 }] })
    const load = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, load)).toEqual(NEW)
    expect(load).toHaveBeenCalled()
  })

  it('does not cache rows the schema refuses, and hands them to the caller', async () => {
    const malformed = [{ agentSlug: 3 }] as unknown as CachedRule[]
    expect(await cachedRules(TARGET, async () => malformed)).toEqual(malformed)
    const load = vi.fn(async () => NEW)
    expect(await cachedRules(TARGET, load)).toEqual(NEW)
  })
})

describe('hints', () => {
  async function listen(...parts: string[]) {
    const events: unknown[] = []
    await appState().subscribe([ruleChanges.channel(...parts)], (event) => { events.push(event) })
    return events
  }

  it('carries a revision and nothing else, on the target\'s channel', async () => {
    const events = await listen(TARGET.kind, TARGET.targetId)
    const others = await listen(OTHER_TARGET.kind, OTHER_TARGET.targetId)
    await invalidateRuleCache(TARGET)
    await backgroundSettled()
    expect(events).toEqual([{ revision: expect.any(String) }])
    expect(others).toEqual([])
  })

  it('announces an all-targets invalidation on its own channel', async () => {
    const events = await listen('all-targets')
    await invalidateRuleCache()
    await backgroundSettled()
    expect(events).toEqual([{ revision: expect.any(String) }])
  })
})
