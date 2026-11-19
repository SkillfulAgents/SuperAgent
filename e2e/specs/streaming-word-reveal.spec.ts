import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// The MockContainerClient 'stream a long story' scenario: ~1,350 words, one
// every 5 ms, so a few dozen word spans are mid-reveal at any moment.
const SAGA_PROMPT = 'stream a long story please'
const WORD = '.streaming-word-reveal'

interface RevealRecord {
  /** Words whose reveal animation started. */
  started: number
  /** Every property any of those animations' keyframes set. */
  animated: string[]
  /** Computed `filter` / `will-change` values seen on a word as it started. */
  filters: string[]
  willChange: string[]
}

declare global {
  interface Window {
    __wordReveal?: RevealRecord
  }
}

/** Record what each word's reveal animates, from the moment it starts. */
async function recordReveals(page: Page) {
  await page.evaluate(() => {
    const record: RevealRecord = { started: 0, animated: [], filters: [], willChange: [] }
    const add = (list: string[], value: string) => {
      if (!list.includes(value)) list.push(value)
    }
    window.__wordReveal = record
    document.addEventListener('animationstart', (event) => {
      if (event.animationName !== 'streaming-word-reveal') return
      const word = event.target as HTMLElement
      record.started++
      const style = getComputedStyle(word)
      add(record.filters, style.filter)
      add(record.willChange, style.willChange)
      for (const animation of word.getAnimations()) {
        const effect = animation.effect
        if (!(effect instanceof KeyframeEffect)) continue
        for (const keyframe of effect.getKeyframes()) {
          for (const property of Object.keys(keyframe)) {
            if (!['offset', 'computedOffset', 'easing', 'composite'].includes(property)) add(record.animated, property)
          }
        }
      }
    })
  })
}

test.describe('Streaming word reveal', () => {
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    const appPage = new AppPage(page)
    const agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Reveal Agent ${testInfo.workerIndex}-${Date.now()}`)
  })

  test('fades each streamed word in on opacity alone, with no filter', async ({ page }) => {
    await recordReveals(page)
    await sessionPage.sendMessage(SAGA_PROMPT)
    await sessionPage.waitForResponse(15000)

    await expect
      .poll(() => page.evaluate(() => window.__wordReveal?.started ?? 0), { timeout: 15000 })
      .toBeGreaterThan(50)

    const record = await page.evaluate(() => window.__wordReveal!)
    // A blur on each word is a filter pass per word per frame: the reveal is
    // an opacity fade, which the compositor runs without one.
    expect(record.animated).toEqual(['opacity'])
    expect(record.filters).toEqual(['none'])
    expect(record.willChange).toEqual(['auto'])
  })

  test('shows streamed words at once under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await recordReveals(page)
    await sessionPage.sendMessage(SAGA_PROMPT)
    await sessionPage.waitForResponse(15000)

    await expect.poll(() => page.locator(WORD).count(), { timeout: 15000 }).toBeGreaterThan(50)

    const state = await page.evaluate((selector) => {
      const words = Array.from(document.querySelectorAll<HTMLElement>(selector))
      const newest = getComputedStyle(words[words.length - 1])
      return {
        started: window.__wordReveal?.started ?? 0,
        running: words.reduce((count, word) => count + word.getAnimations().length, 0),
        animationName: newest.animationName,
        opacity: newest.opacity,
        filter: newest.filter,
      }
    }, WORD)
    expect(state).toEqual({ started: 0, running: 0, animationName: 'none', opacity: '1', filter: 'none' })
  })
})
