import { test, expect, type Page, type Request } from '@playwright/test'
import { createAgent, createSession, deleteAgentViaApi, uniqueName, waitForSessionIdle } from '../helpers/agents'
import { openHomeSection } from '../helpers/agent-home'

/**
 * Serves the app as a server that spreads its requests would: the fact is added to the facts in the HTML,
 * which is where a page reads them. The test server itself answers every request in one process.
 */
async function serveAsSpreadingServer(page: Page, pagePath: string): Promise<void> {
  await page.route(`**${pagePath}`, async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback()
    const response = await route.fetch()
    const html = (await response.text()).replace(/(<script type="application\/json" id="server-facts">)\{/, '$1{"spreadsRequests":true,')
    await route.fulfill({ response, body: html })
  })
}

/** The page's API requests, and the most it had open at once. A stream stays open, so it is not counted. */
function watchApiRequests(page: Page) {
  const sent: Request[] = []
  const open = new Set<Request>()
  let mostOpen = 0
  const isApiCall = (request: Request) => new URL(request.url()).pathname.startsWith('/api/') && !request.url().includes('/stream')
  page.on('request', (request) => {
    if (!isApiCall(request)) return
    sent.push(request)
    open.add(request)
    mostOpen = Math.max(mostOpen, open.size)
  })
  page.on('requestfinished', (request) => open.delete(request))
  page.on('requestfailed', (request) => open.delete(request))
  const pathOf = (request: Request) => new URL(request.url()).pathname + new URL(request.url()).search
  return {
    batches: () => sent.filter((request) => pathOf(request) === '/api/batch-reads').map((request) => (request.postDataJSON() as { paths: string[] }).paths),
    loneReads: () => sent.filter((request) => request.method() === 'GET').map(pathOf),
    mostOpen: () => mostOpen,
  }
}

test.describe('reads sent together', () => {
  test('an agent page opens with a few requests at once, and shows what its reads returned', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Batched reads'))
    try {
      await serveAsSpreadingServer(page, `/agents/${agent.slug}`)
      const requests = watchApiRequests(page)

      await page.goto(`/agents/${agent.slug}`)
      await openHomeSection(page, 'Triggers')
      await expect(page.getByText('No triggers yet')).toBeVisible()
      await openHomeSection(page, 'Skills')
      await expect(page.getByTestId('import-skill-button')).toBeVisible()

      expect(requests.batches().flat()).toEqual(expect.arrayContaining([
        `/api/agents/${agent.slug}`,
        `/api/agents/${agent.slug}/sessions`,
        `/api/agents/${agent.slug}/skills`,
        `/api/agents/${agent.slug}/webhook-triggers?status=active`,
        '/api/user-settings',
      ]))
      expect(requests.mostOpen()).toBeLessThanOrEqual(5)
    } finally {
      await deleteAgentViaApi(request, agent)
    }
  })

  test('a session opens with a few requests at once, and shows its messages', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Batched session'))
    try {
      const session = await createSession(request, agent, 'Say hello')
      await waitForSessionIdle(request, agent, session)
      const sessionPath = `/agents/${agent.slug}/sessions/${session.id}`
      await serveAsSpreadingServer(page, sessionPath)
      const requests = watchApiRequests(page)

      await page.goto(sessionPath)
      await expect(page.getByTestId('message-list')).toContainText('Say hello')
      await expect(page.getByTestId('message-input')).toBeVisible()

      expect(requests.batches().flat()).toEqual(expect.arrayContaining([
        `/api/agents/${agent.slug}/sessions/${session.id}`,
        `/api/agents/${agent.slug}/sessions/${session.id}/llm-connections`,
      ]))
      expect(requests.mostOpen()).toBeLessThanOrEqual(5)
    } finally {
      await deleteAgentViaApi(request, agent)
    }
  })

  test('a server that did not ask gets every read by itself', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Lone reads'))
    try {
      const requests = watchApiRequests(page)

      await page.goto(`/agents/${agent.slug}`)
      await openHomeSection(page, 'Triggers')
      await expect(page.getByText('No triggers yet')).toBeVisible()

      expect(requests.batches()).toEqual([])
      expect(requests.loneReads()).toContain(`/api/agents/${agent.slug}/webhook-triggers?status=active`)
    } finally {
      await deleteAgentViaApi(request, agent)
    }
  })
})
