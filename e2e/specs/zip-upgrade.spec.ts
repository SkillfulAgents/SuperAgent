import { test } from '@playwright/test'
import { checkAgentImportRecovery, checkChunkedAgentRoundTrip, checkSkillImportRoundTrip } from '../helpers/zip-import'

for (const [name, scenario] of [
  ['agent imports reject malformed/traversal ZIPs and recover in the same dialog', checkAgentImportRecovery],
  ['skill imports recover and preserve nested files through export/import', checkSkillImportRoundTrip],
  ['chunked agent imports recover and full exports preserve workspace bytes', checkChunkedAgentRoundTrip],
] as const) {
  test(name, async ({ page, request, baseURL }) => {
    await scenario({ page, request, apiBaseUrl: baseURL!, navigate: route => page.goto(route) })
  })
}
