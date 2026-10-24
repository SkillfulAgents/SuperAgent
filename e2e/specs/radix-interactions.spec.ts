import { test, expect } from '@playwright/test'
import { radixInteractionChecks } from '../helpers/radix-interactions'

for (const [name, check] of radixInteractionChecks) {
  test(name, async ({ page, request, baseURL }) => {
    test.setTimeout(90_000)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    expect(baseURL).toBeTruthy()
    await check({ page, request, apiBaseUrl: baseURL!, navigate: path => page.goto(path) })
    expect(errors).toEqual([])
  })
}
