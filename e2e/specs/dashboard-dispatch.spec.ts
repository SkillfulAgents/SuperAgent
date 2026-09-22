import { test, expect, type Page } from '@playwright/test'
import fs from 'fs'
import path from 'path'

// The mock container reports dashboards that exist under the agent's
// workspace artifacts dir as running, so seeding one lets the standalone
// /view wrapper reach its iframe state.
function seedDashboard(agentSlug: string) {
  const dataDir = process.env.SUPERAGENT_DATA_DIR
  if (!dataDir) throw new Error('SUPERAGENT_DATA_DIR is required for dashboard seeding')
  const dashboardDir = path.join(dataDir, 'agents', agentSlug, 'workspace', 'artifacts', 'test-dashboard')
  fs.mkdirSync(dashboardDir, { recursive: true })
  fs.writeFileSync(
    path.join(dashboardDir, 'package.json'),
    JSON.stringify({ name: 'Test Dashboard', version: '1.0.0' })
  )
}

// The provenance fields are metadata-only (not projected into the session
// API), so assert against the persisted per-agent metadata map itself.
function readSessionMetadata(agentSlug: string): Record<string, Record<string, unknown>> {
  const dataDir = process.env.SUPERAGENT_DATA_DIR
  if (!dataDir) throw new Error('SUPERAGENT_DATA_DIR is required for metadata assertions')
  const metadataPath = path.join(dataDir, 'agents', agentSlug, 'workspace', 'session-metadata.json')
  try {
    return JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
  } catch {
    // Not written yet (or torn mid-write) — let the caller's poll retry.
    return {}
  }
}

async function startDispatchFromFrame(page: Page, url: string) {
  await page.goto(url)
  const iframeHandle = await page.waitForSelector('iframe', { timeout: 20_000 })
  const frame = await iframeHandle.contentFrame()
  if (!frame) throw new Error('dashboard iframe has no content frame')
  await frame.waitForFunction(() => !!(window as any).__GAMUT_DASHBOARD__)

  // Kick off the dispatch without awaiting: the promise stays pending while
  // the host's confirmation dialog is open.
  const resultPromise = frame.evaluate(() =>
    (window as any).__GAMUT_DASHBOARD__.dispatchSession({
      prompt: '/research-user jane',
      title: 'Research Jane',
    })
  )
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  return { dialog, resultPromise }
}

function openWrapperAndStartDispatch(page: Page, baseURL: string, agentSlug: string) {
  return startDispatchFromFrame(page, `${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/view`)
}

test.describe('dashboard session dispatch shim', () => {
  let agentSlug: string

  test.beforeEach(async ({ page }) => {
    const createResp = await page.request.post('/api/agents', {
      data: { name: `dispatch-e2e-${Date.now()}` },
    })
    const agent = await createResp.json() as { slug: string }
    agentSlug = agent.slug

    await page.request.post(`/api/agents/${agentSlug}/start`)
  })

  test('shim is injected into dashboard HTML', async ({ page, baseURL }) => {
    const dashboardUrl = `${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`
    const response = await page.request.get(dashboardUrl)

    const html = await response.text()
    expect(response.headers()['content-type']).toContain('text/html')
    expect(html).toContain('dispatchSession')
    expect(html).toContain('gamut:dispatch-session-request')
  })

  test('dispatchSession is a function on the frozen runtime', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`)

    const checks = await page.evaluate(() => {
      const runtime = (window as any).__GAMUT_DASHBOARD__
      return {
        hasRuntime: !!runtime,
        hasDispatch: typeof runtime?.dispatchSession === 'function',
        frozen: Object.isFrozen(runtime),
      }
    })

    expect(checks.hasRuntime).toBe(true)
    expect(checks.hasDispatch).toBe(true)
    expect(checks.frozen).toBe(true)
  })

  test('rejects cleanly when no host frame speaks the protocol', async ({ page, baseURL }) => {
    // Loaded as the top-level document there is no parent frame, so the shim
    // must reject immediately instead of hanging.
    await page.goto(`${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`)

    const result = await page.evaluate(async () => {
      const runtime = (window as any).__GAMUT_DASHBOARD__
      try {
        await runtime.dispatchSession({ prompt: 'do research' })
        return { error: null }
      } catch (err: any) {
        return { error: err.message }
      }
    })

    expect(result.error).toMatch(/not available in this window/)
  })

  test('rejects an empty prompt', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/api/agents/${agentSlug}/artifacts/test-dashboard/`)

    const result = await page.evaluate(async () => {
      const runtime = (window as any).__GAMUT_DASHBOARD__
      try {
        await runtime.dispatchSession({ prompt: '   ' })
        return { error: null }
      } catch (err: any) {
        return { error: err.message }
      }
    })

    expect(result.error).toMatch(/non-empty prompt/)
  })
})

test.describe('standalone /view wrapper dispatch host', () => {
  let agentSlug: string

  test.beforeEach(async ({ page }) => {
    const createResp = await page.request.post('/api/agents', {
      data: { name: `dispatch-view-e2e-${Date.now()}` },
    })
    const agent = await createResp.json() as { slug: string }
    agentSlug = agent.slug
    seedDashboard(agentSlug)
    await page.request.post(`/api/agents/${agentSlug}/start`)
  })

  test('confirming the wrapper dialog creates a session and resolves the shim', async ({ page, baseURL }) => {
    const { dialog, resultPromise } = await openWrapperAndStartDispatch(page, baseURL!, agentSlug)

    await expect(dialog.getByRole('heading')).toHaveText('Research Jane')
    await expect(dialog.locator('textarea')).toHaveValue('/research-user jane')
    await dialog.getByRole('button', { name: 'Dispatch' }).click()

    const result = await resultPromise as { sessionId?: string; agentSlug?: string }
    expect(result.sessionId).toBeTruthy()
    expect(result.agentSlug).toBe(agentSlug)
    await expect(dialog).toHaveCount(0)

    const sessionsResp = await page.request.get(`/api/agents/${agentSlug}/sessions`)
    const sessions = await sessionsResp.json() as Array<{ id: string }>
    expect(sessions.some((s) => s.id === result.sessionId)).toBe(true)

    // Provenance must be persisted with the session's registration.
    await expect
      .poll(() => readSessionMetadata(agentSlug)[result.sessionId!])
      .toMatchObject({
        dispatchedByDashboardSlug: 'test-dashboard',
        dispatchedByDashboardAgentSlug: agentSlug,
      })
  })

  test('cancelling the wrapper dialog resolves cancelled without a session', async ({ page, baseURL }) => {
    const { dialog, resultPromise } = await openWrapperAndStartDispatch(page, baseURL!, agentSlug)

    await dialog.getByRole('button', { name: 'Cancel' }).click()

    const result = await resultPromise
    expect(result).toEqual({ cancelled: true })
    await expect(dialog).toHaveCount(0)

    const sessionsResp = await page.request.get(`/api/agents/${agentSlug}/sessions`)
    const sessions = await sessionsResp.json() as Array<{ id: string }>
    expect(sessions).toHaveLength(0)
  })
})

test.describe('in-app dashboard dispatch', () => {
  let agentSlug: string

  test.beforeEach(async ({ page }) => {
    const createResp = await page.request.post('/api/agents', {
      data: { name: `dispatch-app-e2e-${Date.now()}` },
    })
    const agent = await createResp.json() as { slug: string }
    agentSlug = agent.slug
    seedDashboard(agentSlug)
    await page.request.post(`/api/agents/${agentSlug}/start`)
  })

  test('dispatching through the app modal creates a session with provenance', async ({ page, baseURL }) => {
    const { dialog, resultPromise } = await startDispatchFromFrame(
      page,
      `${baseURL}/agents/${agentSlug}/dashboards/test-dashboard`,
    )

    await expect(dialog.getByRole('heading', { name: 'Research Jane' })).toBeVisible()
    await expect(dialog.locator('textarea')).toHaveValue('/research-user jane')
    await dialog.getByRole('button', { name: 'Dispatch' }).click()

    const result = await resultPromise as { sessionId?: string; agentSlug?: string }
    expect(result.sessionId).toBeTruthy()
    expect(result.agentSlug).toBe(agentSlug)
    await expect(dialog).toHaveCount(0)

    const sessionsResp = await page.request.get(`/api/agents/${agentSlug}/sessions`)
    const sessions = await sessionsResp.json() as Array<{ id: string }>
    expect(sessions.some((s) => s.id === result.sessionId)).toBe(true)

    await expect
      .poll(() => readSessionMetadata(agentSlug)[result.sessionId!])
      .toMatchObject({
        dispatchedByDashboardSlug: 'test-dashboard',
        dispatchedByDashboardAgentSlug: agentSlug,
      })
  })

  test('cancelling the app modal resolves cancelled without a session', async ({ page, baseURL }) => {
    const { dialog, resultPromise } = await startDispatchFromFrame(
      page,
      `${baseURL}/agents/${agentSlug}/dashboards/test-dashboard`,
    )

    await dialog.getByRole('button', { name: 'Cancel' }).click()

    const result = await resultPromise
    expect(result).toEqual({ cancelled: true })
    await expect(dialog).toHaveCount(0)

    const sessionsResp = await page.request.get(`/api/agents/${agentSlug}/sessions`)
    const sessions = await sessionsResp.json() as Array<{ id: string }>
    expect(sessions).toHaveLength(0)
  })
})
