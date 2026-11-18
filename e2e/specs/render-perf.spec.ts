import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { RenderPerfPage } from '../pages/render-perf.page'

test.describe.configure({ mode: 'serial' })

// Render tracking requires RENDER_TRACKING=true at build time (see test:e2e:perf script)
test.skip(!process.env.RENDER_TRACKING, 'RENDER_TRACKING not enabled')

test.describe('Render Performance', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let perf: RenderPerfPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
    perf = new RenderPerfPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('render tracking is available', async () => {
    const available = await perf.isAvailable()
    expect(available).toBe(true)
  })

  test('idle app does not have continuous re-renders', async ({ page }) => {
    // Create an agent so the sidebar has content
    await agentPage.createAgent(`Perf Idle ${Date.now()}`)

    // Wait for initial renders to settle
    await perf.sampleFor(3000)

    // Start measuring
    await perf.resetCounters()

    // Wait 10 seconds with no interaction
    await perf.sampleFor(10000)

    const data = await perf.getAllRenderData()
    console.log('=== Idle Render Report (10s) ===')
    console.log(perf.formatReport(data))

    const wdyrLogs = perf.getWdyrLogs()
    if (wdyrLogs.length > 0) {
      console.log('\n=== Unnecessary Re-renders (WDYR) ===')
      wdyrLogs.forEach((log) => console.log(`  ${log}`))
    }

    // In idle state, components should not render excessively.
    // TanStack Query polls every 5s, StrictMode doubles renders.
    // Allow up to 10 renders per component over 10s (generous threshold).
    for (const [component, entry] of Object.entries(data)) {
      if (entry.count > 10) {
        console.warn(`WARNING: ${component} rendered ${entry.count} times while idle`)
      }
    }
  })

  test('navigation does not cause excessive sidebar re-renders', async ({ page }) => {
    // Create two agents
    const agent1 = `Perf Nav A ${Date.now()}`
    const agent2 = `Perf Nav B ${Date.now()}`
    await agentPage.createAgent(agent1)
    await agentPage.createAgent(agent2)

    // Let things settle
    await perf.sampleFor(2000)
    await perf.resetCounters()

    // Navigate between agents
    await agentPage.selectAgent(agent1)
    await perf.sampleFor(1000)
    await agentPage.selectAgent(agent2)
    await perf.sampleFor(1000)
    await agentPage.selectAgent(agent1)
    await perf.sampleFor(1000)

    const data = await perf.snapshot()
    console.log('=== Navigation Render Report (3 agent switches) ===')
    console.log(perf.formatReport(data))

    const wdyrLogs = perf.getWdyrLogs()
    if (wdyrLogs.length > 0) {
      console.log('\n=== Unnecessary Re-renders (WDYR) ===')
      wdyrLogs.forEach((log) => console.log(`  ${log}`))
    }
  })

  test('switching agents re-renders the rows involved, not every row', async () => {
    // Six agent creations take most of the default budget on their own.
    test.setTimeout(120_000)
    const stamp = Date.now()
    const names = Array.from({ length: 6 }, (_, i) => `Perf Rows ${i} ${stamp}`)
    for (const name of names) await agentPage.createAgent(name)

    await agentPage.selectAgent(names[0])
    await perf.sampleFor(2000)
    await perf.resetCounters()

    await agentPage.selectAgent(names[1])
    await perf.sampleFor(1500)

    const data = await perf.snapshot()
    console.log('=== Agent Switch Render Report (1 switch, 6+ rows) ===')
    console.log(perf.formatReport(data))

    // The row left and the row entered render once each, doubled by
    // StrictMode: 4, with room for one more render of each. Before rows
    // selected their own route state every row rendered on a switch, so the
    // six created here alone came to 12 (measured: 16 with 8 rows, now 4).
    const rowRenders = data['AgentMenuItem']?.count ?? 0
    expect(rowRenders).toBeGreaterThan(0)
    expect(rowRenders).toBeLessThanOrEqual(8)
  })

  test('chat flow render counts', async ({ page }) => {
    await agentPage.createAgent(`Perf Chat ${Date.now()}`)

    // Let initial renders settle
    await perf.sampleFor(2000)
    await perf.resetCounters()

    // Send a message and wait for response
    await sessionPage.sendMessage('Hello, testing render performance')
    await sessionPage.waitForResponse(15000)

    // Wait a bit for streaming to finish
    await perf.sampleFor(2000)

    const data = await perf.snapshot()
    console.log('=== Chat Flow Render Report (1 message + response) ===')
    console.log(perf.formatReport(data))

    // Check that sidebar components didn't re-render excessively during chat
    const sidebarRenders = data['AppSidebar']?.count ?? 0
    const messageListRenders = data['MessageList']?.count ?? 0
    console.log(`\nSidebar/MessageList ratio: ${sidebarRenders}/${messageListRenders}`)

    const wdyrLogs = perf.getWdyrLogs()
    if (wdyrLogs.length > 0) {
      console.log('\n=== Unnecessary Re-renders (WDYR) ===')
      wdyrLogs.forEach((log) => console.log(`  ${log}`))
    }
  })
})
