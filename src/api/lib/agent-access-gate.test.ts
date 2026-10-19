import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalFeedEvent } from '@shared/lib/notifications/global-feed'
import { ACCESS_RECHECK_MS, createAgentAccessGate } from './agent-access-gate'

/** Loads the test answers by hand, in the order they were started. */
function manualLoads() {
  const pending: Array<{ resolve: (slugs: string[]) => void; reject: (error: unknown) => void }> = []
  return {
    load: vi.fn(
      () =>
        new Promise<string[]>((resolve, reject) => {
          pending.push({ resolve, reject })
        }),
    ),
    /** Answer the oldest load still in flight and let the gate act on it. */
    async answer(slugs: string[]) {
      pending.shift()!.resolve(slugs)
      await flush()
    },
    async fail(error: unknown) {
      pending.shift()!.reject(error)
      await flush()
    },
    get inFlight() {
      return pending.length
    },
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const gates: Array<{ dispose(): void }> = []
afterEach(() => {
  for (const gate of gates.splice(0)) gate.dispose()
})

function setup(options: { deliver?: (event: GlobalFeedEvent) => void; recheckEveryMs?: number } = {}) {
  const loads = manualLoads()
  const delivered: GlobalFeedEvent[] = []
  const onLoadError = vi.fn()
  const gate = createAgentAccessGate({
    load: loads.load,
    deliver: (e) => {
      options.deliver?.(e)
      delivered.push(e)
    },
    onLoadError,
    recheckEveryMs: options.recheckEveryMs,
  })
  gates.push(gate)
  return { gate, loads, delivered, onLoadError }
}

const about = (agentSlug: string, n = 0): GlobalFeedEvent => ({ type: 'session_active', agentSlug, n })
const general = (n = 0): GlobalFeedEvent => ({ type: 'runtime_readiness_changed', n })

describe('createAgentAccessGate', () => {
  it('holds everything until the first load, then releases it in order', async () => {
    const { gate, loads, delivered } = setup()
    expect(loads.load).toHaveBeenCalledTimes(1)

    gate.push(about('mine', 1))
    gate.push(about('theirs', 2))
    gate.push(general(3))
    expect(delivered).toEqual([])

    await loads.answer(['mine'])
    expect(delivered).toEqual([about('mine', 1), general(3)])
  })

  it('judges events synchronously once loaded', async () => {
    const { gate, loads, delivered } = setup()
    await loads.answer(['mine'])

    gate.push(about('mine', 1))
    expect(delivered).toEqual([about('mine', 1)])
    gate.push(about('theirs', 2))
    gate.push(general(3))
    expect(delivered).toEqual([about('mine', 1), general(3)])
    expect(loads.load).toHaveBeenCalledTimes(1)
  })

  it('judges events that arrive during a refresh by its result', async () => {
    const { gate, loads, delivered } = setup()
    await loads.answer(['old'])

    gate.refresh()
    gate.push(about('old', 1))
    gate.push(about('new', 2))
    expect(delivered).toEqual([])

    await loads.answer(['new'])
    expect(delivered).toEqual([about('new', 2)])
  })

  it('loads again when a refresh is asked for while a load is reading', async () => {
    const { gate, loads, delivered } = setup()
    gate.push(about('shared', 1))
    // The share lands after the first load started reading: its answer may predate it.
    gate.refresh()
    expect(loads.load).toHaveBeenCalledTimes(1)

    await loads.answer([])
    expect(delivered).toEqual([])
    expect(loads.load).toHaveBeenCalledTimes(2)

    await loads.answer(['shared'])
    expect(delivered).toEqual([about('shared', 1)])
  })

  it('reloads on agent_created and judges that event against the reload', async () => {
    const { gate, loads, delivered } = setup()
    await loads.answer([])

    const created: GlobalFeedEvent = { type: 'agent_created', agentSlug: 'fresh' }
    gate.push(created)
    gate.push(about('fresh', 1))
    expect(loads.load).toHaveBeenCalledTimes(2)
    expect(delivered).toEqual([])

    await loads.answer(['fresh'])
    expect(delivered).toEqual([created, about('fresh', 1)])
  })

  it('drops another user\'s new agent after the reload', async () => {
    const { gate, loads, delivered } = setup()
    await loads.answer([])

    gate.push({ type: 'agent_created', agentSlug: 'someone-elses' })
    gate.push(general(1))
    await loads.answer([])
    expect(delivered).toEqual([general(1)])
  })

  it('reports a failed load and stops carrying agent events', async () => {
    const { gate, loads, delivered, onLoadError } = setup()
    gate.push(about('mine', 1))
    gate.push(general(2))

    const error = new Error('database is locked')
    await loads.fail(error)
    expect(onLoadError).toHaveBeenCalledWith(error)
    expect(delivered).toEqual([general(2)])

    gate.push(about('mine', 3))
    expect(delivered).toEqual([general(2)])
  })

  it('recovers from a failed load on the next refresh', async () => {
    const { gate, loads, delivered } = setup()
    await loads.fail(new Error('database is locked'))

    gate.refresh()
    await loads.answer(['mine'])
    gate.push(about('mine', 1))
    expect(delivered).toEqual([about('mine', 1)])
  })

  it('delivers nothing once disposed, even when a load lands afterwards', async () => {
    const { gate, loads, delivered, onLoadError } = setup()
    gate.push(about('mine', 1))
    gate.dispose()

    await loads.answer(['mine'])
    gate.push(about('mine', 2))
    gate.refresh()
    expect(delivered).toEqual([])
    expect(loads.inFlight).toBe(0)
    expect(onLoadError).not.toHaveBeenCalled()
  })

  it('does not report a load that fails after dispose', async () => {
    const { gate, loads, onLoadError } = setup()
    gate.dispose()
    await loads.fail(new Error('connection closed'))
    expect(onLoadError).not.toHaveBeenCalled()
  })
  it('keeps releasing held events when one delivery throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { gate, loads, delivered } = setup({
      deliver: (event) => {
        if (event.n === 1) throw new Error('stream closed')
      },
    })
    gate.push(about('a', 1))
    gate.push(about('a', 2))
    gate.push(general(3))

    await loads.answer(['a'])

    // The throwing write is reported; the events after it still go out.
    expect(delivered.map((e) => e.n)).toEqual([2, 3])
    expect(consoleError).toHaveBeenCalledOnce()
    consoleError.mockRestore()
  })

  it('loads again on its own period, so a missed membership notice is picked up', async () => {
    vi.useFakeTimers()
    try {
      const { gate, loads, delivered } = setup({ recheckEveryMs: 1000 })
      const answer = async (slugs: string[]) => {
        const answered = loads.answer(slugs)
        await vi.advanceTimersByTimeAsync(0)
        await answered
      }
      await answer(['a'])
      gate.push(about('b'))
      expect(delivered).toEqual([])
      expect(loads.inFlight).toBe(0)

      // The user was added to b, but the notice never reached this stream.
      await vi.advanceTimersByTimeAsync(1000)
      expect(loads.inFlight).toBe(1)
      await answer(['a', 'b'])
      gate.push(about('b', 1))

      expect(delivered.map((e) => e.n)).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops re-checking once disposed', async () => {
    vi.useFakeTimers()
    try {
      const { gate, loads } = setup({ recheckEveryMs: 1000 })
      const answered = loads.answer(['a'])
      await vi.advanceTimersByTimeAsync(0)
      await answered
      gate.dispose()
      loads.load.mockClear()

      await vi.advanceTimersByTimeAsync(5000)

      expect(loads.load).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-checks every minute by default', () => {
    expect(ACCESS_RECHECK_MS).toBe(60_000)
  })
})
