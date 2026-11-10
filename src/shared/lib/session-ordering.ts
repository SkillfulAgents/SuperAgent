export type SessionSortOrder = 'newest' | 'oldest'

export type SessionActivityFields = {
  id: string
  createdAt: Date | string
  lastActivityAt?: Date | string | null
  isAwaitingInput?: boolean
}

function dateTimestamp(value: Date | string | null | undefined): number {
  if (value == null) return Number.NaN
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

function sessionActivityTimestamp(session: SessionActivityFields): number {
  const lastActivity = dateTimestamp(session.lastActivityAt)
  if (Number.isFinite(lastActivity)) return lastActivity
  const created = dateTimestamp(session.createdAt)
  return Number.isFinite(created) ? created : Number.NEGATIVE_INFINITY
}

/**
 * Return a deterministically activity-ordered copy of a session list.
 *
 * Shared by the API and renderer so the sidebar and page lists cannot drift
 * on timestamp fallback or tie-breaking behavior.
 */
export function sortSessionsByActivity<T extends SessionActivityFields>(
  sessions: readonly T[],
  order: SessionSortOrder = 'newest',
  options: { awaitingFirst?: boolean } = {},
): T[] {
  return [...sessions].sort((a, b) => {
    if (options.awaitingFirst) {
      const awaiting = Number(!!b.isAwaitingInput) - Number(!!a.isAwaitingInput)
      if (awaiting !== 0) return awaiting
    }
    const aTimestamp = sessionActivityTimestamp(a)
    const bTimestamp = sessionActivityTimestamp(b)
    if (aTimestamp < bTimestamp) return order === 'newest' ? 1 : -1
    if (aTimestamp > bTimestamp) return order === 'newest' ? -1 : 1
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
}
