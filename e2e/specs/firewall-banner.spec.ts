/**
 * Firewall-blocked sidebar banner + one-click fix flow.
 *
 * Real detection and remediation only exist on Windows (PowerShell + UAC), so
 * this spec runs against the dev-only fake block mode and is gated on its env
 * var — the server process must be started with it too:
 *
 *   SUPERAGENT_FAKE_FIREWALL_BLOCK=1 E2E_MOCK=true npx playwright test firewall-banner
 *
 * It still exercises the full production wiring end to end: status route →
 * React Query hook → sidebar banner → fix mutation → banner clears.
 */
import { test, expect } from '@playwright/test'

test.skip(process.env.SUPERAGENT_FAKE_FIREWALL_BLOCK !== '1', 'SUPERAGENT_FAKE_FIREWALL_BLOCK not enabled')

test.describe('Firewall blocked banner', () => {
  test('shows the block, fixes it in one click, and clears', async ({ page }) => {
    await page.goto('/')

    const banner = page.getByText('Windows Firewall is blocking agent connections.')
    await expect(banner).toBeVisible()

    await page.getByRole('button', { name: /Fix now/ }).click()

    // The fake fix resolves immediately; the mutation writes the fresh status
    // into the query cache, so the banner must disappear without a reload.
    await expect(banner).not.toBeVisible()
  })
})
