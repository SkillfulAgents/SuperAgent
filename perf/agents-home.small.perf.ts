/**
 * Small profile: 5 agents × 50 sessions — the shape of a typical install.
 * Op counts are pinned exactly; wall budgets are ~2× the recorded value at
 * BUDGET_LATENCY_MS (see harness.ts) so runner jitter cannot trip them while
 * a serialised read path still can.
 */
import { defineHomeScenarios } from './home-scenarios'

// Sessions are listed from each agent's session index: a read stats the
// transcripts directory, never a transcript, and after a restart it lists
// the directory once more (one readdir per agent) to compare it with the
// index. Wall is bounded by the per-agent critical path, not the agent
// count: the agent list, artifact lookups and per-request DB reads overlap.
//
// Every workspace read goes through the actor's file operations, which cost
// exactly what the plain reads they replace cost: an existence probe is a
// stat where it used to be an access call, and nothing is added.
//
// The agent listing itself reads no workspace: which agents exist and what
// they are called comes from the `agents` table. The per-agent AGENTS.md
// read, the agents-directory listing and its existence probe that every
// listing used to pay are gone (7 ops here: 5 reads, 1 readdir, 1 probe),
// and resolving the `:id` of a session route no longer stats the agent's
// directory (1 op). These counts were re-pinned when that landed; a return
// to the old counts is a regression.
defineHomeScenarios('small', {
  agentsRestarted: { totalOps: 45, ops: { stat: 25, readdir: 10 }, wallMs: 160 },
  agentsWarm: { totalOps: 40, ops: { stat: 25, readdir: 5 }, wallMs: 160 },
  homeRestarted: { totalOps: 85, ops: { stat: 35, readdir: 10 }, wallMs: 280 },
  homeWarm: { totalOps: 75, ops: { stat: 30, readdir: 5 }, wallMs: 260 },
  sessionsPage: { totalOps: 1, ops: { stat: 1 }, wallMs: 70 },
  sessionsNotable: { totalOps: 0, ops: { stat: 0 }, wallMs: 40 },
})
