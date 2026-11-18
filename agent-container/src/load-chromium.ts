import type { BrowserType } from 'playwright-core'

/**
 * Playwright's Chromium driver, loaded on first use. playwright-core is 278
 * modules, about a third of what the server loads before it listens, and only
 * a browser upload, a browser download or a rasterization needs it.
 */
export async function loadChromium(): Promise<BrowserType> {
  return (await import('playwright-core')).chromium
}
