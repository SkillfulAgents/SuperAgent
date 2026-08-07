import type { APIRequestContext, Page, Response } from '@playwright/test'

/**
 * Settings PUT blocks while any running agent is mid-turn. Parallel e2e
 * workers share one server, so clear busy agents before saving.
 */
export async function clearBusyAgentsForSettingsSave(
  request: APIRequestContext,
): Promise<void> {
  const agentsRes = await request.get('/api/agents')
  if (!agentsRes.ok()) return

  const agents = await agentsRes.json() as Array<{
    slug: string
    status: string
    hasActiveSessions?: boolean
  }>
  await Promise.all(
    agents
      .filter((agent) => agent.status === 'running' && agent.hasActiveSessions)
      .map((agent) => request.post(`/api/agents/${agent.slug}/stop`)),
  )
}

/** Wait for a PUT /api/settings request to complete successfully. */
export function waitForSettingsPutOk(page: Page): Promise<Response> {
  return page.waitForResponse(
    (res) =>
      res.url().includes('/api/settings') &&
      res.request().method() === 'PUT' &&
      res.ok(),
  )
}
