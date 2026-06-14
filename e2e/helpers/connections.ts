import type { Locator, Page } from '@playwright/test'

export function getConnectionsHeaderAddButton(page: Page): Locator {
  return page.locator('[data-testid="page-title-actions"]').getByTestId('connections-add-button')
}
