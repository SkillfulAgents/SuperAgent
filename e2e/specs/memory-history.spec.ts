import { test } from '@playwright/test'
import { checkMemoriesHistory, checkMemoryBeforeUnload } from '../helpers/memory-history'

test('dirty memory drafts survive cancelled back, forward and multi-entry history traversals', async ({ page, request, baseURL }) => {
  await checkMemoriesHistory({ page, request, apiBaseUrl: baseURL!, navigate: (route) => page.goto(route) })
})

test('memory reload protection survives a cancelled history move and clears after saving', async ({ page, request, baseURL, browserName }) => {
  // Playwright WebKit does not surface native beforeunload confirmation dialogs.
  test.skip(browserName !== 'chromium', 'Native beforeunload dialog coverage requires Chromium')
  await checkMemoryBeforeUnload({ page, request, apiBaseUrl: baseURL!, navigate: (route) => page.goto(route) })
})
