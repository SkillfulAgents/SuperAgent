import { test, expect } from '@playwright/test'
import { SessionPage } from '../pages/session.page'

test('sending waits for a slow navigation without retrying the submitted message', async ({ page, baseURL }) => {
  let submissions = 0
  await page.route('**/__send-helper-complete*', async (route) => {
    submissions++
    // Reproduce the former helper's one-second click timeout after dispatch.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await route.fulfill({ contentType: 'text/html', body: '<h1>Message received</h1>' })
  })
  await page.setContent(`
    <form action="${baseURL}/__send-helper-complete" onsubmit="this.querySelector('button').disabled = true">
      <div contenteditable="true" data-testid="home-message-input"></div>
      <button type="submit" data-testid="home-send-button">Send</button>
    </form>
  `)

  await new SessionPage(page).sendMessage('hello')

  await expect(page.getByRole('heading', { name: 'Message received' })).toBeVisible()
  expect(submissions).toBe(1)
})
