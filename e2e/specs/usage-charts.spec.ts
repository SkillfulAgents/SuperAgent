import { expect, test } from '@playwright/test'
import { usageChartScenarios } from '../helpers/usage-charts'

for (const [name, scenario] of usageChartScenarios) {
  test(name, async ({ page, request, baseURL }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await scenario({ page, request, apiBaseUrl: baseURL!, navigate: path => page.goto(path) })
    expect(errors, 'Chart interactions do not raise renderer errors').toEqual([])
  })
}
