/** Best-effort container → host events that keep renderer caches precise. */
async function postHostEvent(event: string, body: Record<string, unknown>): Promise<boolean> {
  const baseUrl = process.env.SUPERAGENT_HOST_API_URL
  const token = process.env.PROXY_TOKEN
  const agentSlug = process.env.SUPERAGENT_AGENT_SLUG
  if (!baseUrl || !token || !agentSlug) return false

  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/agent-bootstrap/${encodeURIComponent(agentSlug)}/events/${event}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
  )
  if (!response.ok) {
    throw new Error(`Host rejected ${event} event (HTTP ${response.status})`)
  }
  return true
}

export async function notifyDashboardScreenshotReady(dashboardSlug: string): Promise<boolean> {
  return postHostEvent('dashboard-screenshot-ready', { dashboardSlug })
}

/**
 * Terminal dashboard startup transitions ('running' | 'crashed'), pushed so
 * the renderer flips the moment a dashboard is serveable instead of waiting
 * out its artifacts-poll interval. Intermediate states stay poll-only.
 */
export async function notifyDashboardStatusChanged(
  dashboardSlug: string,
  status: 'running' | 'crashed',
): Promise<boolean> {
  return postHostEvent('dashboard-status-changed', { dashboardSlug, status })
}
