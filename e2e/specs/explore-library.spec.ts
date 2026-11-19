import { expect, test } from '@playwright/test'

const libraries = [
  { id: 'public-library', name: 'Public Library' },
  { id: 'private-library', name: 'Private Library' },
]

function template(library: typeof libraries[number], name: string, category: string, service: string) {
  return {
    skillsetId: library.id,
    skillsetName: library.name,
    name,
    description: `A template for ${category.toLowerCase()}`,
    version: '1.0.0',
    path: `agents/${name.toLowerCase().replaceAll(' ', '-')}/`,
    category,
    worksWith: [{ type: 'connection', slug: service }],
  }
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/skillsets', (route) => route.fulfill({ json: libraries }))
  await page.route('**/api/agents/discoverable-agents*', (route) =>
    route.fulfill({
      json: {
        agents: [
          template(libraries[0], 'Public Writer', 'Marketing', 'gmail'),
          template(libraries[0], 'Public Reviewer', 'Operations', 'slack'),
          template(libraries[1], 'Private Writer', 'Marketing', 'slack'),
          template(libraries[1], 'Private Analyst', 'Analytics', 'notion'),
        ],
      },
    }),
  )
})

test('the library switcher works on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/explore')

  const switcher = page.getByTestId('explore-library-select')
  await expect(switcher).toHaveText('Public Library')
  await switcher.click()
  await page.getByRole('menuitem', { name: /Private Library/ }).click()

  await expect(page).toHaveURL(/\?library=private-library$/)
  await expect(switcher).toHaveText('Private Library')
  await expect(page.getByRole('button', { name: 'Private Analyst — details' })).toBeVisible()
})

test('filter options and counts follow the selected library', async ({ page }) => {
  await page.goto('/explore')

  const filter = page.getByRole('button', { name: 'Filter', exact: true })
  await filter.click()
  await expect(page.getByRole('button', { name: 'Marketing 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Slack 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Analytics|Notion/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Gmail 1', exact: true }).click()
  await expect(page.getByTestId('explore-template-card')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await page.getByTestId('explore-library-select').click()
  await page.getByRole('menuitem', { name: /Private Library/ }).click()
  await expect(page.getByTestId('explore-template-card')).toHaveCount(2)

  await filter.click()
  await expect(page.getByRole('button', { name: 'Analytics 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Notion 1', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Operations|Gmail/ })).toHaveCount(0)
})
