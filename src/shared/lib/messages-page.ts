export const MESSAGES_PAGE_MAX_LIMIT = 500
/** Renderer first-page request. Host can lower the actual page with `MESSAGES_PAGE_LIMIT`. */
export const MESSAGES_PAGE_LIMIT = 300
/** Renderer scroll-up request. Host can lower the actual page with `MESSAGES_PAGE_OLDER_LIMIT`. */
export const MESSAGES_PAGE_OLDER_LIMIT = 200

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
