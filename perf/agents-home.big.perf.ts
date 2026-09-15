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
  // The actor's file operations cost exactly what the plain reads they
  // replace cost: an existence probe is a stat where it used to be an access
  // call, and nothing is added. The agent listing itself reads no workspace:
  // which agents exist and what they are called comes from the `agents`
  // table. The CLAUDE.md read, the agents-directory listing and its
  // existence probe the listing used to pay are gone (3 ops here), and
  // resolving the `:id` of a session route no longer stats the agent's
  // directory (1 op). These counts were re-pinned when that landed; a
  // return to the old counts is a regression.
  agentsCold: { totalOps: 5018, ops: { stat: 5012 }, wallMs: 10_400 },
  agentsWarm: { totalOps: 12, ops: { stat: 7 }, wallMs: 170 },
  homeCold: { totalOps: 5025, ops: { stat: 5013 }, wallMs: 10_500 },
  homeWarm: { totalOps: 19, ops: { stat: 8 }, wallMs: 280 },
  sessionsPage: { totalOps: 2, ops: { stat: 1 }, wallMs: 100 },
  sessionsNotable: { totalOps: 0, ops: { stat: 0 }, wallMs: 40 },
})
