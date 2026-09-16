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
// exactly what the plain reads they replace cost: an existence probe is a
// stat where it used to be an access call, and nothing is added.
//
// The agent listing itself reads no workspace: which agents exist and what
// they are called comes from the `agents` table. The per-agent CLAUDE.md
// read, the agents-directory listing and its existence probe that every
// listing used to pay are gone (7 ops here: 5 reads, 1 readdir, 1 probe),
// and resolving the `:id` of a session route no longer stats the agent's
// directory (1 op). These counts were re-pinned when that landed; a return
// to the old counts is a regression.
defineHomeScenarios('small', {
  agentsCold: { totalOps: 310, ops: { stat: 285 }, wallMs: 240 },
  agentsWarm: { totalOps: 45, ops: { stat: 25 }, wallMs: 160 },
  homeCold: { totalOps: 345, ops: { stat: 290 }, wallMs: 370 },
  homeWarm: { totalOps: 80, ops: { stat: 30 }, wallMs: 260 },
  sessionsPage: { totalOps: 2, ops: { stat: 1 }, wallMs: 70 },
  sessionsNotable: { totalOps: 0, ops: { stat: 0 }, wallMs: 40 },
})
