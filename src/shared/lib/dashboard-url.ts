/**
 * Builders for the local dashboard-view / dashboard-iframe API paths.
 *
 * Each path segment (agentSlug, dashboardSlug) is URL-encoded independently via
 * encodeURIComponent so a slug containing a slash, space, or other
 * path-significant character can't break out of its segment (SUP-218).
 *
 * Mirrors the encoding already used by the deep-link launcher
 * (src/main/index.ts), the dashboard screenshot URL
 * (src/renderer/components/home/dashboard-card.tsx), and the server-side view
 * wrapper (src/api/routes/agents.ts).
 */

export function buildDashboardArtifactPath(agentSlug: string, dashboardSlug: string): string {
  return `/api/agents/${encodeURIComponent(agentSlug)}/artifacts/${encodeURIComponent(dashboardSlug)}/`
}

export function buildDashboardViewPath(agentSlug: string, dashboardSlug: string): string {
  return `${buildDashboardArtifactPath(agentSlug, dashboardSlug)}view`
}

/**
 * `apiBaseUrl` is an origin, and in cloud mode also the proxy prefix that
 * routes to the deployment — it is not always `http://localhost:<port>`. A
 * popout must be built from whichever Superagent the app is currently driving,
 * or it opens a same-named agent's dashboard on the wrong one.
 */
export function buildDashboardViewUrl(apiBaseUrl: string, agentSlug: string, dashboardSlug: string): string {
  return `${apiBaseUrl}${buildDashboardViewPath(agentSlug, dashboardSlug)}`
}
