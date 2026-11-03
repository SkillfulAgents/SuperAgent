import { expect, test } from '@playwright/test'
import { isExpectedRouterScenarioError, routerNavigationScenarios } from '../helpers/router-navigation'

for (const [name, scenario] of routerNavigationScenarios) {
  test(name, async ({ page, request, baseURL, browserName }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await scenario({ page, request, apiBaseUrl: baseURL!, navigate: route => page.goto(route), runtime: 'web' })
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
