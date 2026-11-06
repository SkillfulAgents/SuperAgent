import { test, expect } from '@playwright/test'
import { formsUpgradeScenarios, formsTouchScenarios, initializeFormsAdmin, type FormsContext } from '../../helpers/forms-upgrade'

test.describe.configure({ mode: 'default' })

for (const [name, scenario] of [...formsUpgradeScenarios, ...formsTouchScenarios]) {
  test(name, async ({ page, request, baseURL, isMobile }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await initializeFormsAdmin(request, baseURL!)
    const context: FormsContext = {
      page,
      adminRequest: request,
      apiBaseUrl: baseURL!,
      navigate: (route) => page.goto(route),
      runtime: 'web',
      touch: isMobile,
      captureFailure: async () => {
        await testInfo.attach('forms-before-cleanup', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
      },
    }
    await scenario(context)
    expect(errors, 'Unexpected renderer errors').toEqual([])
  })
}
