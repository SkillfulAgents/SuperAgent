import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { LocalAgentActor, type LocalActorDeps } from '../../src/shared/lib/agent-actor/local-agent-actor'
import { getAgentWorkspaceDir } from '../../src/shared/lib/utils/file-storage'
import { AGENT_MEMORY_DIR } from '../../src/shared/lib/services/agent-memory-service'

test('memories can be discovered, edited, and reloaded; stale saves keep the draft', async ({ page, request }) => {
  test.slow()
  const app = new AppPage(page)
  await app.goto()
  await app.waitForAgentsLoaded()
  const name = `Memory Agent ${Date.now()}`
  await new AgentPage(page).createAgent(name)
  // eslint-disable-next-line local-rules/no-unhandled-throwing-builtins -- Playwright supplies a valid absolute URL.
  const agentUrl = new URL(page.url()).pathname
  const agent = await (await request.get(`/api/agents/${agentUrl.split('/')[2]}`)).json()
  // This fixture only exercises actor file operations; runtime dependencies stay unused.
  const files = new LocalAgentActor(agent.slug, { getAgentWorkspaceDir } as LocalActorDeps).files

  await page.getByTestId('home-memories-open-page').click()
  await expect(page.getByText('No memories yet')).toBeVisible()
  await files.putDoc(`${AGENT_MEMORY_DIR}/MEMORY.md`, '- [Writing style](style.md)\n')
  await files.putDoc(`${AGENT_MEMORY_DIR}/style.md`, '---\nname: Writing style\ndescription: Communication preferences\nmetadata:\n  type: feedback\n---\n\nUse short paragraphs.\n')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByRole('button', { name: /Memory index/ })).toBeVisible()
  await page.getByRole('button', { name: /Writing style/ }).click()
  await expect(page.getByText('Use short paragraphs.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const editor = page.getByLabel('Memory contents')
  const original = await editor.inputValue()
  const invalid = original.replace('type: feedback', 'type: unknown')
  await editor.fill(invalid)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Frontmatter "metadata.type" must be user, feedback, project, or reference.', { exact: true })).toBeVisible()
  await expect(editor).toHaveValue(invalid)
  await expect(page.getByRole('button', { name: 'Reload latest version', exact: true })).not.toBeVisible()
  expect(new TextDecoder().decode(await files.getDoc(`${AGENT_MEMORY_DIR}/style.md`) ?? undefined)).toBe(original)
  const edited = original.replace('short paragraphs', 'clear examples')
  await editor.fill(edited)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Memory saved.', { exact: true })).toBeVisible()
  expect(new TextDecoder().decode(await files.getDoc(`${AGENT_MEMORY_DIR}/style.md`) ?? undefined)).toBe(edited)

  await page.reload()
  await expect(page).toHaveURL(/\/memories$/)
  await page.getByRole('button', { name: /Writing style/ }).click()
  await expect(page.getByText('Use clear examples.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  const draft = edited + '\nMy unsaved draft'
  await editor.fill(draft)
  await files.putDoc(`${AGENT_MEMORY_DIR}/style.md`, edited + '\nAgent added a fact.\n')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/This memory changed since you opened it/)).toBeVisible()
  await expect(editor).toHaveValue(draft)

  await page.getByTestId('agent-breadcrumb').click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(editor).toHaveValue(draft)
  await page.getByRole('button', { name: 'Reload latest version', exact: true }).click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page.getByText('Agent added a fact.', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await editor.fill('Another unsaved draft')
  await page.getByTestId('agent-breadcrumb').click()
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(page).toHaveURL(new RegExp('/agents/' + agent.slug + '$'))
  await page.getByTestId('home-memories-open-page').click()
  await expect(page.getByRole('button', { name: /Writing style/ })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('memory-preview.png'), fullPage: true })
})
