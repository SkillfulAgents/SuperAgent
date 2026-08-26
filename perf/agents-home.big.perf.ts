/**
 * Big profile: 1 agent × 5 000 sessions — a long-lived agent on a slow
 * volume, where per-transcript work dominates. Op counts are pinned exactly;
 * wall budgets are ~2× the recorded value at BUDGET_LATENCY_MS (see
 * harness.ts).
 */
import { defineHomeScenarios } from './home-scenarios'

// Baseline recorded on the pre-optimisation code (SUP-658 as shipped).
defineHomeScenarios('big', {
  agentsCold: { totalOps: 5021, ops: { stat: 5009 }, wallMs: 10_400 },
  agentsWarm: { totalOps: 15, ops: { stat: 4 }, wallMs: 280 },
  homeCold: { totalOps: 10037, ops: { stat: 10017 }, wallMs: 10_700 },
  homeWarm: { totalOps: 5031, ops: { stat: 5012 }, wallMs: 10_700 },
  sessionsPage: { totalOps: 5009, ops: { stat: 5007 }, wallMs: 10_400 },
  sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 40 },
})
