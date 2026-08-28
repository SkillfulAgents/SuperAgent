/**
 * The iOS home page: `GET /api/agents?include_latest_visible_session_tail=true`
 * and the per-agent session lists it links to.
 *
 * One `*.perf.ts` file per fixture profile calls `defineHomeScenarios`. Each
 * file runs in its own fork (the perf config uses the forks pool with
 * isolation), so profiles never share the sqlite singleton, the ownership
 * index, or any module state, and a scenario's numbers cannot depend on
 * what ran before it.
 *
 * Budgets are stated per profile and are meant to be tightened in the same PR
 * as an optimisation — the diff is the before/after. Bump a budget upward only
 * with a reason in the commit message. Re-baseline with
 * `PERF_RECORD=1 npm run test:perf`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootPerfApp, expectWithinBudget, measure, type Budget, type PerfApp } from './harness'
import type { PROFILES } from './fixtures'

export type ProfileName = keyof typeof PROFILES

export interface HomeScenarioBudgets {
  agentsCold: Budget
  agentsWarm: Budget
  homeCold: Budget
  homeWarm: Budget
  sessionsPage: Budget
  sessionsNotable: Budget
}

const HOME_URL = '/api/agents?include_latest_visible_session_tail=true'

export function defineHomeScenarios(profileName: ProfileName, budgets: HomeScenarioBudgets): void {
  describe(`iOS home page — ${profileName} profile`, () => {
    let perf: PerfApp

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
      await perf.request('/api/agents')
      const { result, measurement } = await measure(() =>
        perf.request(`/api/agents/${slug}/sessions?notable=true`),
      )
      expect(result.status).toBe(200)
      expectWithinBudget(`${profileName}: sessions notable`, measurement, budgets.sessionsNotable)
    })
  })
}
