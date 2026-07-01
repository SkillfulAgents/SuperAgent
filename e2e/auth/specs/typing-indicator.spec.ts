import { test, expect } from '@playwright/test'
import { AuthPage } from '../pages/auth.page'
import { AppPage } from '../../pages/app.page'
import { SessionPage } from '../../pages/session.page'

/**
 * Regression test for SUP-158:
 * "Auth mode — sometimes will show own user's typing indicator while they type
 *  (should not show self)".
 *
 * The typing indicator is a shared-session (auth mode) feature: when a peer is
 * typing in the same session, the others see a "..." bubble. The server
 * broadcasts the `user_typing` event to EVERY SSE client of the session —
 * including the user who triggered it — so the sender's own browser receives an
 * echo of its own typing event. Peer *messages* are self-filtered on the client
 * (sender.id === user.id), but the typing indicator is not, so the sender ends
 * up rendering a typing bubble for themselves.
 *
 * This test runs with a single user: they type into their own session composer
 * and must NOT see a typing indicator. With the bug present, the self-echo makes
 * the indicator appear; with the fix, it stays hidden.
 *
 * Uses a fresh isolated context (base `test`, not the multi-user fixture) so it
 * doesn't couple to the serial auth-flow / auth-settings narratives. The auth
 * suite leaves signup in "open" mode, and a fresh DB makes the first signup an
 * admin — either way a unique-email signup lands in the app.
 */
test('auth mode: a user does not see their own typing indicator', async ({ page }) => {
  const authPage = new AuthPage(page)
  const appPage = new AppPage(page)
  const sessionPage = new SessionPage(page)

  const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const user = {
    name: 'Typing Tester',
    email: `typing-${unique}@test.com`,
    password: 'password123',
  }

  // Sign up a fresh user and land in the app.
  await page.goto('/')
  await authPage.expectVisible()
  await authPage.signUp(user.name, user.email, user.password)
  await appPage.waitForAppLoaded()
  await appPage.dismissWizardIfVisible()

  // Create an agent and open its first session (the typing indicator only
  // renders inside the session chat view, and the typing POST only fires once a
  // sessionId exists). The home composer creates the session and navigates to it.
  await page.locator('[data-testid="new-agent-button"]').click()
  await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText('Untitled', { timeout: 10000 })
  await page.locator('[data-testid="home-message-input"]').fill('Hello from the typing test')
  await page.locator('[data-testid="home-send-button"]').click()

  // We're now in the session chat view: wait for it to settle.
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 15000 })
  await sessionPage.waitForUserMessageCount(1)
  await sessionPage.waitForResponse(15000)

  // Type into the per-session composer WITHOUT sending. The first keystroke fires
  // the debounced typing notification, which the server echoes back to us over SSE.
  const composer = page.locator('[data-testid="message-input"]')
  await expect(composer).toBeVisible()

  const typingPosted = page.waitForResponse(
    (res) => res.url().includes('/typing') && res.request().method() === 'POST',
    { timeout: 10000 }
  )
  await composer.click()
  // Typing spans ~0.5s; the first keystroke fires the (debounced) typing POST
  // immediately, so the server's self-echo round-trips and is processed before
  // pressSequentially even returns.
  await composer.pressSequentially('typing a message…', { delay: 30 })

  // Confirm the typing event reached the server and broadcast (proves the
  // pipeline ran — otherwise the assertion below could pass vacuously).
  await typingPosted

  // The bug: the self-echo renders the user's OWN typing indicator. With the bug
  // present it is already visible by now and stays up for a 5s auto-clear window;
  // toBeHidden therefore keeps failing until it gives up. The 3s timeout is
  // deliberately shorter than that 5s auto-clear, so the auto-clear cannot turn
  // this into a false pass. With the fix, the indicator is never rendered.
  const indicator = page.locator('[data-testid="typing-indicator"]')
  await expect(indicator, 'a user must never see their OWN typing indicator').toBeHidden({ timeout: 3000 })
})
