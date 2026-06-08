// MCP `mappedAt` can be a numeric-string epoch in ms; OAuth `createdAt` is
// an ISO string. The numeric branch only protects the MCP case.
export function safeDate(value: string | number): Date {
  if (typeof value === 'number') return new Date(value)
  const num = Number(value)
  return Number.isFinite(num) ? new Date(num) : new Date(value)
}

/**
 * Compact relative timestamp — e.g. "5m", "3h", "2d", "4w", "6mo", "2y".
 * Designed for dense row metadata where "5 minutes ago" is too long.
 */
export function formatCompactDistance(date: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - date.getTime())
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  const week = Math.floor(day / 7)
  if (week < 5) return `${week}w ago`
  const month = Math.floor(day / 30)
  if (month < 12) return `${month}mo ago`
  const year = Math.floor(day / 365)
  return `${year}y ago`
}
