/**
 * Big profile: 1 agent × 5 000 sessions — a long-lived agent on a slow
 * volume, where per-transcript work dominates. Op counts are pinned exactly;
 * wall budgets are ~2× the recorded value at BUDGET_LATENCY_MS (see
 * harness.ts).
 */
import { defineHomeScenarios } from './home-scenarios'

// Cold reads still stat every transcript once to build the summary; warm
// reads (the iOS poll) and the sessions page come from the cache. Wall is
// bounded by the per-agent critical path: the agent list, artifact lookups
// and per-request DB reads overlap.
defineHomeScenarios('big', {
  // The actor's file operations cost what the plain reads they replace cost:
  // an existence probe is a stat where it used to be an access call. The
  // realpath calls are the artifact readers' link check (see the small
  // profile), asynchronous and counted where it used to be synchronous.
  agentsCold: { totalOps: 5025, ops: { stat: 5012, realpath: 4 }, wallMs: 10_400 },
  agentsWarm: { totalOps: 19, ops: { stat: 7, realpath: 4 }, wallMs: 170 },
  homeCold: { totalOps: 5032, ops: { stat: 5013, realpath: 4 }, wallMs: 10_500 },
  homeWarm: { totalOps: 26, ops: { stat: 8, realpath: 4 }, wallMs: 280 },
  sessionsPage: { totalOps: 3, ops: { stat: 2 }, wallMs: 100 },
  sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 40 },
})
