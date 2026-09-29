import { test, expect } from '@playwright/test'
import { createAndOpenIdleSession } from '../helpers/agents'

test.describe('Session raw log', () => {
  test('shows the busy spinner on the row while the download is in flight, without blocking Fork', async ({ page, request }, testInfo) => {
    const { session } = await createAndOpenIdleSession(page, request, testInfo, 'Raw Log Agent')

    let releaseLog!: () => void
    const held = new Promise<void>((resolve) => { releaseLog = resolve })
    await page.route(`**/sessions/${session.id}/raw-log`, async (route) => {
      await held
      await route.continue()
    })

    const row = page.locator(`[data-testid="session-item-${session.id}"]`)
    const spinner = row.getByRole('img', { name: 'busy' })
    await expect(row).toBeVisible({ timeout: 15000 })
    await expect(spinner).toHaveCount(0)
    await row.click({ button: 'right' })
    await page.locator('[data-testid="download-session-raw-log-item"]').click()
    await expect(spinner).toBeVisible()

    await row.click({ button: 'right' })
    await expect(page.locator('[data-testid="fork-session-trigger"]:visible')).not.toHaveAttribute('data-disabled', '')
    await page.keyboard.press('Escape')

    const download = page.waitForEvent('download')
    releaseLog()
    await download
    await expect(spinner).toHaveCount(0)
  })
})
