// MCP `mappedAt` can be a numeric-string epoch in ms; OAuth `createdAt` is
// an ISO string. The numeric branch only protects the MCP case.
export function safeDate(value: string | number): Date {
  if (typeof value === 'number') return new Date(value)
  const num = Number(value)
  return Number.isFinite(num) ? new Date(num) : new Date(value)
}
