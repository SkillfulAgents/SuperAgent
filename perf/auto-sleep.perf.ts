/**
 * The auto-sleep sweep: once a minute, for every running agent, "how long
 * idle?" and, past the timeout, stop. The answer is the actor's in-memory
 * clock (`container.idleSince()`), so a sweep reads nothing from disk however
 * many agents are up — the budget is zero operations, and a return to
 * listing sessions per tick (one metadata read per running agent per minute)
 * is a regression this file catches.
 *
 * Runs against the small profile with every seeded agent's (mock) container
 * started. The harness pins `Date.now` to the fixtures' BASE_TIME, so the
 * agents' start times equal "now" and nothing is idle; the second scenario
 * moves the clock past the timeout so every agent is stopped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootPerfApp, expectWithinBudget, measure, type PerfApp } from './harness'
import { BASE_TIME } from './fixtures'

const AUTO_SLEEP_TIMEOUT_MS = 30 * 60 * 1000

describe('auto-sleep sweep — small profile', () => {
  let perf: PerfApp
  let registry: typeof import('@shared/lib/agent-actor').agentRegistry
  let monitor: typeof import('@shared/lib/scheduler/auto-sleep-monitor').autoSleepMonitor

  beforeAll(async () => {
    perf = await bootPerfApp('small')
    registry = (await import('@shared/lib/agent-actor')).agentRegistry
    monitor = (await import('@shared/lib/scheduler/auto-sleep-monitor')).autoSleepMonitor
    // Settings are read from disk once and cached for the process; that read
    // is the app's, not the sweep's, so pay it here.
    ;(await import('@shared/lib/config/settings')).getSettings()
    for (const slug of perf.seeded.agentSlugs) await registry.get(slug).container.start()
  })

  afterAll(async () => {
    await perf?.dispose()
  })

  it('decides for every running agent without touching a file', async () => {
    expect(registry.running()).toHaveLength(perf.profile.agents)

    const { measurement } = await measure(() => monitor.sweep())

    // Started "now": nobody is idle, everybody is still up.
    expect(registry.running()).toHaveLength(perf.profile.agents)
    expectWithinBudget('small: auto-sleep sweep (nothing idle)', measurement, { totalOps: 0, wallMs: 50 })
  })

  it('stops every agent idle past the timeout without touching a file', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(BASE_TIME + AUTO_SLEEP_TIMEOUT_MS + 60_000)
    expect(registry.running()).toHaveLength(perf.profile.agents)

    const { measurement } = await measure(() => monitor.sweep())

    expect(registry.running()).toHaveLength(0)
    expectWithinBudget('small: auto-sleep sweep (all idle, all stopped)', measurement, { totalOps: 0, wallMs: 100 })
  })
})
