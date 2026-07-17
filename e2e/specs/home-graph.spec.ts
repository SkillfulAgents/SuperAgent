/**
 * Home connections graph — the cards ⇄ graph toggle on the homepage.
 *
 * Covers the URL-driven view state (back/forward/deep-link), graph rendering
 * from the batch /api/home-graph topology (permission edge between two
 * agents), node click-through navigation, and position persistence
 * (drag → saved to user settings; reset → cleared).
 *
 * Position persistence writes global user settings, so the drag test asserts
 * through the API rather than screen coordinates — screen positions depend on
 * fitView and on how many agents other parallel specs have created.
 */
import { test, expect, type Page } from '@playwright/test'
import { createAgent, uniqueName, type TestAgent } from '../helpers/agents'

function collectPageErrors(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function createInvokePolicy(request: Parameters<typeof createAgent>[0], caller: TestAgent, target: TestAgent) {
  const response = await request.put(`/api/agents/${caller.slug}/x-agent-policies`, {
    data: { policies: [{ operation: 'invoke', targetSlug: target.slug, decision: 'allow' }] },
  })
  expect(response.ok()).toBeTruthy()
}

test.describe('home connections graph', () => {
  test('toggle is URL-driven: back/forward and deep links restore the view', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Graph Toggle'))
    const errors = collectPageErrors(page)

    await page.goto('/')
    await page.getByTestId('home-view-graph').click()
    await expect(page).toHaveURL(/\?(.*&)?view=graph/)
    await expect(page.getByTestId('agent-graph')).toBeVisible()
    await expect(page.getByTestId(`graph-node-agent-${agent.slug}`)).toBeVisible()

    await page.goBack()
    await expect(page).not.toHaveURL(/view=graph/)
    await expect(page.getByTestId('agent-graph')).toHaveCount(0)

    await page.goForward()
    await expect(page.getByTestId('agent-graph')).toBeVisible()

    // Deep link straight into the graph view
    await page.goto('/?view=graph')
    await expect(page.getByTestId(`graph-node-agent-${agent.slug}`)).toBeVisible()

    expect(errors).toEqual([])
  })

  test('renders topology edges between agents and navigates on node click', async ({ page, request }, testInfo) => {
    const caller = await createAgent(request, uniqueName(testInfo, 'Graph Caller'))
    const target = await createAgent(request, uniqueName(testInfo, 'Graph Target'))
    await createInvokePolicy(request, caller, target)
    const errors = collectPageErrors(page)

    await page.goto('/?view=graph')
    await expect(page.getByTestId(`graph-node-agent-${caller.slug}`)).toBeVisible()
    await expect(page.getByTestId(`graph-node-agent-${target.slug}`)).toBeVisible()

    // The invoke permission renders as an edge between the two agent nodes
    // (canonical unordered pair id, `~` joiner = permission variant).
    const [a, b] = [`agent:${caller.slug}`, `agent:${target.slug}`].sort()
    await expect(page.locator(`[data-id="${a}~${b}"]`)).toBeAttached()

    // Click selects the node (revealing its Open toolbar); Open navigates to
    // the agent page; back → graph view intact.
    await page.getByTestId(`graph-node-agent-${caller.slug}`).click()
    await page.getByTestId('graph-node-open').click()
    await expect(page).toHaveURL(/\/agents\//)
    await page.goBack()
    await expect(page).toHaveURL(/view=graph/)
    await expect(page.getByTestId('agent-graph')).toBeVisible()

    expect(errors).toEqual([])
  })

  test('dragging a node persists its position; reset layout clears saved positions', async ({ page, request }, testInfo) => {
    const agent = await createAgent(request, uniqueName(testInfo, 'Graph Drag'))

    await page.goto('/?view=graph')
    const node = page.getByTestId(`graph-node-agent-${agent.slug}`)
    await expect(node).toBeVisible()

    const box = await node.boundingBox()
    expect(box).toBeTruthy()
    if (!box) return

    const persisted = page.waitForResponse(
      (r) => r.url().includes('/api/user-settings') && r.request().method() === 'PUT' && r.ok(),
    )
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 90, { steps: 6 })
    await page.mouse.up()
    await persisted // drag-stop → debounced settings write

    const settings = await (await request.get('/api/user-settings')).json() as {
      graphNodePositions?: Record<string, { x: number; y: number }>
    }
    expect(settings.graphNodePositions?.[`agent:${agent.slug}`]).toBeTruthy()

    const cleared = page.waitForResponse(
      (r) => r.url().includes('/api/user-settings') && r.request().method() === 'PUT' && r.ok(),
    )
    await page.getByTestId('graph-reset-layout').click()
    await cleared

    const after = await (await request.get('/api/user-settings')).json() as {
      graphNodePositions?: Record<string, { x: number; y: number }>
    }
    expect(after.graphNodePositions ?? {}).toEqual({})
  })
})
