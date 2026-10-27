/**
 * A page the agent opened: the host puts in a newer saved session of the
 * account this browser holds on the page's site (another agent signed in with
 * it since), through this container's session endpoints, before the agent
 * uses the page. The page is the agent's either way: a host that cannot be
 * reached, refuses, or takes too long leaves it as it is.
 */

/** A restore through a remote browser takes a few seconds; past this the agent goes on without it. */
const SESSION_SYNC_TIMEOUT_MS = 30_000

export async function syncSavedSession(sessionId: string, url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const hostAppUrl = process.env.HOST_APP_URL
  if (!hostAppUrl || !/^https?:\/\//i.test(url)) return false
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (process.env.PROXY_TOKEN) headers['Authorization'] = `Bearer ${process.env.PROXY_TOKEN}`
  try {
    const response = await fetchImpl(`${hostAppUrl}/api/browser/session-sync`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId, url }),
      signal: AbortSignal.timeout(SESSION_SYNC_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => null) as { restored?: unknown } | null
    return body?.restored === true
  } catch (error) {
    console.error('[Browser] Asking the host for a saved session failed:', error instanceof Error ? error.message : 'unknown error')
    return false
  }
}
