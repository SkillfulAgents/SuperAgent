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
  // One realpath for the agent's CLAUDE.md, per artifact listing and per manifest probe: the actor's
  // file operations check each path's real location against the workspace.
  agentsCold: { totalOps: 5029, ops: { stat: 5009, realpath: 11 }, wallMs: 10_400 },
  agentsWarm: { totalOps: 23, ops: { stat: 4, realpath: 11 }, wallMs: 240 },
  homeCold: { totalOps: 5036, ops: { stat: 5010, realpath: 11 }, wallMs: 10_500 },
  homeWarm: { totalOps: 30, ops: { stat: 5, realpath: 11 }, wallMs: 330 },
  sessionsPage: { totalOps: 3, ops: { stat: 2 }, wallMs: 100 },
  sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 40 },
})
