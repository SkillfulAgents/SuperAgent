import { apiFetch } from '@renderer/lib/api'

/**
 * Abandon a parked re-authentication request.
 *
 * A reauth card blocks every session of its agent, and only the connection's
 * owner can clear it by reconnecting — so for a connection someone else shared,
 * this is the sole way out short of the five-minute timeout. The parked agent
 * call fails with a "dismissed" status rather than a timeout, so it reads as a
 * decision rather than an invitation to retry.
 */
export async function dismissReauthRequest({
  agentSlug,
  requestId,
  reason,
}: {
  agentSlug: string
  requestId: string
  reason?: string
}): Promise<void> {
  const response = await apiFetch(
    `/api/agents/${agentSlug}/reauth-request/${requestId}/dismiss`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    },
  )
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown }
    throw new Error(
      typeof body.error === 'string' ? body.error : 'Failed to dismiss the request',
    )
  }
}
