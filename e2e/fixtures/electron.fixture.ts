/* eslint-disable react-hooks/rules-of-hooks */
import { test as base, _electron as electron, ElectronApplication, Page } from '@playwright/test'

// Extend the base test with Electron-specific fixtures
export const test = base.extend<{
  electronApp: ElectronApplication
  page: Page
}>({
  electronApp: async (_, use) => {
    const app = await electron.launch({
      args: ['./dist/main/index.js'],
      env: { ...process.env, E2E_MOCK: 'true' },
    })
    await use(app)
    await app.close()
  },
  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    // Wait for the app to be ready
    await page.waitForLoadState('domcontentloaded')
    await use(page)
  },
})

export { expect } from '@playwright/test'
