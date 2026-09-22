import { writeFileSync } from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Regression for the send/turn-end reading-line jumps: content mounting
// ABOVE the anchored turn (the previous turn's summary header at
// materialization; the persisted swap + header at turn end) used to slide
// the reading line down the screen in a single frame (~120px) because the
// reserve math kept stale anchor coordinates. Samples the last user
// message's viewport position every frame across a short turn and bounds
// its frame-to-frame movement.

declare global {
  interface Window {
    __rec2?: Array<Record<string, number | string>>
  }
}

function installRecorder(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid="message-list"]')!
    const rec: NonNullable<Window['__rec2']> = []
    window.__rec2 = rec
    const sample = () => {
      const spacer = el.querySelector<HTMLElement>('[data-testid="turn-anchor-spacer"]')
      const clearance = el.querySelector<HTMLElement>('[data-testid="live-edge-clearance"]')
      const userMsgs = el.querySelectorAll<HTMLElement>('[data-testid="message-user"]')
      const lastUser = userMsgs[userMsgs.length - 1]
      const pill = [...document.querySelectorAll('button')].some(
        (b) => b.textContent?.includes('Scroll to bottom') && b.offsetParent !== null,
      )
      rec.push({
        t: Math.round(performance.now()),
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        spacer: spacer ? Math.round(Number.parseFloat(spacer.style.height || '0')) : -1,
        clearance: clearance ? Math.round(clearance.getBoundingClientRect().height) : -1,
        userTopInViewport: lastUser ? Math.round(lastUser.getBoundingClientRect().top) : -1,
        pill: pill ? 1 : 0,
        userCount: userMsgs.length,
      })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
}

test.describe('turn end jump recorder', () => {
  test('records send-through-idle geometry', async ({ page }, testInfo) => {
    test.setTimeout(120000)
    const appPage = new AppPage(page)
    const agentPage = new AgentPage(page)
    const sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Turn End ${testInfo.workerIndex}-${Date.now()}`)

    // A first short turn so the NEXT send has a previous turn to finalize
    // (the "Worked for Ns" header mount is part of the 00:02 jump).
    await sessionPage.sendMessage('hello there')
    await sessionPage.waitForUserMessageCount(1)
    await expect(sessionPage.getStopButton()).toBeHidden({ timeout: 30000 })

    await installRecorder(page)
    await sessionPage.sendMessage('thanks')
    await sessionPage.waitForUserMessageCount(2)
    await expect(sessionPage.getStopButton()).toBeHidden({ timeout: 30000 })
    // Ride out the post-turn settling: keep recording until ~90 more frames
    // (≈1.5s) have accumulated after the turn ended.
    const framesAtIdle = await page.evaluate(() => window.__rec2?.length ?? 0)
    await expect
      .poll(() => page.evaluate(() => window.__rec2?.length ?? 0), { timeout: 15000 })
      .toBeGreaterThan(framesAtIdle + 90)

    const rec = await page.evaluate(() => window.__rec2)
    writeFileSync(testInfo.outputPath('turn-end-recorder.json'), JSON.stringify(rec))
    console.log(`[recorder] samples=${rec?.length} -> ${testInfo.outputPath('turn-end-recorder.json')}`)

    expect(rec).toBeTruthy()
    expect(rec!.length).toBeGreaterThan(50)
    // The reading line may travel smoothly (the send glide moves it ~15px a
    // frame) but must never teleport. Pre-fix this measured +116 at
    // materialization and +120 at turn end.
    let maxFrameJump = 0
    for (let i = 1; i < rec!.length; i++) {
      // A frame where a user row mounts or unmounts legitimately changes
      // which element is "the last user message" — only positional jumps of
      // a stable set count.
      if (rec![i].userCount !== rec![i - 1].userCount) continue
      const a = rec![i - 1].userTopInViewport as number
      const b = rec![i].userTopInViewport as number
      if (a >= 0 && b >= 0) maxFrameJump = Math.max(maxFrameJump, Math.abs(b - a))
    }
    expect(maxFrameJump).toBeLessThan(60)
    // Zero input in this test: the pill must never appear.
    expect(rec!.every((f) => f.pill === 0)).toBe(true)
  })
})
