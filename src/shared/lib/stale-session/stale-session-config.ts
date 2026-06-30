// Tunable in code only (not user settings, not UI). Calibrate from real usage.
// See docs/superpowers/specs/2026-06-15-stale-session-prompt-design.md.

/** Idle gap after which a returning user is prompted. Default 6h. */
export const STALE_TIME_GAP_MS = 6 * 60 * 60 * 1000

/** Current context occupancy (tokens) above which the session is "expensive now".
 *  Only fires in combination with the idle gate (AND). */
export const STALE_CONTEXT_TOKENS = 100_000
