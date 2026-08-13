export const MESSAGES_PAGE_MAX_LIMIT = 500
/** Renderer / API first-page default. Host can lower it with `MESSAGES_PAGE_LIMIT`. */
export const MESSAGES_PAGE_LIMIT = 300
/** Renderer / API scroll-up default. Host can lower it with `MESSAGES_PAGE_OLDER_LIMIT`. */
export const MESSAGES_PAGE_OLDER_LIMIT = 200

export function parseMessagesPageLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return fallback
  return Math.min(n, MESSAGES_PAGE_MAX_LIMIT)
}

export function getMessagesPageLimit(): number {
  return parseMessagesPageLimit(process.env.MESSAGES_PAGE_LIMIT, MESSAGES_PAGE_LIMIT)
}

export function getMessagesPageOlderLimit(): number {
  return parseMessagesPageLimit(process.env.MESSAGES_PAGE_OLDER_LIMIT, MESSAGES_PAGE_OLDER_LIMIT)
}

export function capMessagesPageLimit(requested: number | undefined, cursor?: string): number {
  const max = cursor ? getMessagesPageOlderLimit() : getMessagesPageLimit()
  return Math.min(requested ?? max, max)
}
