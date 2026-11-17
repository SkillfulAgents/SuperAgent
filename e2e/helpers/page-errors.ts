import type { Page } from '@playwright/test'

/**
 * WebKit refuses a fetch started while the page is unloading and logs "Fetch API
 * cannot load <url> due to access control checks." Playwright reports that log as
 * a pageerror, so a reload or goto that lands on background work fails a test that
 * asserts no page errors, even though the page is already going away.
 *
 * Playwright splits the text at its first colon, the one in "http:", which leaves
 * the name "Fetch API cannot load http" and the message "/localhost:3000/api/x due
 * to access control checks." Only same-origin URLs match: a same-origin fetch cannot
 * fail a real CORS check, so a genuine cross-origin failure still counts.
 */
export function isWebKitTeardownFetchError(page: Page, error: Error): boolean {
  if (!error.name.startsWith('Fetch API cannot load')) return false
  const host = /^\/([^/]+)\/.* due to access control checks\.$/.exec(error.message)?.[1]
  return host === new URL(page.url()).host
}
