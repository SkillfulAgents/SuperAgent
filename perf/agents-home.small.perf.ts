/**
 * Small profile: 5 agents × 50 sessions — the shape of a typical install.
 * Op counts are pinned exactly; wall budgets are ~2× the recorded value at
 * BUDGET_LATENCY_MS (see harness.ts) so runner jitter cannot trip them while
 * a serialised read path still can.
 */
import { defineHomeScenarios } from './home-scenarios'

// Cold reads still stat every transcript once to build the summary; warm
// reads (the iOS poll) and the sessions page come from the cache.
defineHomeScenarios('small', {
  agentsCold: { totalOps: 317, ops: { stat: 275 }, wallMs: 320 },
  agentsWarm: { totalOps: 52, ops: { stat: 15 }, wallMs: 290 },
  homeCold: { totalOps: 352, ops: { stat: 280 }, wallMs: 450 },
  homeWarm: { totalOps: 87, ops: { stat: 20 }, wallMs: 320 },
  sessionsPage: { totalOps: 3, ops: { stat: 2 }, wallMs: 70 },
  sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 40 },
})
