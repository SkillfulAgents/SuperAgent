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
    // the agent page; back → graph view intact. Force-click both: sibling
    // specs' agent churn re-solves the layout, and a node that keeps moving
    // never passes Playwright's stability wait — a missed click just loops.
    const openChip = page.getByTestId('graph-node-open')
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.getByTestId(`graph-node-agent-${caller.slug}`).click({ force: true, timeout: 2000 }).catch(() => {})
      if (await openChip.isVisible()) await openChip.click({ force: true, timeout: 2000 }).catch(() => {})
      // Give the navigation a beat to land; a missed click just loops.
      const navigated = await page
        .waitForURL(/\/agents\//, { timeout: 1000 })
        .then(() => true)
        .catch(() => false)
      if (navigated) break
    }
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

    // Sibling specs share this server: their agents fill the graph, and while
    // they keep creating more, every structural change re-solves the layout
    // and shifts every unpinned node. A bounding box measured before a
    // reshuffle dangles — the mouse grabs empty canvas and pans instead of
    // dragging. Re-fit, re-measure and retry until the settings write proves
    // THIS node's position landed.
    const savedPosition = async () => {
      const settings = await (await request.get('/api/user-settings')).json() as {
        graphNodePositions?: Record<string, { x: number; y: number }>
      }
      return settings.graphNodePositions?.[`agent:${agent.slug}`]
    }
    let landed = false
    for (let attempt = 0; attempt < 5 && !landed; attempt++) {
      // Late-created agents can push the grid past the initial viewport;
      // re-fitting keeps the target node on screen for the grab.
      await page.getByRole('button', { name: 'Fit View' }).click()
      const box = await node.boundingBox()
      if (!box) continue
      const persisted = page
        .waitForResponse(
          (r) => r.url().includes('/api/user-settings') && r.request().method() === 'PUT' && r.ok(),
          { timeout: 4000 },
        )
        .catch(() => null)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 90, { steps: 6 })
      await page.mouse.up()
      await persisted // drag-stop → debounced settings write (or a missed grab timing out)
      // A missed grab can still drag a NEIGHBORING node and fire the PUT —
      // only the target agent's saved position counts as success.
      landed = (await savedPosition()) !== undefined
    }
    expect(landed).toBe(true)

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

  test('drawing an edge between agents creates the invoke permission; deleting it revokes', async ({ page, request }, testInfo) => {
    const source = await createAgent(request, uniqueName(testInfo, 'Graph Draw Src'))
    const target = await createAgent(request, uniqueName(testInfo, 'Graph Draw Dst'))

    const policyTargets = async () => {
      const res = await request.get(`/api/agents/${source.slug}/x-agent-policies`)
      expect(res.ok()).toBeTruthy()
      const body = await res.json() as { policies?: Array<{ targetAgentSlug: string; decision: string }> }
      return (body.policies ?? []).filter((p) => p.decision === 'allow').map((p) => p.targetAgentSlug)
    }

    await page.goto('/?view=graph')
    const sourceNode = page.getByTestId(`graph-node-agent-${source.slug}`)
    const targetNode = page.getByTestId(`graph-node-agent-${target.slug}`)
    await expect(sourceNode).toBeVisible()
    await expect(targetNode).toBeVisible()

    // On CI the shared server holds ~100 agents from sibling specs, so
    // fitView bottoms out at minZoom (0.15) where a port's hit zone is ~3px
    // and the 30-flow-px connectionRadius shrinks below cursor precision.
    // Worse, alphabetically-adjacent agents can straddle a grid-row wrap and
    // sit thousands of flow px apart — zooming to a workable scale then
    // leaves one (or both) outside the viewport, where mouse gestures are
    // no-ops. Two counters:
    //  1. pinPairTogether: drag the source card next to the target. Node
    //     drags work at any zoom, and a dragged node is PINNED — churn
    //     re-layouts stop moving both cards, making every later
    //     measurement stable.
    //  2. zoomToPair: wheel-zoom anchored between the (now adjacent) cards
    //     until they render near natural size (card = 176 flow px wide).
    const dragNode = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 5 })
      await page.mouse.up()
    }
    const pinPairTogether = async () => {
      await page.getByRole('button', { name: 'Fit View' }).click()
      const tb0 = await targetNode.boundingBox({ timeout: 1500 }).catch(() => null)
      if (!tb0) return
      // Nudge the target a few px — enough to pin it against re-layouts.
      const tCenter = { x: tb0.x + tb0.width / 2, y: tb0.y + tb0.height / 2 }
      await dragNode(tCenter, { x: tCenter.x + 10, y: tCenter.y + 10 })
      const tb = await targetNode.boundingBox({ timeout: 1500 }).catch(() => null)
      const sb = await sourceNode.boundingBox({ timeout: 1500 }).catch(() => null)
      if (!tb || !sb) return
      // Park the source three card-widths left of the target (clear gap,
      // same row) and thereby pin it too.
      await dragNode(
        { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 },
        { x: tb.x - 3 * tb.width, y: tb.y + tb.height / 2 },
      )
    }
    const zoomToPair = async () => {
      for (let i = 0; i < 24; i++) {
        const sb = await sourceNode.boundingBox({ timeout: 1500 }).catch(() => null)
        const tb = await targetNode.boundingBox({ timeout: 1500 }).catch(() => null)
        if (!sb || !tb || sb.width >= 150) return
        await page.mouse.move(
          (sb.x + sb.width / 2 + tb.x + tb.width / 2) / 2,
          (sb.y + sb.height / 2 + tb.y + tb.height / 2) / 2,
        )
        await page.mouse.wheel(0, -160)
      }
    }

    // Ports arm on selection only, and sibling specs' churn reshuffles the
    // layout under a stale bounding box (same hazard as the drag test above)
    // — so grab-and-draw retries with fresh measurements, treating the policy
    // row's existence as the success signal.
    let drawn = false
    for (let attempt = 0; attempt < 5 && !drawn; attempt++) {
      // A stale force-click can land as a double-click on whatever card the
      // churn shuffled underneath, navigating clean off the graph — come back
      // before trying again.
      if (!/view=graph/.test(page.url())) await page.goto('/?view=graph')
      await pinPairTogether()
      await zoomToPair()
      await sourceNode.click({ force: true, timeout: 2000 }).catch(() => {})
      const sourceBox = await sourceNode.boundingBox({ timeout: 1500 }).catch(() => null)
      const targetBox = await targetNode.boundingBox({ timeout: 1500 }).catch(() => null)
      if (!sourceBox || !targetBox) continue
      // Port offsets are in flow px — scale them by the rendered zoom.
      const zoom = sourceBox.width / 176
      const saved = page
        .waitForResponse(
          (r) => r.url().includes('/x-agent-policies/invoke/') && r.request().method() === 'PUT' && r.ok(),
          { timeout: 4000 },
        )
        .catch(() => null)
      // Right-side port: 24px hit zone centered ~6px inside the card edge.
      await page.mouse.move(sourceBox.x + sourceBox.width - 6 * zoom, sourceBox.y + sourceBox.height / 2)
      await page.mouse.down()
      // Drop ON the target's left port — the drop must land within
      // connectionRadius (30 flow px) of a handle, and the card center is
      // 40+ flow px from every port.
      await page.mouse.move(targetBox.x + 6 * zoom, targetBox.y + targetBox.height / 2, { steps: 8 })
      await page.mouse.up()
      await saved
      drawn = (await policyTargets()).includes(target.slug)
    }
    expect(drawn).toBe(true)

    // The topology refetch draws the permission edge (unordered pair id).
    if (!/view=graph/.test(page.url())) await page.goto('/?view=graph')
    const [a, b] = [`agent:${source.slug}`, `agent:${target.slug}`].sort()
    const edge = page.locator(`[data-id="${a}~${b}"]`)
    await expect(edge).toBeAttached()

    // Deleting the connector revokes the policy. Selecting a ~1px line is the
    // flaky part, so retry the select-then-delete gesture until the policy row
    // is actually gone.
    const deleteButton = page.getByTestId('graph-edge-delete')
    let revoked = false
    for (let attempt = 0; attempt < 6 && !revoked; attempt++) {
      if (!/view=graph/.test(page.url())) await page.goto('/?view=graph')
      // The edge lives between the two (pinned, adjacent) cards, which the
      // draw phase may have zoomed out of the viewport — a force-click on an
      // off-screen element is a no-op (the canvas pans, it doesn't scroll).
      // Re-fit and re-zoom onto the pair so the connector is big and on
      // screen.
      await page.getByRole('button', { name: 'Fit View' }).click()
      await zoomToPair()
      if (await edge.count()) {
        await edge.click({ force: true, timeout: 2000 }).catch(() => {})
        if (await deleteButton.isVisible()) {
          // force: the toolbar chip rides the edge midpoint, which churn can
          // shift mid-actionability-wait; a missed click just retries.
          await deleteButton.click({ force: true, timeout: 2000 }).catch(() => {})
          // Poll (network-paced) for the revoke to land before re-clicking.
          const deadline = Date.now() + 2000
          while (Date.now() < deadline && (await policyTargets()).includes(target.slug)) {
            // each policyTargets() round-trip paces the loop
          }
        }
      }
      revoked = !(await policyTargets()).includes(target.slug)
    }
    expect(revoked).toBe(true)
    await expect(edge).toHaveCount(0)
  })
})
