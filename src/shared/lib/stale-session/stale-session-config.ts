// Tunable in code only (not user settings, not UI). Calibrate from real usage.
// See docs/superpowers/specs/2026-06-15-stale-session-prompt-design.md.

/** Idle gap after which a returning user is prompted. Default 6h. */
export const STALE_TIME_GAP_MS = 6 * 60 * 60 * 1000

/** Current context occupancy (tokens) above which the session is "expensive now".
 *  Only fires in combination with the idle gate (AND). */
export const STALE_CONTEXT_TOKENS = 100_000

/** Token budget for what we feed the summarizer (Haiku ~200k window minus headroom
 *  for the instruction + output). */
export const SUMMARY_INPUT_BUDGET_TOKENS = 150_000

/** Max output tokens for the summary generation. */
export const SUMMARY_MAX_TOKENS = 700

/** Leading sentence of the injected first message when a session is branched.
 *  Used to detect and split the carried-context block for display.
 *  Must stay in sync with buildBranchInitialMessage (the full first line has
 *  " The summary below covers the earlier context." appended). */
export const BRANCH_PREAMBLE_SENTINEL = 'This conversation is continued from a previous session.'

/** Summary output budget floor — the full balanced handoff for a normal session. */
export const SUMMARY_OUTPUT_FLOOR_TOKENS = 800

/** Summary output budget cap — only very large sessions stretch toward this. */
export const SUMMARY_OUTPUT_CAP_TOKENS = 2000

/** Output budget as a fraction of the (pruned) input, clamped to [floor, cap]. */
export const SUMMARY_OUTPUT_RATIO = 0.15
