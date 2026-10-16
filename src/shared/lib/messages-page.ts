export const MESSAGES_PAGE_MAX_LIMIT = 500
/** Renderer first-page request. Host env `MESSAGES_PAGE_LIMIT` can lower the actual page (1–500). */
export const MESSAGES_PAGE_LIMIT = 300
/** Renderer scroll-up request. Host env `MESSAGES_PAGE_OLDER_LIMIT` can lower the actual page (1–500). */
export const MESSAGES_PAGE_OLDER_LIMIT = 200

/**
 * Bounds of `max_bytes`, a page request's soft budget on the raw transcript
 * bytes behind the page. The upper bound is the server's own default budget,
 * which a request without `max_bytes` gets: a client can make its page
 * cheaper than that, never dearer. The lower bound keeps a page from shrinking
 * to a couple of items, which would turn reading history into hundreds of
 * requests that each pay their own transcript scan.
 */
export const MESSAGES_PAGE_MIN_BYTES = 64 * 1024
export const MESSAGES_PAGE_MAX_BYTES = 4 * 1024 * 1024

/**
 * Renderer trailing-page budget (`max_bytes`). A quarter of the server
 * default: the trailing page is re-read on open and every minute while a
 * session is open, and a long session's newest MiB is usually several
 * screens — when it is not (a few heavy turns), the message list fills the
 * viewport from older pages.
 */
export const MESSAGES_PAGE_BYTES = 1024 * 1024

function envLimit(name: string, fallback: number): number {
  const n = Number(process.env[name])
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, MESSAGES_PAGE_MAX_LIMIT)
}

export function capMessagesPageLimit(requested: number | undefined, cursor?: string): number {
  const max = cursor
    ? envLimit('MESSAGES_PAGE_OLDER_LIMIT', MESSAGES_PAGE_OLDER_LIMIT)
    : envLimit('MESSAGES_PAGE_LIMIT', MESSAGES_PAGE_LIMIT)
  return Math.min(requested ?? max, max)
}

/**
 * A requested `max_bytes` as the page reader's byte budget, clamped into
 * [MESSAGES_PAGE_MIN_BYTES, MESSAGES_PAGE_MAX_BYTES]. Absent stays absent: the
 * reader then applies its default, exactly as for a request that predates
 * the parameter.
 */
export function clampMessagesPageBytes(requested: number | undefined): number | undefined {
  if (requested === undefined) return undefined
  return Math.min(MESSAGES_PAGE_MAX_BYTES, Math.max(MESSAGES_PAGE_MIN_BYTES, requested))
}
