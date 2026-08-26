import { writeFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Runs under the web-webkit project only (see playwright.config.ts).
//
// Safari computes fractional scroll metrics whenever page zoom is not 100%.
// The follow library's smooth modes reconcile their own per-frame writes by
// exact position equality, so at fractional zoom the spring never reads as
// settled and its own frames can classify as user scrolling — following
// disengages or oscillates with zero user input (upstream:
// stackblitz-labs/use-stick-to-bottom#32, "only with smooth animation").
// Chromium keeps these metrics integral, which is why this never reproduced
// in development. CSS zoom on the root reproduces Safari's zoomed layout.
const PAGE_ZOOM = '1.63'

// Three thinking blocks long enough to overfill the card (internal scrolling
// while live), so each pass ending collapses the card by its full body height
// — a large one-commit shrink at the live edge while streaming continues.
const PROMPT = 'think long passes please'

declare global {
  interface Window {
    __rec?: {
      frames: Array<Record<string, number>>
      scrolls: Array<Record<string, number>>
    }
  }
}

function installRecorder(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
    const body = el.querySelector<HTMLElement>('[role="log"]')!
    const rec: NonNullable<Window['__rec']> = { frames: [], scrolls: [] }
    window.__rec = rec
    el.addEventListener(
      'scroll',
      () => {
        rec.scrolls.push({ t: performance.now(), scrollTop: el.scrollTop })
      },
      { passive: true },
    )
    const sample = () => {
      const pillVisible = [...document.querySelectorAll('button')].some(
        (b) => b.textContent?.includes('Scroll to bottom') && b.offsetParent !== null,
      )
      rec.frames.push({
        t: performance.now(),
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        bodyHeight: body.offsetHeight,
        pill: pillVisible ? 1 : 0,
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

function scrollMetrics(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    }
  })
}

test.describe('WebKit fractional-zoom live follow', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Safari Follow ${testInfo.workerIndex}-${Date.now()}`)

    // Zoom AFTER the app is up so every subsequent layout — and every scroll
    // metric the follow code reads — is fractional, as in a zoomed Safari.
    await page.evaluate((zoom) => {
      document.documentElement.style.setProperty('zoom', zoom)
    }, PAGE_ZOOM)
  })

  test('keeps following through streaming and thinking collapses with zero input', async ({ page }, testInfo) => {
    test.setTimeout(240000)

    // A long transcript first, so the scroller has real scroll range and the
    // collapse clamps land against a distant maximum.
    await sessionPage.sendMessage('stream a long story please')
    await sessionPage.waitForUserMessageCount(1)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')
            return el ? el.scrollHeight - el.clientHeight : 0
          }),
        { timeout: 60000 },
      )
      .toBeGreaterThan(1500)
    // The story turn must fully END before the next prompt — a message sent
    // mid-turn is queued as a steering command and the scenario never runs.
    await expect(sessionPage.getStopButton()).toBeHidden({ timeout: 30000 })

    await sessionPage.sendMessage(PROMPT)
    await sessionPage.waitForUserMessageCount(2)
    await expect(page.getByTestId('message-list')).toBeVisible()
    await installRecorder(page)

    // No input of any kind from here: the hands-off reader riding the live
    // edge. Following must survive the whole turn.
    try {
      await expect(
        page.getByText('Done with all long thinking passes'),
      ).toBeVisible({ timeout: 120000 })

      await expect
        .poll(async () => (await scrollMetrics(page)).distanceFromBottom, { timeout: 15000 })
        .toBeLessThan(90)
      await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeHidden()
    } finally {
      const rec = await page.evaluate(() => window.__rec).catch(() => null)
      if (rec) {
        writeFileSync(testInfo.outputPath('follow-recorder.json'), JSON.stringify(rec))
        console.log(
          `[recorder] frames=${rec.frames.length} scrolls=${rec.scrolls.length} -> ${testInfo.outputPath('follow-recorder.json')}`,
        )
      }
    }
  })
})
