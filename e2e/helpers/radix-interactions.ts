import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import { mockDropboxVolumes } from './dropbox-volumes'
import { startMockMcpServer } from './mock-mcp-server'

/** The same app flows run against web routing and Electron's file:// hash route. */
export interface RadixInteractionContext {
  page: Page
  request: APIRequestContext
  apiBaseUrl: string
  navigate: (path: string) => Promise<unknown>
}

interface ScheduledTask { id: string; name: string; timezone: string; scheduleExpression: string }
interface RemoteMcp { id: string; name: string; url: string; authType: string }

async function createAgent({ request, apiBaseUrl }: RadixInteractionContext, label: string) {
  const response = await request.post(`${apiBaseUrl}/api/agents`, {
    data: { name: `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
  })
  expect(response.status()).toBe(201)
  return await response.json() as { slug: string }
}

async function expectFocusInside(container: Locator) {
  await expect.poll(() => container.evaluate(element => element.contains(document.activeElement))).toBe(true)
}

async function expectPointersReleased(page: Page) {
  await expect.poll(() => page.locator('body').evaluate(element => getComputedStyle(element).pointerEvents)).not.toBe('none')
}

export async function checkNestedSchedulePicker(context: RadixInteractionContext) {
  const { page, request, apiBaseUrl, navigate } = context
  const agent = await createAgent(context, 'Radix schedule')
  let task: ScheduledTask | undefined
  try {
    await navigate(`/agents/${agent.slug}`)
    await new AppPage(page).waitForAgentsLoaded()
    const session = new SessionPage(page)
    await session.sendMessage('schedule task for daily issues')
    await session.waitForResponse(15_000)
    await session.waitForInputEnabled()
    await expect.poll(async () => {
      const response = await request.get(`${apiBaseUrl}/api/agents/${agent.slug}/scheduled-tasks`)
      expect(response.ok()).toBe(true)
      task = (await response.json() as ScheduledTask[]).find(item => item.name === 'Daily Issue Summary')
      return Boolean(task)
    }).toBe(true)

    // Only the unrelated English description service is stubbed. Saving the
    // timezone still runs the actual API, parser and persistence path.
    await page.route(`**/api/scheduled-tasks/${task!.id}/describe-schedule`, route =>
      route.fulfill({ json: { description: 'Every weekday at 9 AM' } }))
    await navigate(`/agents/${agent.slug}/tasks/${task!.id}`)
    const openEdit = async () => {
      await page.getByRole('button', { name: 'Cron settings' }).click()
      await page.getByRole('button', { name: 'Edit Schedule', exact: true }).click()
      await expect(page.getByRole('dialog', { name: 'Edit Schedule', exact: true })).toBeVisible()
    }
    await openEdit()
    const dialog = page.getByRole('dialog', { name: 'Edit Schedule', exact: true })
    const trigger = dialog.getByRole('combobox', { name: 'Select timezone' })
    await trigger.click()
    const search = page.getByPlaceholder('Search timezone...')
    await expect(search).toBeFocused()
    await search.fill('Chatham')
    await expect(search).toHaveValue('Chatham')
    await search.press('Tab')
    await expect(page.getByRole('button', { name: /Pacific\/Chatham/ })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(search).toBeFocused()

    await search.fill('')
    const scroller = page.getByTestId('timezone-options')
    await expect.poll(() => scroller.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const bounds = await scroller.boundingBox()
    expect(bounds).not.toBeNull()
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
    await page.mouse.wheel(0, 350)
    await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBeGreaterThan(0)

    // Escape dismisses the top layer alone and returns focus to its trigger.
    await page.keyboard.press('Escape')
    await expect(search).not.toBeVisible()
    await expect(dialog).toBeVisible()
    await expect(trigger).toBeFocused()
    const dialogBounds = await dialog.boundingBox()
    expect(dialogBounds).not.toBeNull()
    await trigger.press('Enter')
    await expect(search).toBeFocused()
    // A pointer outside the portalled picker but inside its parent dismisses
    // just the picker, without losing the schedule editor or its focus scope.
    await page.mouse.click(dialogBounds!.x + 8, dialogBounds!.y + dialogBounds!.height / 2)
    await expect(search).not.toBeVisible()
    await expect(dialog).toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.press('Enter')
    await expect(search).toBeFocused()
    await search.fill('Chatham')
    await page.getByRole('button', { name: /Pacific\/Chatham/ }).click()
    await expect(search).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await expect(trigger).toContainText('Pacific/Chatham')
    await dialog.getByRole('button', { name: 'Save Schedule', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect.poll(async () => {
      const response = await request.get(`${apiBaseUrl}/api/scheduled-tasks/${task!.id}`)
      return (await response.json() as ScheduledTask).timezone
    }).toBe('Pacific/Chatham')
    await expectPointersReleased(page)

    // Closing another edit discards its draft and leaves the page interactive.
    await openEdit()
    const description = dialog.getByLabel('Schedule Description')
    await description.fill('An unsaved schedule description')
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab')
      await expectFocusInside(dialog)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).not.toBeVisible()
    await expectPointersReleased(page)
    await openEdit()
    await expect(description).toHaveValue('Every weekday at 9 AM')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expectPointersReleased(page)
  } finally {
    if (task) await request.delete(`${apiBaseUrl}/api/scheduled-tasks/${task.id}`)
    await request.delete(`${apiBaseUrl}/api/agents/${agent.slug}`)
  }
}

export async function checkNestedDriveDialogs(context: RadixInteractionContext) {
  const { page, navigate } = context
  // No OAuth/Dropbox traffic: deterministic accounts/folders drive the actual
  // app dialogs. All paths cancel, so this check does not mock a successful save.
  const state = await mockDropboxVolumes(page)
  await navigate('/settings/volumes')
  const addDrive = page.getByRole('button', { name: 'Add drive', exact: true })
  await addDrive.click()
  const outer = page.getByTestId('volume-settings-dialog')
  await outer.getByRole('button', { name: 'Dropbox', exact: true }).click()
  const account = outer.getByLabel('Dropbox account', { exact: true })
  await account.press('Enter')
  await expect(page.getByRole('option', { name: /Old Dropbox/ })).toBeDisabled()
  const activeAccount = page.getByRole('option', { name: 'Team Dropbox', exact: true })
  await expect(activeAccount).toBeFocused()
  await page.keyboard.press('End')
  await expect(activeAccount).toBeFocused()
  await page.keyboard.press('Space')
  await expect(account).toBeFocused()
  await outer.getByRole('button', { name: 'Next', exact: true }).click()
  const selectFolder = outer.getByRole('button', { name: 'Select folder', exact: true })
  await selectFolder.click()
  const inner = page.getByTestId('dropbox-folder-picker')
  await expect(inner).toBeVisible()
  await expectFocusInside(inner)
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab')
    await expectFocusInside(inner)
  }
  await page.keyboard.press('Escape')
  await expect(inner).not.toBeVisible()
  await expect(outer).toBeVisible()
  await expect(selectFolder).toBeFocused()
  await selectFolder.click()
  await inner.getByRole('button', { name: 'Team documents', exact: true }).click()
  await inner.getByRole('button', { name: 'Reports', exact: true }).click()
  await inner.getByRole('button', { name: 'Use this folder', exact: true }).click()
  await expect(inner).not.toBeVisible()
  await expect(outer.getByRole('button', { name: 'Change folder', exact: true })).toBeFocused()
  await expect(outer.getByLabel('Name', { exact: true })).toHaveValue('Reports')
  await expect(outer.getByTestId('selected-volume-folder')).toHaveText('/Team documents/Reports')
  await outer.getByLabel('Name', { exact: true }).fill('Cancelled drive draft')
  await outer.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(outer).not.toBeVisible()
  await expectPointersReleased(page)
  expect(state.created).toEqual([])
  await addDrive.click()
  await expect(outer.getByRole('button', { name: 'Dropbox', exact: true })).toBeVisible()
  // A real outside pointer closes the fresh top-level modal.
  await page.mouse.click(5, 5)
  await expect(outer).not.toBeVisible()
  await expectPointersReleased(page)
}

export async function checkConnectionControlEvents(context: RadixInteractionContext) {
  const { page, request, apiBaseUrl, navigate } = context
  const agent = await createAgent(context, 'Radix connections')
  const mcp = await startMockMcpServer(0)
  let serverId: string | undefined
  try {
    await navigate(`/agents/${agent.slug}/connections`)
    await page.getByTestId('connections-add-button').click()
    const directory = page.getByRole('dialog', { name: 'Add New Connection', exact: true })
    await expect(directory).toBeVisible()
    const all = directory.getByRole('tab', { name: 'All', exact: true })
    await all.focus()
    await page.keyboard.press('ArrowRight')
    await expect(directory.getByRole('tab', { name: 'APIs', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ArrowRight')
    await expect(directory.getByRole('tab', { name: 'MCPs', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('directory-connect-mcp-custom').click()
    const name = `Radix MCP ${Date.now()}`
    await page.getByTestId('mcp-form-name').fill(name)
    await page.getByTestId('mcp-form-url').fill(mcp.url)
    const authentication = directory.getByRole('combobox')
    await authentication.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('option', { name: 'No Authentication', exact: true })).toBeFocused()
    await page.keyboard.press('End')
    await expect(page.getByRole('option', { name: 'Bearer Token', exact: true })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(authentication).toContainText('Bearer Token')
    await expect(authentication).toBeFocused()
    await page.getByTestId('mcp-form-token').fill('radix-local-test-token')
    // Selecting with Space must not submit the draft or dismiss its parent.
    await authentication.press('Space')
    await expect(page.getByRole('option', { name: 'Bearer Token', exact: true })).toBeFocused()
    await page.keyboard.press('Home')
    await expect(page.getByRole('option', { name: 'No Authentication', exact: true })).toBeFocused()
    await page.keyboard.press('Space')
    await expect(authentication).toContainText('No Authentication')
    await expect(page.getByTestId('mcp-form-token')).not.toBeVisible()
    await expect(directory).toBeVisible()
    await expect(page.getByTestId('mcp-form-name')).toHaveValue(name)
    const before = await request.get(`${apiBaseUrl}/api/remote-mcps`)
    expect((await before.json() as { servers: RemoteMcp[] }).servers.some(server => server.url === mcp.url)).toBe(false)
    await page.getByTestId('mcp-form-submit').click()
    const policies = page.getByRole('dialog', { name: `${name} Tool Policies`, exact: true })
    await expect(policies).toBeVisible()
    await expect(directory).not.toBeVisible()
    const servers = await request.get(`${apiBaseUrl}/api/remote-mcps`)
    const created = (await servers.json() as { servers: RemoteMcp[] }).servers.find(server => server.url === mcp.url)!
    expect(created).toMatchObject({ name, authType: 'none' })
    serverId = created.id
    await policies.getByTestId('policy-toggle-review').first().click()
    await expect(policies.getByTestId('policy-toggle-review').first()).toHaveAttribute('data-active', 'true')
    await policies.getByTestId('tool-policy-save').click()
    await expect(policies).not.toBeVisible()
    const saved = await request.get(`${apiBaseUrl}/api/policies/tool/${serverId}`)
    expect((await saved.json() as { policies: Array<{ toolName: string; decision: string }> }).policies).toContainEqual(
      expect.objectContaining({ toolName: '*', decision: 'review' }),
    )
    await expectPointersReleased(page)

    const toggle = page.getByTestId(`connection-switch-mcp-${serverId}`)
    await expect(toggle).toHaveAttribute('data-state', 'unchecked')
    await toggle.focus()
    await page.keyboard.press('Space')
    await expect(toggle).toHaveAttribute('data-state', 'checked')
    const ids = async () => {
      const response = await request.get(`${apiBaseUrl}/api/agents/${agent.slug}/remote-mcps`)
      return (await response.json() as { mcps: Array<{ id: string }> }).mcps.map(item => item.id)
    }
    await expect.poll(ids).toContain(serverId)
    // Keyboard activation of the switch must not bubble into row navigation.
    await expect(page.getByTestId('connection-detail-back')).not.toBeVisible()
    await toggle.press('Space')
    await expect(toggle).toHaveAttribute('data-state', 'unchecked')
    await expect.poll(ids).not.toContain(serverId)
    await page.reload()
    await expect(toggle).toHaveAttribute('data-state', 'unchecked')
    await expect(page.getByTestId('connection-detail-back')).not.toBeVisible()
  } finally {
    if (serverId) await request.delete(`${apiBaseUrl}/api/remote-mcps/${serverId}`)
    await request.delete(`${apiBaseUrl}/api/agents/${agent.slug}`)
    await mcp.close()
  }
}

export const radixInteractionChecks = [
  ['nested schedule picker focus, scrolling and dismissal', checkNestedSchedulePicker],
  ['nested drive dialogs and disabled selection', checkNestedDriveDialogs],
  ['connection tabs, select events and persisted keyboard switch changes', checkConnectionControlEvents],
] as const

export async function runRadixInteractionChecks(context: RadixInteractionContext) {
  for (const [name, check] of radixInteractionChecks) {
    try {
      await check(context)
      console.log(`PASS Radix: ${name}`)
    } finally {
      await context.page.unrouteAll({ behavior: 'wait' })
    }
  }
}
