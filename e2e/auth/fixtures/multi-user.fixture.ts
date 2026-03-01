import { test as base, type BrowserContext, type Page } from '@playwright/test'

const BASE_URL = 'http://localhost:3001'

/**
 * Multi-user fixture for auth E2E tests.
 * Uses worker-scoped fixtures so browser contexts persist across serial tests.
 * Each user gets an isolated cookie jar sharing the same server.
 */
export const test = base.extend<
  // Test-scoped fixtures (none)
  object,
  // Worker-scoped fixtures (persist across tests)
  {
    user1Context: BrowserContext
    user1Page: Page
    user2Context: BrowserContext
    user2Page: Page
    user3Context: BrowserContext
    user3Page: Page
  }
>({
  user1Context: [async ({ browser }, use) => {
    const context = await browser.newContext()
    await use(context)
    await context.close()
  }, { scope: 'worker' }],

  user1Page: [async ({ user1Context }, use) => {
    const page = await user1Context.newPage()
    await page.goto(BASE_URL)
    await use(page)
  }, { scope: 'worker' }],

  user2Context: [async ({ browser }, use) => {
    const context = await browser.newContext()
    await use(context)
    await context.close()
  }, { scope: 'worker' }],

  user2Page: [async ({ user2Context }, use) => {
    const page = await user2Context.newPage()
    await page.goto(BASE_URL)
    await use(page)
  }, { scope: 'worker' }],

  user3Context: [async ({ browser }, use) => {
    const context = await browser.newContext()
    await use(context)
    await context.close()
  }, { scope: 'worker' }],

  user3Page: [async ({ user3Context }, use) => {
    const page = await user3Context.newPage()
    await page.goto(BASE_URL)
    await use(page)
  }, { scope: 'worker' }],
})

export { expect } from '@playwright/test'
