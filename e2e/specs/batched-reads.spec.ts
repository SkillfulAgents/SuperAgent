import { test, expect, type Page, type Request } from '@playwright/test'
import { createAgent, createSession, deleteAgentViaApi, uniqueName, waitForSessionIdle } from '../helpers/agents'
import { openHomeSection } from '../helpers/agent-home'
import { batchModuleOf } from '../../src/shared/lib/batched-reads'

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

/** The page's API requests: the batches it sent, and the reads it sent by themselves. */
function watchApiRequests(page: Page) {
  const sent: Request[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) sent.push(request)
  })
  const pathOf = (request: Request) => new URL(request.url()).pathname + new URL(request.url()).search
  return {
    batches: () => sent.filter((request) => pathOf(request) === '/api/batch-reads').map((request) => (request.postDataJSON() as { paths: string[] }).paths),
    loneReads: () => sent.filter((request) => request.method() === 'GET').map(pathOf),
  }
}

/** The module each batch carried: a batch never mixes two. */
const modulesOf = (batches: string[][]) => batches.map((paths) => [...new Set(paths.map(batchModuleOf))])

test.describe('reads sent together', () => {
  test('an agent page sends each module as one request and its main content read by read', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Batched reads'))
    try {
      await serveAsSpreadingServer(page, `/agents/${agent.slug}`)
      const requests = watchApiRequests(page)

      await page.goto(`/agents/${agent.slug}`)
      await openHomeSection(page, 'Triggers')
      await expect(page.getByText('No triggers yet')).toBeVisible()
      await openHomeSection(page, 'Skills')
      await expect(page.getByTestId('import-skill-button')).toBeVisible()

      const batches = requests.batches()
      expect(batches.find((paths) => paths.includes(`/api/agents/${agent.slug}/hooks`))).toEqual(expect.arrayContaining([
        `/api/agents/${agent.slug}/skills`,
        `/api/agents/${agent.slug}/mounts`,
        `/api/agents/${agent.slug}/webhook-triggers?status=active`,
      ]))
      expect(batches.find((paths) => paths.includes(`/api/agents/${agent.slug}/bookmarks`))).toContain(`/api/agents/${agent.slug}/widgets`)
      expect(modulesOf(batches).every((modules) => modules.length === 1)).toBe(true)
      expect(requests.loneReads()).toEqual(expect.arrayContaining([`/api/agents/${agent.slug}`, `/api/agents/${agent.slug}/sessions`]))
    } finally {
      await deleteAgentViaApi(request, agent)
    }
  })

  test('a session sends the message box options as one request and the session by itself', async ({ page, request }, testInfo) => {
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

      const batches = requests.batches()
      expect(batches.find((paths) => paths.includes(`/api/agents/${agent.slug}/sessions/${session.id}/llm-connections`))).toContain('/api/llm-connections')
      expect(modulesOf(batches).every((modules) => modules.length === 1)).toBe(true)
      expect(requests.loneReads()).toContain(`/api/agents/${agent.slug}/sessions/${session.id}`)
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
