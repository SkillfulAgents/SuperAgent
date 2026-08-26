/**
 * Small profile: 5 agents × 50 sessions — the shape of a typical install.
 * Op counts are pinned exactly; wall budgets are ~2× the recorded value at
 * BUDGET_LATENCY_MS (see harness.ts) so runner jitter cannot trip them while
 * a serialised read path still can.
 */
import { defineHomeScenarios } from './home-scenarios'

// Baseline recorded on the pre-optimisation code (SUP-658 as shipped).
defineHomeScenarios('small', {
  agentsCold: { totalOps: 317, ops: { stat: 275 }, wallMs: 320 },
  agentsWarm: { totalOps: 52, ops: { stat: 15 }, wallMs: 290 },
  homeCold: { totalOps: 632, ops: { stat: 550 }, wallMs: 520 },
  homeWarm: { totalOps: 367, ops: { stat: 290 }, wallMs: 500 },
  sessionsPage: { totalOps: 56, ops: { stat: 54 }, wallMs: 220 },
  sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 40 },
})
