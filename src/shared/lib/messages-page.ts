export const MESSAGES_PAGE_MAX_LIMIT = 500
/** Renderer first-page request. Host env `MESSAGES_PAGE_LIMIT` can lower the actual page (1–500). */
export const MESSAGES_PAGE_LIMIT = 300
/** Renderer scroll-up request. Host env `MESSAGES_PAGE_OLDER_LIMIT` can lower the actual page (1–500). */
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
