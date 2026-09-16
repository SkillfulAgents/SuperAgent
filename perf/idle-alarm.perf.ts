/**
 * The idle alarm's decision: "am I idle past the timeout, and if so, sleep".
 * Every running container decides this for itself from an in-memory clock
 * (`ContainerRuntime.idleSince()`), so a decision reads nothing from disk —
 * the budget is zero operations, and a return to reading session metadata to
 * find out whether an agent is idle is a regression this file catches.
 *
 * Runs against the small profile with every seeded agent's (mock) container
 * started, then fires each alarm by hand. The harness pins `Date.now` to the
 * fixtures' BASE_TIME, so the containers' start marks equal "now" and nothing
 * is idle; the second scenario moves the clock past the timeout so every
 * container is stopped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { bootPerfApp, expectWithinBudget, measure, type PerfApp } from './harness'
import { BASE_TIME } from './fixtures'

const AUTO_SLEEP_TIMEOUT_MS = 30 * 60 * 1000

describe('idle alarm — small profile', () => {
  let perf: PerfApp
  let host: typeof import('@shared/lib/agent-actor').containerHost
  let registry: typeof import('@shared/lib/agent-actor').agentRegistry

  const fireAll = async () => {
    for (const slug of perf.seeded.agentSlugs) await host.runtime(slug).idleAlarm.fire()
  }

  beforeAll(async () => {
    perf = await bootPerfApp('small')
    ;({ containerHost: host, agentRegistry: registry } = await import('@shared/lib/agent-actor'))
    // Settings are read from disk once and cached for the process; that read
    // is the app's, not the alarm's, so pay it here.
    ;(await import('@shared/lib/config/settings')).getSettings()
    for (const slug of perf.seeded.agentSlugs) await registry.get(slug).container.start()
  })

  afterAll(async () => {
    await perf?.dispose()
  })

  it('decides for every running container without touching a file', async () => {
    expect(registry.running()).toHaveLength(perf.profile.agents)

    const { measurement } = await measure(fireAll)

    // Started "now": nobody is idle, everybody is still up and re-armed.
    expect(registry.running()).toHaveLength(perf.profile.agents)
    for (const slug of perf.seeded.agentSlugs) expect(host.runtime(slug).idleAlarm.isArmed()).toBe(true)
    expectWithinBudget('small: idle alarm (nothing idle)', measurement, { totalOps: 0, wallMs: 50 })
  })

  it('sleeps every container idle past the timeout without touching a file', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(BASE_TIME + AUTO_SLEEP_TIMEOUT_MS + 60_000)
    expect(registry.running()).toHaveLength(perf.profile.agents)

    const { measurement } = await measure(fireAll)

    expect(registry.running()).toHaveLength(0)
    for (const slug of perf.seeded.agentSlugs) expect(host.runtime(slug).idleAlarm.isArmed()).toBe(false)
    expectWithinBudget('small: idle alarm (all idle, all stopped)', measurement, { totalOps: 0, wallMs: 100 })
  })
})
