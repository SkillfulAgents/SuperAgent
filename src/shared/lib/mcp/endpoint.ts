/** Compare connection endpoints without account-specific query credentials. */
export function sameMcpEndpoint(first: string, second: string): boolean {
  try {
    const a = new URL(first)
    const b = new URL(second)
    return a.origin === b.origin && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '')
  } catch {
    return false
  }
}
