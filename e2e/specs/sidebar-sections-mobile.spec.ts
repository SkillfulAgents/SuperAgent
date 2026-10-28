import { test, expect } from '@playwright/test'

test.use({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, trace: 'retain-on-failure' })

test('section menu stays usable by touch and keeps rename cancellation local', async ({ page }) => {
  test.setTimeout(60_000)
  // This interaction regression runs alongside the folder persistence tests.
  // Give this page its own section without mutating their shared settings row.
  await page.route('**/api/user-settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    await route.fulfill({
      response,
      json: {
        ...await response.json(),
        agentFolders: [{ id: 'touch-section', name: 'Touch Section' }],
        agentListOrder: ['agent-folder::touch-section', 'agent-folder::root'],
        collapsedAgentFolders: [],
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Toggle Sidebar' }).tap()
  const folder = page.getByTestId('agent-folder-touch-section')
  const trigger = page.getByTestId('section-menu-touch-section')
  const drawer = page.getByRole('dialog', { name: 'Sidebar' })
  await expect(trigger).toHaveCSS('opacity', '1')
  await trigger.tap()
  await expect(page.getByRole('menu')).toHaveAttribute('data-state', 'open')
  await expect(drawer).not.toHaveAttribute('inert')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(drawer).not.toHaveAttribute('inert')

  await trigger.tap()
  await page.getByTestId('rename-folder-item').tap()
  const input = page.getByTestId('folder-name-input')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(input).toBeFocused()
  await input.fill('Discard by touch')
  await page.getByTestId('folder-name-cancel').tap()
  await expect(folder).toHaveText('Touch Section')
  await expect(drawer).not.toHaveAttribute('inert')
})
