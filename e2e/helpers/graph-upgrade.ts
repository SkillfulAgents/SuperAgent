/* eslint-disable local-rules/no-brittle-playwright-selectors -- React Flow owns these public DOM classes; they expose canvas transforms and connection/selection state without modifying production components. */
import { expect, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export interface GraphUpgradeContext {
  page: Page
  request: APIRequestContext
  apiBaseUrl: string
  navigate: (route: string) => Promise<unknown>
  runtime: 'web' | 'electron'
  captureFailure?: () => Promise<void>
}

const pointSchema = z.object({ x: z.number(), y: z.number() })
export const graphSettingsSchema = z.object({
  graphNodePositions: z.record(z.string(), pointSchema).optional(),
  graphEdgeGeometry: z.record(z.string(), z.unknown()).optional(),
})
const agentSchema = z.object({ slug: z.string(), name: z.string() })
const policySchema = z.object({ policies: z.array(z.object({ targetAgentSlug: z.string(), decision: z.string() })) })
type Point = z.infer<typeof pointSchema>
type Agent = z.infer<typeof agentSchema>

async function readSettings(context: GraphUpgradeContext) {
  const response = await context.request.get(`${context.apiBaseUrl}/api/user-settings`)
  expect(response.ok(), `Read user settings: ${response.status()}`).toBe(true)
  return graphSettingsSchema.parse(await response.json())
}

async function writeSettings(context: GraphUpgradeContext, settings: z.infer<typeof graphSettingsSchema>) {
  const response = await context.request.put(`${context.apiBaseUrl}/api/user-settings`, { data: settings })
  expect(response.ok(), `Save user settings: ${response.status()}`).toBe(true)
}

function wrapper(page: Page, agent: Agent) {
  return page.locator(`.react-flow__node[data-id="agent:${agent.slug}"]`)
}

function card(page: Page, agent: Agent) {
  return page.getByTestId(`graph-node-agent-${agent.slug}`)
}

async function center(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox()
  expect(box, 'Gesture target must have a visible bounding box').not.toBeNull()
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
}

async function viewport(page: Page) {
  return page.locator('.react-flow__viewport').evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { x: matrix.e, y: matrix.f, zoom: matrix.a }
  })
}

async function nodePosition(page: Page, agent: Agent) {
  return wrapper(page, agent).evaluate(element => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { x: matrix.e, y: matrix.f }
  })
}

async function blankPoint(page: Page, clearance = 0): Promise<Point> {
  return page.getByTestId('agent-graph').evaluate((element, clearance) => {
    const box = element.getBoundingClientRect()
    // Canvas geometry is measured after fitView. Avoid cards, edges and
    // controls, including their invisible hit areas, instead of guessing.
    for (const yf of [0.78, 0.64, 0.5, 0.36, 0.22]) {
      for (const xf of [0.75, 0.6, 0.45, 0.3, 0.85]) {
        const x = box.x + box.width * xf
        const y = box.y + box.height * yf
        const free = [-clearance, 0, clearance].every(dx => [-clearance, 0, clearance].every(dy => {
          const hit = document.elementFromPoint(x + dx, y + dy)
          return hit?.closest('.react-flow__pane') && !hit.closest('.react-flow__node,.react-flow__edge,.react-flow__panel')
        }))
        if (free) return { x, y }
      }
    }
    throw new Error(`No unobstructed graph pane area found (clearance ${clearance}px)`)
  }, clearance)
}

async function dragMouse(page: Page, from: Point, to: Point) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
  // d3 suppresses the synthetic click belonging to a drag until the next
  // task. A subsequent real click must occur after that release task.
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
}

async function fit(page: Page, touch = false) {
  const control = page.getByRole('button', { name: 'Fit View', exact: true })
  if (touch) await control.tap()
  else await control.click()
  // fitView resolves on animation frames, not at the button's click return.
  // CDP gestures bypass locator stability, so never measure the old viewport.
  await page.locator('.react-flow__viewport').evaluate(async element => {
    let previous = ''
    let stable = 0
    for (let frame = 0; frame < 60; frame++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const current = getComputedStyle(element).transform
      stable = current === previous ? stable + 1 : 0
      if (stable >= 3) return
      previous = current
    }
    throw new Error('Graph viewport did not settle after Fit View')
  })
}

/**
 * The graph projects run serially against an isolated API. Remove only this
 * scenario's agents after leaving the graph; no sibling can be mid-gesture.
 * Existing agents/settings are preserved, including Electron's seed agents.
 */
async function withGraph(context: GraphUpgradeContext, run: (agents: [Agent, Agent, Agent]) => Promise<void>) {
  const before = await readSettings(context)
  const agents: Agent[] = []
  let failure: unknown
  try {
    for (const label of ['Source', 'Target', 'Bystander']) {
      const response = await context.request.post(`${context.apiBaseUrl}/api/agents`, { data: { name: `XYFlow ${label} ${randomUUID().slice(0, 8)}` } })
      expect(response.status()).toBe(201)
      agents.push(agentSchema.parse(await response.json()))
    }
    await writeSettings(context, {
      graphNodePositions: {
        ...before.graphNodePositions,
        // Keep this scenario's cards clear of the legacy suite's retained
        // agents, whose automatic layout occupies nonnegative coordinates.
        [`agent:${agents[0].slug}`]: { x: -900, y: -500 },
        [`agent:${agents[1].slug}`]: { x: -540, y: -500 },
        [`agent:${agents[2].slug}`]: { x: -900, y: -320 },
      },
    })
    await context.navigate('/?view=graph')
    for (const agent of agents) await expect(card(context.page, agent)).toBeVisible()
    await fit(context.page)
    await run(agents as [Agent, Agent, Agent])
  } catch (error) {
    failure = error
    try { await context.captureFailure?.() } catch (captureError) {
      failure = new AggregateError([error, captureError], 'Graph scenario and failure capture both failed')
    }
  }
  try {
    await context.navigate('/')
    await expect(context.page.getByTestId('agent-graph')).toHaveCount(0)
    for (const agent of agents) {
      const response = await context.request.delete(`${context.apiBaseUrl}/api/agents/${agent.slug}`)
      expect(response.ok(), `Remove fixture agent ${agent.slug}: ${response.status()}`).toBe(true)
    }
    await writeSettings(context, {
      graphNodePositions: before.graphNodePositions ?? {},
      graphEdgeGeometry: before.graphEdgeGeometry ?? {},
    })
  } catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], 'Graph scenario and fixture cleanup both failed')
    throw cleanupError
  }
  if (failure) throw failure
}

/** Real drag writes, page reload reads, and reset clears actual API settings. */
export async function checkGraphPositionPersistence(context: GraphUpgradeContext) {
  await withGraph(context, async ([source]) => {
    const { page } = context
    const before = await nodePosition(page, source)
    const start = await center(card(page, source))
    await dragMouse(page, start, { x: start.x + 95, y: start.y + 70 })
    await expect.poll(async () => (await nodePosition(page, source)).x).toBeGreaterThan(before.x + 20)
    const moved = await nodePosition(page, source)
    // The app intentionally rounds persisted coordinates to whole flow pixels.
    const after = { x: Math.round(moved.x), y: Math.round(moved.y) }
    await expect.poll(async () => (await readSettings(context)).graphNodePositions?.[`agent:${source.slug}`]).toEqual(after)

    // Full reload, not just the optimistic query cache, must restore the pin.
    await page.reload()
    await expect(card(page, source)).toBeVisible()
    await expect.poll(() => nodePosition(page, source)).toEqual(after)
    await page.getByTestId('graph-reset-layout').click()
    await expect.poll(async () => (await readSettings(context)).graphNodePositions ?? {}).toEqual({})
    await expect.poll(async () => (await readSettings(context)).graphEdgeGeometry ?? {}).toEqual({})
    await page.reload()
    await expect(card(page, source)).toBeVisible()
    expect(await nodePosition(page, source)).not.toEqual(after)
  })
}

/** Panning/zooming must not create position writes or lose selected nodes. */
export async function checkGraphViewportAndSelection(context: GraphUpgradeContext) {
  await withGraph(context, async ([source, target]) => {
    const { page } = context
    const settings = await readSettings(context)
    await card(page, source).click()
    await expect(wrapper(page, source)).toHaveClass(/selected/)
    await card(page, target).click()
    await expect(wrapper(page, target)).toHaveClass(/selected/)
    await expect(wrapper(page, source)).not.toHaveClass(/selected/)

    const start = await blankPoint(page)
    const before = await viewport(page)
    await dragMouse(page, start, { x: start.x + 85, y: start.y + 55 })
    await expect.poll(async () => Math.abs((await viewport(page)).x - before.x)).toBeGreaterThan(50)
    await expect(page.locator('.react-flow__nodesselection')).toHaveCount(0)
    await expect(wrapper(page, target)).toHaveClass(/selected/)
    await expect(wrapper(page, source)).not.toHaveClass(/selected/)
    const panned = await viewport(page)
    expect(panned.zoom).toBeCloseTo(before.zoom, 5)
    await page.mouse.move(start.x, start.y)
    await page.mouse.wheel(0, 300)
    await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(before.zoom * 0.9)
    await expect(wrapper(page, target)).toHaveClass(/selected/)
    const zoomedOut = await viewport(page)
    await page.mouse.wheel(0, -150)
    await expect.poll(async () => (await viewport(page)).zoom).toBeGreaterThan(zoomedOut.zoom)
    await fit(page)
    await expect(wrapper(page, target)).toHaveClass(/selected/)
    await expect(wrapper(page, source)).not.toHaveClass(/selected/)
    const canvas = await page.getByTestId('agent-graph').boundingBox()
    for (const agent of [source, target]) {
      const box = await card(page, agent).boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(canvas!.x - 1)
      expect(box!.y).toBeGreaterThanOrEqual(canvas!.y - 1)
      expect(box!.x + box!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width + 1)
      expect(box!.y + box!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height + 1)
    }
    expect((await readSettings(context)).graphNodePositions).toEqual(settings.graphNodePositions)
  })
}

/** Dragging an unselected card must not carry the previously selected group. */
export async function checkGraphSelectionDrag(context: GraphUpgradeContext) {
  await withGraph(context, async ([first, second, third]) => {
    const { page } = context
    await card(page, first).click()
    const modifier = await page.evaluate(() => /Mac/.test(navigator.userAgent) ? 'Meta' : 'Control')
    await card(page, second).click({ modifiers: [modifier] })
    await expect(wrapper(page, first)).toHaveClass(/selected/)
    await expect(wrapper(page, second)).toHaveClass(/selected/)
    await expect(wrapper(page, third)).not.toHaveClass(/selected/)
    const firstInitial = await nodePosition(page, first)
    const secondInitial = await nodePosition(page, second)
    const groupStart = await center(card(page, first))
    await dragMouse(page, groupStart, { x: groupStart.x + 45, y: groupStart.y + 30 })
    await expect.poll(async () => (await nodePosition(page, first)).x).toBeGreaterThan(firstInitial.x + 15)
    await expect.poll(async () => (await nodePosition(page, second)).x).toBeGreaterThan(secondInitial.x + 15)
    await expect(wrapper(page, first)).toHaveClass(/selected/)
    await expect(wrapper(page, second)).toHaveClass(/selected/)
    const firstBefore = await nodePosition(page, first)
    const secondBefore = await nodePosition(page, second)
    expect(firstBefore.x - firstInitial.x).toBeCloseTo(secondBefore.x - secondInitial.x, 3)
    expect(firstBefore.y - firstInitial.y).toBeCloseTo(secondBefore.y - secondInitial.y, 3)
    for (const [agent, position] of [[first, firstBefore], [second, secondBefore]] as const) {
      await expect.poll(async () => (await readSettings(context)).graphNodePositions?.[`agent:${agent.slug}`]).toEqual({ x: Math.round(position.x), y: Math.round(position.y) })
    }
    const thirdBefore = await nodePosition(page, third)
    const start = await center(card(page, third))
    await dragMouse(page, start, { x: start.x + 70, y: start.y + 40 })
    await expect.poll(async () => (await nodePosition(page, third)).x).toBeGreaterThan(thirdBefore.x + 20)
    await expect(wrapper(page, third)).toHaveClass(/selected/)
    await expect(wrapper(page, first)).not.toHaveClass(/selected/)
    await expect(wrapper(page, second)).not.toHaveClass(/selected/)
    expect(await nodePosition(page, first)).toEqual(firstBefore)
    expect(await nodePosition(page, second)).toEqual(secondBefore)
    const moved = await nodePosition(page, third)
    await expect.poll(async () => (await readSettings(context)).graphNodePositions?.[`agent:${third.slug}`]).toEqual({ x: Math.round(moved.x), y: Math.round(moved.y) })
    const persisted = (await readSettings(context)).graphNodePositions!
    expect(persisted[`agent:${first.slug}`]).toEqual({ x: Math.round(firstBefore.x), y: Math.round(firstBefore.y) })
    expect(persisted[`agent:${second.slug}`]).toEqual({ x: Math.round(secondBefore.x), y: Math.round(secondBefore.y) })
  })
}

async function targets(context: GraphUpgradeContext, source: Agent) {
  const response = await context.request.get(`${context.apiBaseUrl}/api/agents/${source.slug}/x-agent-policies`)
  expect(response.ok()).toBe(true)
  return policySchema.parse(await response.json()).policies.filter(policy => policy.decision === 'allow').map(policy => policy.targetAgentSlug)
}

function port(page: Page, agent: Agent, side: string) {
  return card(page, agent).locator(`[data-testid="graph-port"][data-handleid="${side}"]`)
}

async function expectConnectionCleared(page: Page) {
  await expect(page.locator('.react-flow__connection')).toHaveCount(0)
  await expect(page.locator('.graph-port.connectingfrom,.graph-port.connectingto,.graph-port.clickconnecting')).toHaveCount(0)
}

async function cancelDragConnection(page: Page, source: Agent) {
  await card(page, source).click()
  await expect(wrapper(page, source)).toHaveClass(/selected/)
  const start = await center(port(page, source, 'right'))
  const empty = await blankPoint(page)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  try {
    await page.mouse.move(empty.x, empty.y, { steps: 12 })
    await expect(page.locator('.react-flow__connection')).toHaveCount(1)
  } finally { await page.mouse.up() }
  await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 0)))
  await expectConnectionCleared(page)
}

async function clickConnection(page: Page, source: Agent, target: Agent) {
  await card(page, source).click()
  await port(page, source, 'right').click()
  await expect(port(page, source, 'right')).toHaveClass(/clickconnecting/)
  // Invisible ports do not intercept clicks. Select the destination card
  // first to expose its real connect handle, as a person does in the app.
  await card(page, target).click()
  await port(page, target, 'left').click()
  await expectConnectionCleared(page)
}

/** Fresh click-connect must cancel on the first pane click in 12.12.1. */
export async function checkGraphClickCancellation(context: GraphUpgradeContext) {
  await withGraph(context, async ([source, target]) => {
    const { page } = context
    await card(page, source).click()
    await port(page, source, 'right').click()
    await expect(port(page, source, 'right')).toHaveClass(/clickconnecting/)
    const panStart = await blankPoint(page)
    await dragMouse(page, panStart, { x: panStart.x + 30, y: panStart.y + 20 })
    // A pan should preserve the pending click connection; a click cancels.
    await expect(port(page, source, 'right')).toHaveClass(/clickconnecting/)
    const cancel = await blankPoint(page)
    await page.mouse.click(cancel.x, cancel.y)
    await expectConnectionCleared(page)
    expect(await targets(context, source)).not.toContain(target.slug)

    // The next handle click starts a fresh connection, rather than finishing
    // the canceled source's permission write.
    await card(page, target).click()
    await port(page, target, 'left').click()
    await expect(port(page, target, 'left')).toHaveClass(/clickconnecting/)
    expect(await targets(context, source)).not.toContain(target.slug)
    expect(await targets(context, target)).not.toContain(source.slug)
    const secondCancel = await blankPoint(page)
    await page.mouse.click(secondCancel.x, secondCancel.y)
    await expectConnectionCleared(page)
    await clickConnection(page, source, target)
    await expect.poll(() => targets(context, source)).toContain(target.slug)
  })
}

/** Drag cancellation must leave the next real create and revoke usable. */
export async function checkGraphConnections(context: GraphUpgradeContext) {
  await withGraph(context, async ([source, target]) => {
    const { page } = context
    await cancelDragConnection(page, source)
    expect(await targets(context, source)).not.toContain(target.slug)
    await dragMouse(page, await center(port(page, source, 'right')), await center(port(page, target, 'left')))
    await expect.poll(() => targets(context, source)).toContain(target.slug)
    await expectConnectionCleared(page)
    const [a, b] = [`agent:${source.slug}`, `agent:${target.slug}`].sort()
    const edge = page.locator(`.react-flow__edge[data-id="${a}~${b}"]`)
    await expect(edge).toBeAttached()
    // Elbow paths can have an empty rectangular center; click their real path.
    const edgePoint = await edge.locator('.react-flow__edge-path').evaluate(async path => {
      const svgPath = path as SVGPathElement
      let previous = ''
      let stable = 0
      for (let frame = 0; frame < 120; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        const box = svgPath.getBoundingClientRect()
        const current = `${svgPath.getAttribute('d')} ${box.x},${box.y},${box.width},${box.height}`
        stable = current === previous ? stable + 1 : 0
        if (stable >= 3) break
        previous = current
      }
      if (stable < 3) throw new Error('Graph edge geometry did not settle before selection')
      const p = svgPath.getPointAtLength(svgPath.getTotalLength() / 2)
      const local = svgPath.getBBox()
      const rendered = svgPath.getBoundingClientRect()
      // React Flow uses only translation and uniform scale. Map the SVG
      // path's local bounds onto its rendered bounds: WebKit's getScreenCTM
      // omits ancestor CSS transforms for this nested SVG in some frames.
      if (!local.width && !local.height) throw new Error('Graph edge has no measurable path')
      const scale = local.width ? rendered.width / local.width : rendered.height / local.height
      const screen = {
        x: rendered.x + (p.x - local.x) * scale,
        y: rendered.y + (p.y - local.y) * scale,
      }
      const hit = document.elementFromPoint(screen.x, screen.y)
      if (hit?.closest('.react-flow__edge') !== path.closest('.react-flow__edge')) {
        throw new Error(`Settled edge midpoint (${screen.x}, ${screen.y}) is obstructed by ${hit?.tagName} ${hit?.getAttribute('class')}`)
      }
      return { x: screen.x, y: screen.y }
    })
    await page.mouse.click(edgePoint.x, edgePoint.y)
    await expect(page.getByTestId('graph-edge-delete')).toBeVisible()
    await page.getByTestId('graph-edge-delete').click()
    await expect.poll(() => targets(context, source)).not.toContain(target.slug)
    await expect(edge).toHaveCount(0)
  })
}

/** A canceled drag must not interfere with the later click-connect lifecycle. */
export async function checkGraphMixedCancellationRecovery(context: GraphUpgradeContext) {
  await withGraph(context, async ([source, target]) => {
    const { page } = context
    await cancelDragConnection(page, source)
    await port(page, source, 'right').click()
    await expect(port(page, source, 'right')).toHaveClass(/clickconnecting/)
    const panStart = await blankPoint(page)
    await dragMouse(page, panStart, { x: panStart.x + 30, y: panStart.y + 20 })
    await expect(port(page, source, 'right')).toHaveClass(/clickconnecting/)
    const cancel = await blankPoint(page)
    await page.mouse.click(cancel.x, cancel.y)
    await expectConnectionCleared(page)
    expect(await targets(context, source)).not.toContain(target.slug)
    expect(await targets(context, target)).not.toContain(source.slug)
    await clickConnection(page, source, target)
    await expect.poll(() => targets(context, source)).toContain(target.slug)
  })
}

/** Passive bookkeeping around the native observer; callback/timing unchanged. */
function installObserverProbe() {
  const scope = window as typeof window & { __xyflowObservedTargets?: Set<Element> }
  if (scope.__xyflowObservedTargets) return
  const tracked = new Set<Element>()
  const observers = new Map<ResizeObserver, Set<Element>>()
  const NativeObserver = window.ResizeObserver
  scope.__xyflowObservedTargets = tracked
  window.ResizeObserver = class extends NativeObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback)
      observers.set(this, new Set())
    }
    observe(target: Element, options?: ResizeObserverOptions) {
      if (target.closest('[data-testid="agent-graph"]')) {
        tracked.add(target)
        let owned = observers.get(this)
        if (!owned) { owned = new Set(); observers.set(this, owned) }
        owned.add(target)
      }
      super.observe(target, options)
    }
    unobserve(target: Element) {
      observers.get(this)?.delete(target)
      // A second observer can own the same target independently.
      if (![...observers.values()].some(targets => targets.has(target))) tracked.delete(target)
      super.unobserve(target)
    }
    disconnect() {
      const previous = observers.get(this)
      observers.delete(this)
      for (const target of previous ?? []) {
        if (![...observers.values()].some(targets => targets.has(target))) tracked.delete(target)
      }
      super.disconnect()
    }
  }
}

export async function checkGraphRemountCleanup(context: GraphUpgradeContext) {
  const { page } = context
  await page.addInitScript(installObserverProbe)
  await page.evaluate(installObserverProbe)
  await withGraph(context, async ([source]) => {
    for (let cycle = 0; cycle < 3; cycle++) {
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __xyflowObservedTargets: Set<Element> }).__xyflowObservedTargets.size)).toBeGreaterThan(0)
      await card(page, source).click()
      await expect(wrapper(page, source)).toHaveClass(/selected/)
      await port(page, source, 'right').click()
      await expect(port(page, source, 'right')).toHaveClass(/clickconnecting/)
      // SPA view changes unmount React Flow; full-page navigation would hide
      // stale stores and observer subscriptions by replacing the document.
      await page.getByTestId('home-view-cards').click()
      await expect(page.getByTestId('agent-graph')).toHaveCount(0)
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __xyflowObservedTargets: Set<Element> }).__xyflowObservedTargets.size)).toBe(0)
      await page.getByTestId('home-view-graph').click()
      await expect(card(page, source)).toBeVisible()
      await expectConnectionCleared(page)
      await expect(page.locator('.react-flow__node.selected')).toHaveCount(0)
      await fit(page)
    }
    await card(page, source).click()
    await expect(page.getByTestId('graph-node-open')).toBeVisible()
    await page.getByTestId('graph-node-open').click()
    await expect(page.getByTestId('agent-breadcrumb')).toHaveText(source.name)
    await expect.poll(() => page.evaluate(() => (window as typeof window & { __xyflowObservedTargets: Set<Element> }).__xyflowObservedTargets.size)).toBe(0)
    await page.goBack()
    await expect(card(page, source)).toBeVisible()
    await expectConnectionCleared(page)
  })
}

export const graphUpgradeScenarios = [
  ['graph node positions survive reload and reset through the real API', checkGraphPositionPersistence],
  ['graph pan, wheel zoom, fit and selection preserve saved pins', checkGraphViewportAndSelection],
  ['graph unselected-node drag does not move the previous selection', checkGraphSelectionDrag],
  ['graph fresh click connection cancels on one pane click without a permission write', checkGraphClickCancellation],
  ['graph drag cancellation permits the next real create and revoke', checkGraphConnections],
  ['graph mixed drag and click cancellation clears on the first deliberate pane click', checkGraphMixedCancellationRecovery],
  ['graph remount releases observers and connection/selection state', checkGraphRemountCleanup],
] as const

/**
 * Chromium uses native CDP touch injection. WebKit exposes native taps only;
 * movements below dispatch TouchEvents through its actual d3 touch handlers.
 * These synthetic WebKit gestures do not claim physical-device coverage.
 */
async function touchGesture(page: Page, browserName: string, points: Point[], deltas: Point[]) {
  const session: CDPSession | undefined = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined
  try {
    if (session) {
      const touchPoints = (progress: number) => points.map((point, index) => ({
        x: point.x + deltas[index].x * progress, y: point.y + deltas[index].y * progress,
        id: index + 1, radiusX: 3, radiusY: 3, force: 1,
      }))
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoints(0) })
      for (let step = 1; step <= 12; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPoints(step / 12) })
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } else {
      await page.evaluate(async ({ points, deltas }) => {
        const target = document.elementFromPoint(points[0].x, points[0].y)!
        const touches = (progress: number) => points.map((point, index) => ({
          identifier: index + 1, target, clientX: point.x + deltas[index].x * progress,
          clientY: point.y + deltas[index].y * progress,
          pageX: point.x + deltas[index].x * progress, pageY: point.y + deltas[index].y * progress,
          screenX: point.x + deltas[index].x * progress, screenY: point.y + deltas[index].y * progress,
        }))
        const dispatch = (type: string, active: ReturnType<typeof touches>, changed: ReturnType<typeof touches>) => {
          // WebKit exposes Touch/TouchEvent but rejects their constructors.
          const event = new Event(type, { bubbles: true, cancelable: true })
          Object.defineProperties(event, { touches: { value: active }, targetTouches: { value: active }, changedTouches: { value: changed } })
          target.dispatchEvent(event)
        }
        dispatch('touchstart', touches(0), touches(0))
        for (let step = 1; step <= 12; step++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          dispatch('touchmove', touches(step / 12), touches(step / 12))
        }
        dispatch('touchend', [], touches(1))
      }, { points, deltas })
    }
  } finally { await session?.detach() }
}

export async function checkGraphTouch(context: GraphUpgradeContext, browserName: string) {
  await withGraph(context, async ([source]) => {
    const { page } = context
    const saved = await readSettings(context)
    await card(page, source).tap()
    await expect(wrapper(page, source)).toHaveClass(/selected/)
    const start = await blankPoint(page)
    const before = await viewport(page)
    await touchGesture(page, browserName, [start], [{ x: 70, y: 45 }])
    await expect.poll(async () => Math.abs((await viewport(page)).x - before.x)).toBeGreaterThan(40)
    await expect(page.locator('.react-flow__selection,.react-flow__nodesselection')).toHaveCount(0)
    expect((await viewport(page)).zoom).toBeCloseTo(before.zoom, 4)
    expect((await readSettings(context)).graphNodePositions).toEqual(saved.graphNodePositions)

    const pinchCenter = await blankPoint(page, 50)
    const beforePinch = await viewport(page)
    await touchGesture(page, browserName,
      [{ x: pinchCenter.x - 45, y: pinchCenter.y }, { x: pinchCenter.x + 45, y: pinchCenter.y }],
      [{ x: 20, y: 0 }, { x: -20, y: 0 }])
    await expect.poll(async () => (await viewport(page)).zoom).toBeLessThan(beforePinch.zoom * 0.8)
    await fit(page, true)

    const nodeBefore = await nodePosition(page, source)
    await touchGesture(page, browserName, [await center(card(page, source))], [{ x: 80, y: 50 }])
    await expect.poll(async () => (await nodePosition(page, source)).x).toBeGreaterThan(nodeBefore.x + 20)
    const moved = await nodePosition(page, source)
    const nodeAfter = { x: Math.round(moved.x), y: Math.round(moved.y) }
    await expect.poll(async () => (await readSettings(context)).graphNodePositions?.[`agent:${source.slug}`]).toEqual(nodeAfter)
    await page.reload()
    await expect(card(page, source)).toBeVisible()
    await expect.poll(() => nodePosition(page, source)).toEqual(nodeAfter)
  })
}
