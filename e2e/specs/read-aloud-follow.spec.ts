import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Runs under web-webkit (where the failure reproduces) and web-chromium (as
// the control that never moved).
//
// Pressing the speaker under the LAST reply re-renders that reply at the live
// edge: the action row swaps its children and every prose word gains a span.
// WebKit answers that commit by moving the viewport a row's worth up, with
// scrollHeight and clientHeight already back at their old values by the time
// the scroll event fires — by geometry alone, a reader escaping. The follow
// engine attributes the move to the commit (COMMIT_ROLLBACK_WINDOW_MS in
// use-message-list-scroll.ts) and puts the viewport straight back: the
// scroll-to-bottom pill must never show, in any frame, and the live edge must
// hold through both re-renders (controls in, controls out).

declare global {
  interface Window {
    __pillRec?: {
      frames: number
      pillFrames: number
      maxDistance: number
      scrolls: Array<Record<string, number>>
      pill: Array<Record<string, number>>
    }
  }
}

function installPillRecorder(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
    const rec: NonNullable<Window['__pillRec']> = { frames: 0, pillFrames: 0, maxDistance: 0, scrolls: [], pill: [] }
    window.__pillRec = rec
    const t0 = performance.now()
    el.addEventListener(
      'scroll',
      () => {
        rec.scrolls.push({
          t: Math.round(performance.now() - t0),
          top: Math.round(el.scrollTop),
          sh: el.scrollHeight,
          ch: el.clientHeight,
        })
      },
      { passive: true },
    )
    let lastPill = 0
    const sample = () => {
      const pill = [...document.querySelectorAll('button')].some(
        (b) => b.textContent?.includes('Scroll to bottom') && b.offsetParent !== null,
      )
        ? 1
        : 0
      rec.frames += 1
      if (pill) rec.pillFrames += 1
      if (pill !== lastPill) {
        rec.pill.push({ t: Math.round(performance.now() - t0), pill, top: Math.round(el.scrollTop) })
        lastPill = pill
      }
      rec.maxDistance = Math.max(rec.maxDistance, el.scrollHeight - el.scrollTop - el.clientHeight)
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

function distanceFromBottom(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
    return el.scrollHeight - el.scrollTop - el.clientHeight
  })
}

test.describe('read-aloud at the live edge', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    // Speech is "configured" for this page only. The token endpoint refuses,
    // so no audio is ever fetched: the press goes connecting → error, which
    // re-renders the reply exactly the way play → stop does.
    await page.route('**/api/voice/configured', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: true,
          supportsVoiceAgent: false,
          supportsTts: true,
          voices: [{ id: 'aura-2-thalia-en', label: 'Thalia', description: 'Clear, confident, energetic' }],
          defaultVoice: 'aura-2-thalia-en',
        }),
      }),
    )
    await page.route('**/api/voice/tts-token', async (route) => {
      // Long enough for the connecting render to paint and settle on its own,
      // and for the menu-item click to return (WebKit takes most of a second
      // to close the menu) before the connecting state is asserted.
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'No speech in tests' }),
      })
    })

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Read Aloud Follow ${testInfo.workerIndex}-${Date.now()}`)
  })

  test('keeps following when the speaker under the last reply is pressed', async ({ page }) => {
    test.setTimeout(120000)

    // A long transcript, so the scroller has real range and the reply under
    // test sits at the live edge with content above it to clamp against.
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
    await expect(sessionPage.getStopButton()).toBeHidden({ timeout: 30000 })
    await expect.poll(() => distanceFromBottom(page), { timeout: 10000 }).toBeLessThan(24)
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeHidden()

    // Open the message menu at a point near the reply's bottom edge, which is
    // on screen: a point nearer its top would make Playwright scroll it into
    // view, and that programmatic jump (rightly) releases following before
    // the press under test.
    const reply = page.getByTestId('message-assistant').last()
    const box = await reply.boundingBox()
    if (!box) throw new Error('the reply has no box')
    await reply.click({ button: 'right', position: { x: 24, y: box.height - 12 } })
    const readAloudItem = page.getByRole('menuitem', { name: 'Read aloud' })
    await expect(readAloudItem).toBeVisible()
    await expect.poll(() => distanceFromBottom(page)).toBeLessThan(24)
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeHidden()
    await installPillRecorder(page)

    await readAloudItem.click()

    // Controls in, spans in — the first re-render.
    const controls = reply.getByTestId('read-aloud-controls')
    await expect(controls).toHaveAttribute('data-status', 'connecting')
    await expect.poll(() => reply.locator('[data-spoken-word]').count()).toBeGreaterThan(0)
    await expect(reply.getByTestId('read-aloud-stop')).toBeVisible()

    // Controls out, spans out — the second re-render, on the refused token.
    await expect(reply.getByTestId('read-aloud-error')).toHaveText('No speech in tests', { timeout: 10000 })
    await expect(reply.locator('[data-spoken-word]')).toHaveCount(0)
    // The failed read leaves a speaker to try again.
    await expect(reply.getByTestId('read-aloud-button')).toBeVisible()

    // Following held the whole way: the pill was never painted, the viewport
    // is back on the live edge, and nothing is left dangling above it.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const rec = await page.evaluate(() => window.__pillRec!)
    console.log(
      `[read-aloud-follow] frames=${rec.frames} pillFrames=${rec.pillFrames} maxDistance=${rec.maxDistance}` +
        ` scrolls=${JSON.stringify(rec.scrolls)} pill=${JSON.stringify(rec.pill)}`,
    )
    await expect.poll(() => distanceFromBottom(page), { timeout: 5000 }).toBeLessThan(24)
    // rAF sampling is throttled under parallel workers, so the frame count is
    // only a sanity check; the scroll events are the frame-independent record.
    expect(rec.frames).toBeGreaterThan(0)
    expect(rec.pillFrames).toBe(0)
    // WebKit reports the engine's put-back as a scroll event already at the
    // live edge; Chromium never moves at all and reports nothing. (The
    // controls overlay the reply rather than adding a row to it: a row
    // appearing at the live edge would grow the content, and WebKit answers
    // that by jumping the transcript to its top.)
    for (const s of rec.scrolls) expect(s.sh - s.ch - s.top).toBeLessThan(24)
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeHidden()
  })
})
