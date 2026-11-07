import { randomUUID } from 'node:crypto'
import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { AGENT_MEMORY_DIR } from '../../src/shared/lib/agent-actor/memory-schema'
import { LocalAgentActor, type LocalActorDeps } from '../../src/shared/lib/agent-actor/local-agent-actor'
import { getAgentWorkspaceDir } from '../../src/shared/lib/utils/file-storage'
import { isWebKitTeardownFetchError } from './page-errors'

export interface MemoryHistoryContext {
  page: Page
  request: APIRequestContext
  apiBaseUrl: string
  navigate: (route: string) => Promise<unknown>
}

const original = '# Navigation memory\n\nKeep this saved memory intact.\n'

async function prepareHistory({ page, request, apiBaseUrl, navigate }: MemoryHistoryContext) {
  const response = await request.post(`${apiBaseUrl}/api/agents`, {
    data: { name: `Memory history ${randomUUID()}` },
  })
  expect(response.ok()).toBe(true)
  const agent = await response.json() as { slug: string }
  expect(agent.slug).toBeTruthy()
  // The app reads a real workspace file. getAgentWorkspaceDir resolves the
  // launcher's isolated SUPERAGENT_DATA_DIR at call time, including Electron.
  const actor = new LocalAgentActor(agent.slug, { getAgentWorkspaceDir } as LocalActorDeps)
  await actor.files.putDoc(`${AGENT_MEMORY_DIR}/MEMORY.md`, original)

  await navigate(`/agents/${agent.slug}`)
  await expect(page.getByTestId('home-memories-open-page')).toBeVisible()
  // Build actual browser history through UI actions. At the memory entry,
  // both directions have two entries and end at distinct leaf routes:
  // home → logs → home → MEMORIES → home → connections.
  // Home's asynchronously loaded cards can shift these buttons between
  // WebKit's scroll-to-click and pointer delivery. Use native keyboard
  // activation so this history setup targets the intended button.
  await page.getByTestId('home-api-logs-open-page').press('Enter')
  await expect(page).toHaveURL(/\/api-logs$/)
  await page.getByTestId('api-logs-back-button').click()
  await expect(page.getByTestId('home-memories-open-page')).toBeVisible()
  await page.getByTestId('home-memories-open-page').press('Enter')
  await expect(page).toHaveURL(/\/memories$/)
  await page.getByTestId('agent-breadcrumb').click()
  await expect(page.getByTestId('home-connections-open-page')).toBeVisible()
  await page.getByTestId('home-connections-open-page').press('Enter')
  await expect(page).toHaveURL(/\/connections$/)
  await page.evaluate(() => window.history.go(-2))
  await expect(page).toHaveURL(/\/memories$/)
  await page.getByRole('button', { name: /Memory index/ }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByLabel('Memory contents')).toHaveValue(original)
  return agent
}

async function cancelHistoryMove(page: Page, delta: number, draft: string) {
  await page.evaluate((amount) => window.history.go(amount), delta)
  const dialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  // Checking both the rendered draft and URL catches a rollback that moved
  // the browser to the wrong entry while leaving the old component mounted.
  await expect(page).toHaveURL(/\/memories$/)
  await expect(page.getByLabel('Memory contents')).toHaveValue(draft)
}

async function discardHistoryMove(page: Page, delta: number, target: RegExp) {
  await page.evaluate((amount) => window.history.go(amount), delta)
  const dialog = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page).toHaveURL(target)
  await expect(page.getByLabel('Memory contents')).not.toBeVisible()
}

export async function checkMemoriesHistory(context: MemoryHistoryContext) {
  const { page, request, apiBaseUrl } = context
  const errors: string[] = []
  const collectError = (error: Error) => {
    if (!isWebKitTeardownFetchError(page, error)) errors.push(error.message)
  }
  page.on('pageerror', collectError)
  try {
    const agent = await prepareHistory(context)
    const draft = original + '\nUnsaved history-navigation draft.\n'
    await page.getByLabel('Memory contents').fill(draft)

    // Back/forward buttons and multi-entry history-menu jumps must all put
    // the browser back at the exact starting entry when the user cancels.
    for (const delta of [-1, 1, -2, 2]) await cancelHistoryMove(page, delta, draft)

    await discardHistoryMove(page, 2, /\/connections$/)
    await expect(page.getByTestId('connections-back-button')).toBeVisible()
    await page.evaluate(() => window.history.go(-2))
    await expect(page).toHaveURL(/\/memories$/)
    await page.getByRole('button', { name: /Memory index/ }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByLabel('Memory contents')).toHaveValue(original)
    await page.getByLabel('Memory contents').fill(original + '\nAnother unsaved draft.\n')
    await discardHistoryMove(page, -2, /\/api-logs$/)
    await expect(page.getByTestId('api-logs-back-button')).toBeVisible()

    const saved = await request.get(`${apiBaseUrl}/api/agents/${agent.slug}/memories/content?path=MEMORY.md`)
    expect(saved.ok()).toBe(true)
    expect((await saved.json()).content).toBe(original)
    expect(errors).toEqual([])
  } finally {
    page.off('pageerror', collectError)
  }
}

export async function checkMemoryBeforeUnload(context: MemoryHistoryContext) {
  const { page, request, apiBaseUrl } = context
  const agent = await prepareHistory(context)
  const draft = original + '\nDraft protected from reload.\n'
  await page.getByLabel('Memory contents').fill(draft)
  // A cancelled same-document traversal must not leave history's temporary
  // beforeunload bypass set for the next real document navigation.
  await cancelHistoryMove(page, 1, draft)
  const dialogPromise = page.waitForEvent('dialog')
  const reloadAttempt = page.evaluate(() => window.location.reload())
  const dialog = await dialogPromise
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  await reloadAttempt
  await expect(page).toHaveURL(/\/memories$/)
  await expect(page.getByLabel('Memory contents')).toHaveValue(draft)

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Memory saved.', { exact: true })).toBeVisible()
  const unexpectedDialogs: string[] = []
  const onDialog = async (unexpected: import('@playwright/test').Dialog) => {
    unexpectedDialogs.push(unexpected.type())
    await unexpected.dismiss()
  }
  page.on('dialog', onDialog)
  try {
    await page.reload()
    await page.getByRole('button', { name: /Memory index/ }).click()
    await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await expect(page.getByLabel('Memory contents')).toHaveValue(draft)
    expect(unexpectedDialogs).toEqual([])
    const saved = await request.get(`${apiBaseUrl}/api/agents/${agent.slug}/memories/content?path=MEMORY.md`)
    expect((await saved.json()).content).toBe(draft)
  } finally {
    page.off('dialog', onDialog)
  }
}
