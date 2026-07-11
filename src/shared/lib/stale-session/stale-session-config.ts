/** Idle gap after which a returning user may be prompted. */
export const STALE_TIME_GAP_MS = 6 * 60 * 60 * 1000

/** Current context occupancy above which continuing the session is expensive. */
export const STALE_CONTEXT_TOKENS = 100_000
