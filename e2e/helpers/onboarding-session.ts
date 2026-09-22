import { expect, type Page } from '@playwright/test'

export const ONBOARDING_MESSAGE =
  'This agent was just set up from a template. Please run the agent-onboarding skill to help me configure it.'

const NOT_FOUND_SELECTOR = '[data-testid="session-transcript-not-found"]'

declare global {
  interface Window {
    __e2eTranscriptNotFoundSeen?: boolean
  }
}

/**
 * Start recording whether the "Session transcript not found" card is ever
 * mounted. Call this BEFORE the action that opens the onboarding session (the
 * install / import click): the card can show for a few hundred ms and be gone
 * again by the time a locator looks, so a Playwright assertion after the fact
 * would race past it. The observer lives in the document, so it survives the
 * in-app navigation into the session but not a full page load.
 */
export async function armTranscriptNotFoundWatch(page: Page) {
  await page.evaluate((selector) => {
    window.__e2eTranscriptNotFoundSeen = !!document.querySelector(selector)
    // React reuses the loading placeholder's <div> for the card (same element
    // type, same slot), so the card can arrive as an ATTRIBUTE change on an
    // existing node plus children inserted under it — never as an added node
    // carrying the test id. Check all three shapes, and the live document.
    const observer = new MutationObserver((mutations) => {
      if (document.querySelector(selector)) {
        window.__e2eTranscriptNotFoundSeen = true
        return
      }
      for (const mutation of mutations) {
        const target = mutation.target instanceof HTMLElement ? mutation.target : null
        if (target?.matches(selector) || target?.closest(selector)) {
          window.__e2eTranscriptNotFoundSeen = true
          return
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.matches(selector) || node.querySelector(selector)) {
            window.__e2eTranscriptNotFoundSeen = true
            return
          }
        }
      }
    })
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-testid'],
    })
  }, NOT_FOUND_SELECTOR)
}

/**
 * The onboarding session opens BEFORE the container has written its transcript
 * (the mock holds the first line back for ~1.5 s, like a cold agent does). Wait
 * for the onboarding prompt to land, then check the card never showed in the
 * meantime — the whole point of that window is that the user sees an agent
 * working, never a missing session. Requires `armTranscriptNotFoundWatch`.
 */
export async function expectOnboardingSessionToOpenCleanly(page: Page, timeoutMs = 20_000) {
  await expect(page).toHaveURL(/\/agents\/[^/]+\/sessions\//, { timeout: timeoutMs })
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: timeoutMs })
  await expect(
    page.locator('[data-testid="message-user"]').filter({ hasText: ONBOARDING_MESSAGE }),
  ).toBeVisible({ timeout: timeoutMs })

  const seen = await page.evaluate(() => window.__e2eTranscriptNotFoundSeen)
  expect(seen, 'armTranscriptNotFoundWatch must be called before opening the session').toBeDefined()
  expect(seen, '"Session transcript not found" must never show while the onboarding session starts').toBe(false)
}
