/**
 * Big profile: 1 agent × 5 000 sessions — a long-lived agent on a slow
 * volume, where per-transcript work dominates. Op counts are pinned exactly;
 * wall budgets are ~2× the recorded value at BUDGET_LATENCY_MS (see
 * harness.ts).
 */
import { defineHomeScenarios } from './home-scenarios'

// Sessions are listed from the agent's session index: a read stats the
// transcripts directory, never a transcript, and after a restart it lists
// the directory once more (one readdir) to compare it with the index. The
// 5 000 transcripts are statted once in the agent's life, by the first read
// that sees them (the harness's unmeasured warm-up here). Before the index a
// restart, and every five minutes after it, cost a stat of each: 5 018 ops
// and ten seconds for the agent list. Wall is bounded by the per-agent
// critical path: the agent list, artifact lookups and per-request DB reads
// overlap.
defineHomeScenarios('big', {
  // The actor's file operations cost exactly what the plain reads they
  // replace cost: an existence probe is a stat where it used to be an access
  // call, and nothing is added. The agent listing itself reads no workspace:
  // which agents exist and what they are called comes from the `agents`
  // table. The AGENTS.md read, the agents-directory listing and its
  // existence probe the listing used to pay are gone (3 ops here), and
  // resolving the `:id` of a session route no longer stats the agent's
  // directory (1 op). These counts were re-pinned when that landed; a
  // return to the old counts is a regression.
  // +1 readFile per agent on its actor's first use: a session-metadata.json still in the workspace is taken in.
  agentsRestarted: { totalOps: 13, ops: { stat: 7, readdir: 2 }, wallMs: 170 },
  agentsWarm: { totalOps: 11, ops: { stat: 7, readdir: 1 }, wallMs: 170 },
  homeRestarted: { totalOps: 20, ops: { stat: 9, readdir: 2 }, wallMs: 300 },
  homeWarm: { totalOps: 18, ops: { stat: 8, readdir: 1 }, wallMs: 280 },
  sessionsPage: { totalOps: 1, ops: { stat: 1 }, wallMs: 100 },
  sessionsNotable: { totalOps: 0, ops: { stat: 0 }, wallMs: 40 },
})
