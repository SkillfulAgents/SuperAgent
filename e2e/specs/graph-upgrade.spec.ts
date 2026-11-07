import { expect, test } from '@playwright/test'
import { checkGraphTouch, graphUpgradeScenarios } from '../helpers/graph-upgrade'

// Projects run one worker; independent cases should still run after a failure.
test.describe.configure({ mode: 'default' })

for (const [name, scenario] of graphUpgradeScenarios) {
  test(name, async ({ page, request, baseURL }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await scenario({
        page, request, apiBaseUrl: baseURL!, navigate: route => page.goto(route), runtime: 'web',
        captureFailure: async () => {
          await testInfo.attach('graph-before-cleanup', { body: await page.screenshot(), contentType: 'image/png' })
        },
      })
      expect(errors).toEqual([])
    } finally {
      if (errors.length) await testInfo.attach('graph-page-errors', { body: JSON.stringify(errors), contentType: 'application/json' })
    }
  })
}

test('@touch graph pan, pinch and node drag keep selection and saved coordinates coherent', async ({ page, request, baseURL, browserName }, testInfo) => {
  testInfo.annotations.push({
    type: 'touch-input',
    description: browserName === 'webkit'
      ? 'Native WebKit taps; synthetic TouchEvent movement/pinch through the actual handlers. No physical iOS swipe claim.'
      : 'Native Chromium touch start/move/end and two-finger pinch through CDP; native taps.',
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    await checkGraphTouch({
      page, request, apiBaseUrl: baseURL!, navigate: route => page.goto(route), runtime: 'web',
      captureFailure: async () => {
        await testInfo.attach('graph-before-cleanup', { body: await page.screenshot(), contentType: 'image/png' })
      },
    }, browserName)
    expect(errors).toEqual([])
  } finally {
    if (errors.length) await testInfo.attach('graph-page-errors', { body: JSON.stringify(errors), contentType: 'application/json' })
  }
})
