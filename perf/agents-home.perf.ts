/**
 * The iOS home page: `GET /api/agents?include_latest_visible_session_tail=true`
 * and the per-agent session lists it links to.
 *
 * Budgets are stated per fixture profile and are meant to be tightened in
 * the same PR as an optimisation — the diff is the before/after. Bump a budget
 * upward only with a reason in the commit message. Re-baseline with
 * `PERF_RECORD=1 npm run test:perf`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootPerfApp, expectWithinBudget, measure, type Budget, type PerfApp } from './harness'
import type { PROFILES } from './fixtures'

type ProfileName = keyof typeof PROFILES

interface ScenarioBudgets {
  agentsCold: Budget
  agentsWarm: Budget
  homeCold: Budget
  homeWarm: Budget
  sessionsPage: Budget
  sessionsNotable: Budget
}

// Baseline recorded on the pre-optimisation code (SUP-658 as shipped). Op
// counts are deterministic for a given fixture and are pinned exactly; wall
// budgets carry ~1.5x headroom over the recorded value at 2ms latency.
const BUDGETS: Record<ProfileName, ScenarioBudgets> = {
  small: {
    agentsCold: { totalOps: 319, ops: { stat: 276 }, wallMs: 80 },
    agentsWarm: { totalOps: 52, ops: { stat: 15 }, wallMs: 50 },
    homeCold: { totalOps: 632, ops: { stat: 550 }, wallMs: 110 },
    homeWarm: { totalOps: 367, ops: { stat: 290 }, wallMs: 100 },
    sessionsPage: { totalOps: 56, ops: { stat: 54 }, wallMs: 40 },
    sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 20 },
  },
  big: {
    agentsCold: { totalOps: 5023, ops: { stat: 5010 }, wallMs: 1720 },
    agentsWarm: { totalOps: 15, ops: { stat: 4 }, wallMs: 60 },
    homeCold: { totalOps: 10037, ops: { stat: 10017 }, wallMs: 1860 },
    homeWarm: { totalOps: 5031, ops: { stat: 5012 }, wallMs: 1780 },
    sessionsPage: { totalOps: 5009, ops: { stat: 5007 }, wallMs: 1740 },
    sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 20 },
  },
}

const HOME_URL = '/api/agents?include_latest_visible_session_tail=true'

describe.each(['small', 'big'] as ProfileName[])('iOS home page — %s profile', (profileName) => {
  let perf: PerfApp
  const budgets = BUDGETS[profileName]

  beforeAll(async () => {
    perf = await bootPerfApp(profileName)
  })

  afterAll(async () => {
    await perf?.dispose()
  })

  it('GET /api/agents — cold summary cache', async () => {
    perf.invalidateSummaryCaches()
    const { result, measurement } = await measure(() => perf.request('/api/agents'))
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body).toHaveLength(perf.profile.agents)
    expectWithinBudget(`${profileName}: GET /api/agents (cold)`, measurement, budgets.agentsCold)
  })

  it('GET /api/agents — warm summary cache', async () => {
    await perf.request('/api/agents')
    const { result, measurement } = await measure(() => perf.request('/api/agents'))
    expect(result.status).toBe(200)
    expectWithinBudget(`${profileName}: GET /api/agents (warm)`, measurement, budgets.agentsWarm)
  })

  it('home expansion — cold summary cache', async () => {
    perf.invalidateSummaryCaches()
    const { result, measurement } = await measure(() => perf.request(HOME_URL))
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body).toHaveLength(perf.profile.agents)
    // Correctness on a real filesystem: the route tests mock the service
    // layer, so this is the only place the whole chain is exercised end to end.
    for (const agent of body) {
      expect(agent.latestVisibleSession?.session?.id).toBe(perf.seeded.latestVisibleByAgent[agent.slug])
      expect(agent.latestVisibleSession.messageTail.messages.length).toBeGreaterThan(0)
      expect(agent.attentionOutsideLatest).toEqual({ hasUnreadNotification: false, hasPendingInput: false })
    }
    expectWithinBudget(`${profileName}: home expansion (cold)`, measurement, budgets.homeCold)
  })

  it('home expansion — warm summary cache (the iOS poll)', async () => {
    await perf.request(HOME_URL)
    const { result, measurement } = await measure(() => perf.request(HOME_URL))
    expect(result.status).toBe(200)
    expectWithinBudget(`${profileName}: home expansion (warm)`, measurement, budgets.homeWarm)
  })

  it('GET /api/agents/:id/sessions?sort_by=last_activity_at&limit=20', async () => {
    const slug = perf.seeded.agentSlugs[0]!
    await perf.request('/api/agents')
    const { result, measurement } = await measure(() =>
      perf.request(`/api/agents/${slug}/sessions?sort_by=last_activity_at&limit=20`),
    )
    expect(result.status).toBe(200)
    const body = await result.json()
    expect(body[0]?.id).toBe(perf.seeded.latestVisibleByAgent[slug])
    expect(body.length).toBeLessThanOrEqual(20)
    expectWithinBudget(`${profileName}: sessions page (limit 20)`, measurement, budgets.sessionsPage)
  })

  it('GET /api/agents/:id/sessions?notable=true', async () => {
    const slug = perf.seeded.agentSlugs[0]!
    const { result, measurement } = await measure(() =>
      perf.request(`/api/agents/${slug}/sessions?notable=true`),
    )
    expect(result.status).toBe(200)
    expectWithinBudget(`${profileName}: sessions notable`, measurement, budgets.sessionsNotable)
  })
})
