import { expect, test } from '@playwright/test'

const templates = Array.from({ length: 18 }, (_, index) => {
  const number = index + 1
  return {
    skillsetId: 'e2e-public-skillset',
    skillsetName: 'E2E Public Skillset',
    name: `E2E Template ${number}`,
    description: `Template ${number} used to exercise marketplace scrolling`,
    version: '1.0.0',
    path: `agents/e2e-template-${number}/`,
    category: `Category ${String(number).padStart(2, '0')}`,
  }
})

test('template back arrow restores the Discover page scroll position', async ({ page }) => {
  await page.route('**/api/agents/discoverable-agents*', async (route) => {
    await route.fulfill({ json: { agents: templates } })
  })

  await page.goto('/explore')
  await expect(page.getByTestId('explore-template-card')).toHaveCount(templates.length)

  const scrollContainer = page.locator('[data-scroll-restoration-id="explore-marketplace"]')
  const targetCard = page.getByRole('button', { name: 'E2E Template 14 — details' })
  await targetCard.scrollIntoViewIfNeeded()

  const savedScrollTop = await scrollContainer.evaluate((element) => element.scrollTop)
  expect(savedScrollTop).toBeGreaterThan(500)

  await targetCard.click()
  await expect(page).toHaveURL(/\/explore\/e2e-public-skillset\/e2e-template-14$/)
  await expect(page.getByTestId('template-detail-view')).toBeVisible()

  await page
    .getByTestId('main-content')
    .getByRole('button', { name: 'Discover New Agents' })
    .click()

  await expect(page).toHaveURL(/\/explore$/)
  await expect(page.getByTestId('explore-view')).toBeVisible()
  await expect
    .poll(async () => {
      const restoredScrollTop = await page
        .locator('[data-scroll-restoration-id="explore-marketplace"]')
        .evaluate((element) => element.scrollTop)
      return Math.abs(restoredScrollTop - savedScrollTop)
    })
    .toBeLessThan(2)
})
