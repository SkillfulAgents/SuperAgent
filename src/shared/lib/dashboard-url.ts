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

export function buildDashboardViewUrl(port: number, agentSlug: string, dashboardSlug: string): string {
  return `http://localhost:${port}${buildDashboardViewPath(agentSlug, dashboardSlug)}`
}
