import { expect, type Page } from '@playwright/test'

/**
 * Push a SlideToConfirm handle the length of its track. `testId` is the
 * component's data-testid: the handle carries it and the track carries
 * `<testId>-track`. The first move after the press only takes the grab
 * offset, so the drag is stepped, and it overshoots the track's end because
 * the handle clamps at its wall and the commit is decided at release.
 */
export async function slideToConfirm(page: Page, testId: string) {
  const handle = page.getByTestId(testId)
  const track = page.getByTestId(`${testId}-track`)
  await expect(handle).toBeVisible({ timeout: 10000 })
  const grip = await handle.boundingBox()
  const rail = await track.boundingBox()
  expect(grip).not.toBeNull()
  expect(rail).not.toBeNull()
  const y = grip!.y + grip!.height / 2
  await page.mouse.move(grip!.x + grip!.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(rail!.x + rail!.width + 40, y, { steps: 12 })
  await page.mouse.up()
}
