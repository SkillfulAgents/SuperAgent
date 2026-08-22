import { writeFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Matches the 'think long passes' mock scenario: three thinking blocks, each
// long enough to overfill the card's max-height (internal scrolling while
// live), so each pass ending collapses the card by its full body height —
// a large one-commit content shrink at the live edge while the turn continues.
const PROMPT = 'think long passes please'

declare global {
  interface Window {
    __rec?: {
      frames: Array<Record<string, number>>
      scrolls: Array<Record<string, number>>
    }
  }
}

// Per-frame samples of the scroll geometry and the escape affordance, dumped
// to the test output dir — when a run fails, the timeline around each collapse
// is the diagnosis.
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
        cards: document.querySelectorAll('[data-testid="thinking-block"]').length,
        openBodies: document.querySelectorAll('[data-testid="thinking-block-body"]').length,
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

test.describe('Live thinking-card collapse', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Collapse Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  test('keeps following through thinking-card collapses with an idle held pointer', async ({ page }, testInfo) => {
    test.setTimeout(240000)

    // A long transcript first, so the scroller has real scroll range: each
    // collapse must clamp scrollTop against a distant maximum (a transcript
    // that fits the viewport degenerates — scrollTop just pins to 0).
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
    // mid-turn is recorded as a queued steering command and the thinking
    // scenario never runs.
    await expect(sessionPage.getStopButton()).toBeHidden({ timeout: 30000 })

    await sessionPage.sendMessage(PROMPT)
    await sessionPage.waitForUserMessageCount(2)
    await expect(page.getByTestId('message-list')).toBeVisible()
    await installRecorder(page)

    // Zero scrolling, zero physical buttons — just a pointer the app BELIEVES
    // is down: a press whose release was swallowed (a two-finger-tap context
    // menu, focus moving away) leaves exactly this state behind. It must not
    // turn the collapse clamps into "the user scrolled up" and kill
    // following. (A physically held button is deliberately not used: content
    // streaming under a real pressed cursor grows a text selection, and the
    // follow library rightly pauses during selection.)
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 200,
          clientY: 300,
        }),
      )
    })

    try {
      // Wait out the whole turn (3 passes, then the answer text).
      await expect(
        page.getByText('Done with all long thinking passes'),
      ).toBeVisible({ timeout: 120000 })

      // Following must never have disengaged: at the end the viewport sits at
      // the live edge with no scroll-to-bottom affordance.
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
