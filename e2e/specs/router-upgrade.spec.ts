import { expect, test } from '@playwright/test'
import { isWebKitTeardownFetchError } from '../helpers/page-errors'
import { isExpectedRouterScenarioError, routerNavigationScenarios } from '../helpers/router-navigation'

for (const [name, scenario] of routerNavigationScenarios) {
  test(name, async ({ page, request, baseURL, browserName }, testInfo) => {
    const errors: string[] = []
    const diagnostics: Array<{ at: string; kind: string; url?: string; message?: string }> = []
    const record = (event: Omit<typeof diagnostics[number], 'at'>) => diagnostics.push({ at: new Date().toISOString(), ...event })
    page.on('pageerror', error => {
      if (!isWebKitTeardownFetchError(page, error)) errors.push(error.message)
      record({ kind: 'pageerror', url: page.url(), message: error.message })
    })
    page.on('console', message => {
      if (message.type() === 'error') record({ kind: 'console-error', url: page.url(), message: message.text() })
    })
    page.on('requestfailed', request => {
      if (request.url().includes('/api/')) record({ kind: 'request-failed', url: request.url(), message: request.failure()?.errorText })
    })
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) record({ kind: 'navigation', url: frame.url() })
    })
    try {
      await scenario({ page, request, apiBaseUrl: baseURL!, navigate: route => page.goto(route), runtime: 'web' })
    } finally {
      if (diagnostics.some(event => event.kind !== 'navigation')) {
        await testInfo.attach('router-request-diagnostics', {
          body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json',
        })
      }
    }
    // Keep WebKit's existing layout notification visible in the report, as in
    // pdf-preview.spec.ts. All route, draft and persistence assertions above
    // must still pass; every other unexpected JavaScript error fails the test.
    const layoutNotification = 'ResizeObserver loop completed with undelivered notifications.'
    const layoutErrors = errors.filter(message => browserName === 'webkit' && message === layoutNotification)
    if (layoutErrors.length) testInfo.annotations.push({ type: 'browser-layout', description: `${layoutNotification} (${layoutErrors.length})` })
    expect(errors.filter(message => !isExpectedRouterScenarioError(scenario, message)
      && !(browserName === 'webkit' && message === layoutNotification))).toEqual([])
  })
}
