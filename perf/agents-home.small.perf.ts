/**
 * Small profile: 5 agents × 50 sessions — the shape of a typical install.
 * Op counts are pinned exactly; wall budgets are ~2× the recorded value at
 * BUDGET_LATENCY_MS (see harness.ts) so runner jitter cannot trip them while
 * a serialised read path still can.
 */
import { defineHomeScenarios } from './home-scenarios'

// Cold reads still stat every transcript once to build the summary; warm
// reads (the iOS poll) and the sessions page come from the cache. Wall is
// bounded by the per-agent critical path, not the agent count: the agent
// list, artifact lookups and per-request DB reads overlap.
//
// Every workspace read goes through the actor's file operations, which check
// each path's real location against the workspace: one realpath per artifact
// listing and per manifest or widget probe (7 per agent here). The scan used
// to read those paths with no containment at all.
defineHomeScenarios('small', {
  agentsCold: { totalOps: 342, ops: { stat: 275, realpath: 35 }, wallMs: 240 },
  agentsWarm: { totalOps: 77, ops: { stat: 15, realpath: 35 }, wallMs: 110 },
  homeCold: { totalOps: 377, ops: { stat: 280, realpath: 35 }, wallMs: 370 },
  homeWarm: { totalOps: 112, ops: { stat: 20, realpath: 35 }, wallMs: 240 },
  sessionsPage: { totalOps: 3, ops: { stat: 2 }, wallMs: 70 },
  sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 40 },
})
