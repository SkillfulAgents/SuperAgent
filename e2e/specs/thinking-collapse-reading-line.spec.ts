import { writeFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Matches the 'think long passes' mock scenario: three thinking blocks, each
// overfilling the card's max-height (max-h-64 ≈ 256px body), so each pass
// ending collapses the card by its full body height.
const PROMPT = 'think long passes please'

// A reader who scrolled up LESS than the collapse height is inside the clamp
// zone: when the card body unmounts, scrollHeight shrinks below their
// scrollTop and the browser drags them along. overflow-anchor is disabled on
// the list, so no engine — ours or the browser's — holds the line today.
const ESCAPE_WHEEL_PX = 120

declare global {
  interface Window {
    __rlrec?: {
      frames: Array<Record<string, number>>
    }
  }
}

// Per-frame viewport-relative top of the last user row — the reading line a
// scrolled-up reader is visually holding. A stable hold keeps it constant;
// the clamp shows up as one large frame-over-frame delta at collapse time.
function installRecorder(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
    const rec: NonNullable<Window['__rlrec']> = { frames: [] }
    window.__rlrec = rec
    // Wheel input moves the viewport legitimately — tag frames near a wheel so
    // the jump metric only judges motion the user did not cause.
    let lastWheelT = -Infinity
    el.addEventListener('wheel', () => { lastWheelT = performance.now() }, { passive: true })
    const sample = () => {
      const anchors = el.querySelectorAll<HTMLElement>('[data-turn-anchor-id]')
      let anchorTop = NaN
      for (let i = anchors.length - 1; i >= 0; i--) {
        const r = anchors[i].getBoundingClientRect()
        if (r.height > 0) {
          anchorTop = r.top
          break
        }
      }
      const pillVisible = [...document.querySelectorAll('button')].some(
        (b) => b.textContent?.includes('Scroll to bottom') && b.offsetParent !== null,
      )
      rec.frames.push({
        t: performance.now(),
        wheelRecent: performance.now() - lastWheelT < 150 ? 1 : 0,
        anchorTop,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        openBodies: document.querySelectorAll('[data-testid="thinking-block-body"]').length,
        cards: document.querySelectorAll('[data-testid="thinking-block"]').length,
        pill: pillVisible ? 1 : 0,
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

test.describe('Reading line through a thinking-card collapse (escaped reader)', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`ReadingLine Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  // KNOWN FAILING — documents the outstanding escaped-reader bug: a reader
  // scrolled up less than the card-body height sits in the clamp zone, and the
  // collapse drags them (~110-210px, BOTH engines; overflow-anchor is disabled
  // and the reserve only guards positions above the anchor). Fix direction:
  // grow the bottom spacer to absorb mid-turn shrinks. Un-fixme when built.
  test.fixme('holds a scrolled-up reader through the collapse clamp', async ({ page }, testInfo) => {
    test.setTimeout(240000)

    // Real scroll range first, so the collapse clamps against a distant
    // maximum instead of degenerating to scrollTop 0.
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

    await sessionPage.sendMessage(PROMPT)
    await sessionPage.waitForUserMessageCount(2)
    await expect(page.getByTestId('message-list')).toBeVisible()

    // Wait for the THIRD pass to stream: by then the send-time turn reserve is
    // consumed (two full cards + chips grew past it), matching the deep-turn
    // shape in the field where the spacer can no longer absorb the shrink.
    await expect
      .poll(
        () =>
          page.evaluate(() => ({
            cards: document.querySelectorAll('[data-testid="thinking-block"]').length,
            open: document.querySelectorAll('[data-testid="thinking-block-body"]').length,
            bodyH:
              document.querySelector<HTMLElement>('[data-testid="thinking-block-body"]')
                ?.offsetHeight ?? 0,
          })),
        { timeout: 60000 },
      )
      .toMatchObject({ cards: 3, open: 1 })
    // Let the live body reach its max height so the collapse is full-size.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document.querySelector<HTMLElement>('[data-testid="thinking-block-body"]')
                ?.offsetHeight ?? 0,
          ),
        { timeout: 30000 },
      )
      .toBeGreaterThan(200)

    await installRecorder(page)

    // Escape with real input — a small scroll up, like a reader peeking at the
    // streaming thinking text. Lands INSIDE the clamp zone (< card body height).
    // Wheel over the TOP of the list: the live card's body is its own scroller,
    // and a wheel over it scrolls the card's interior, not the transcript.
    const list = page.getByTestId('message-list')
    const box = (await list.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + 60)
    await page.mouse.wheel(0, -ESCAPE_WHEEL_PX)
    await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible({
      timeout: 5000,
    })

    // Ride out the pass-3 collapse and the turn end.
    await expect(page.getByText('Done with all long thinking passes')).toBeVisible({
      timeout: 60000,
    })
    // A few settle frames past the collapse.
    const framesNow = await page.evaluate(() => window.__rlrec?.frames.length ?? 0)
    await expect
      .poll(() => page.evaluate(() => window.__rlrec?.frames.length ?? 0), { timeout: 10000 })
      .toBeGreaterThan(framesNow + 30)

    const rec = await page.evaluate(() => window.__rlrec!)
    writeFileSync(testInfo.outputPath('reading-line-recorder.json'), JSON.stringify(rec))
    console.log(
      `[recorder] frames=${rec.frames.length} -> ${testInfo.outputPath('reading-line-recorder.json')}`,
    )

    // The reading line must hold: no single frame may displace the reader's
    // reference row by more than a text-reflow's worth. The collapse clamp
    // fails this by ~(card body − distanceFromBottom) pixels in one frame.
    let maxJump = 0
    let jumpAt = -1
    for (let i = 1; i < rec.frames.length; i++) {
      const a = rec.frames[i - 1]
      const b = rec.frames[i]
      if (!Number.isFinite(a.anchorTop) || !Number.isFinite(b.anchorTop)) continue
      if (a.wheelRecent || b.wheelRecent) continue
      const d = Math.abs(b.anchorTop - a.anchorTop)
      if (d > maxJump) {
        maxJump = d
        jumpAt = i
      }
    }
    console.log(
      `[reading-line] maxJump=${maxJump.toFixed(1)}px at frame ${jumpAt} ` +
        `(openBodies ${rec.frames[jumpAt - 1]?.openBodies}→${rec.frames[jumpAt]?.openBodies}, ` +
        `scrollTop ${rec.frames[jumpAt - 1]?.scrollTop}→${rec.frames[jumpAt]?.scrollTop})`,
    )
    expect(maxJump).toBeLessThan(40)
  })

  // The field report: the user touches NOTHING. The app is following the
  // stream, a big thinking card collapses, and following silently dies — the
  // scroll-to-bottom pill appears and the viewport is left stranded above the
  // live edge. Zero input for the whole turn; following must survive every
  // collapse (three pass-end collapses plus the turn-end persisted swap).
  test('hands off: following survives every thinking-card collapse', async ({ page }, testInfo) => {
    test.setTimeout(240000)

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

    await sessionPage.sendMessage(PROMPT)
    await sessionPage.waitForUserMessageCount(2)
    await expect(page.getByTestId('message-list')).toBeVisible()
    await installRecorder(page)

    await expect(page.getByText('Done with all long thinking passes')).toBeVisible({
      timeout: 120000,
    })
    // Settle frames past the turn end.
    const framesNow = await page.evaluate(() => window.__rlrec?.frames.length ?? 0)
    await expect
      .poll(() => page.evaluate(() => window.__rlrec?.frames.length ?? 0), { timeout: 10000 })
      .toBeGreaterThan(framesNow + 30)

    const rec = await page.evaluate(() => window.__rlrec!)
    writeFileSync(testInfo.outputPath('handsoff-recorder.json'), JSON.stringify(rec))

    const pillFrames = rec.frames.filter((f) => f.pill === 1)
    const firstPill = rec.frames.findIndex((f) => f.pill === 1)
    const ctx = firstPill > 0 ? rec.frames[firstPill] : null
    console.log(
      `[hands-off] frames=${rec.frames.length} pillFrames=${pillFrames.length}` +
        (ctx
          ? ` firstPill@${firstPill} (scrollTop=${ctx.scrollTop} scrollHeight=${ctx.scrollHeight} openBodies=${ctx.openBodies} cards=${ctx.cards})`
          : ''),
    )

    const final = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
      return el.scrollHeight - el.scrollTop - el.clientHeight
    })
    console.log(`[hands-off] final distanceFromBottom=${final}`)

    // Following must never have disengaged.
    expect(pillFrames.length).toBe(0)
    expect(final).toBeLessThan(90)
  })

  // Same hands-off shape but a DEEP turn: eight passes, running well past the
  // send-time reserve — closer to the long real turns where follow-loss is
  // reported in the field.
  test('hands off marathon: following survives a deep multi-pass turn', async ({ page }, testInfo) => {
    test.setTimeout(240000)

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

    await sessionPage.sendMessage('think a marathon please')
    await sessionPage.waitForUserMessageCount(2)
    await expect(page.getByTestId('message-list')).toBeVisible()
    await installRecorder(page)

    await expect(page.getByText('Done with the marathon of thinking passes')).toBeVisible({
      timeout: 120000,
    })
    const framesNow = await page.evaluate(() => window.__rlrec?.frames.length ?? 0)
    await expect
      .poll(() => page.evaluate(() => window.__rlrec?.frames.length ?? 0), { timeout: 10000 })
      .toBeGreaterThan(framesNow + 30)

    const rec = await page.evaluate(() => window.__rlrec!)
    writeFileSync(testInfo.outputPath('marathon-recorder.json'), JSON.stringify(rec))

    const pillFrames = rec.frames.filter((f) => f.pill === 1)
    const firstPill = rec.frames.findIndex((f) => f.pill === 1)
    const ctx = firstPill > 0 ? rec.frames[firstPill] : null
    console.log(
      `[marathon] frames=${rec.frames.length} pillFrames=${pillFrames.length}` +
        (ctx
          ? ` firstPill@${firstPill} (scrollTop=${ctx.scrollTop} scrollHeight=${ctx.scrollHeight} openBodies=${ctx.openBodies} cards=${ctx.cards})`
          : ''),
    )
    const final = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
      return el.scrollHeight - el.scrollTop - el.clientHeight
    })
    console.log(`[marathon] final distanceFromBottom=${final}`)

    expect(pillFrames.length).toBe(0)
    expect(final).toBeLessThan(90)
  })
})
