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
// Every workspace read goes through the actor's file operations, which cost
// what the plain reads they replace cost: an existence probe is a stat
// where it used to be an access call. The realpath calls are the artifact
// readers asking where the artifacts directory and each artifact really
// are, the link check the widget service always made; it used to make it
// synchronously (realpathSync, twice per path), which this harness does not
// count, and now asks the actor once per directory, which it does.
defineHomeScenarios('small', {
  agentsCold: { totalOps: 332, ops: { stat: 285, realpath: 15 }, wallMs: 240 },
  agentsWarm: { totalOps: 67, ops: { stat: 25, realpath: 15 }, wallMs: 160 },
  homeCold: { totalOps: 367, ops: { stat: 290, realpath: 15 }, wallMs: 370 },
  homeWarm: { totalOps: 102, ops: { stat: 30, realpath: 15 }, wallMs: 260 },
  sessionsPage: { totalOps: 3, ops: { stat: 2 }, wallMs: 70 },
  sessionsNotable: { totalOps: 1, ops: { stat: 1 }, wallMs: 40 },
})
