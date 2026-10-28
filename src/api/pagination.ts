const DEFAULT_PAGE_LIMIT = 20
const MAX_PAGE_LIMIT = 100

export function parsePagination(
  rawOffset: string | undefined,
  rawLimit: string | undefined,
) {
  const parsedOffset = Number.parseInt(rawOffset ?? '0', 10)
  const parsedLimit = Number.parseInt(rawLimit ?? String(DEFAULT_PAGE_LIMIT), 10)

  return {
    offset: Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : 0,
    limit: Number.isFinite(parsedLimit)
      ? Math.min(MAX_PAGE_LIMIT, Math.max(1, parsedLimit))
      : DEFAULT_PAGE_LIMIT,
  }
}
