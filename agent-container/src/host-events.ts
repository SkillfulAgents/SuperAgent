/** Best-effort container → host events that keep renderer caches precise. */
export async function notifyDashboardScreenshotReady(dashboardSlug: string): Promise<boolean> {
  const baseUrl = process.env.SUPERAGENT_HOST_API_URL
  const token = process.env.PROXY_TOKEN
  const agentSlug = process.env.SUPERAGENT_AGENT_SLUG
  if (!baseUrl || !token || !agentSlug) return false

  const response = await fetch(
    `${baseUrl.replace(/\/$/, '')}/agent-bootstrap/${encodeURIComponent(agentSlug)}/events/dashboard-screenshot-ready`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ dashboardSlug }),
    },
  )
  if (!response.ok) {
    throw new Error(`Host rejected dashboard screenshot event (HTTP ${response.status})`)
  }
  return true
}
