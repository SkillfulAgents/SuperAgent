import { test, expect, type BrowserContext } from '@playwright/test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

async function join(context: BrowserContext, name: string) {
  const email = `drive-${name.toLowerCase()}-${Date.now()}@example.test`
  const response = await context.request.post('/api/auth/sign-up/email', { data: { name, email, password: 'DriveAccessTest123!' } })
  expect(response.ok()).toBe(true)
  expect((await context.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBe(true)
  return (await response.json()).user as { id: string; email: string }
}

test('drive sharing updates Settings, the picker and an attached drive in another signed-in window', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000)
  const teammate = await browser.newContext({ baseURL })
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'gamut-acl-e2e-')))
  const name = `Forecasts ${Date.now()}`
  try {
    const privateFolder = path.join(folder, 'forecasts')
    const notesFolder = path.join(folder, 'notes')
    mkdirSync(privateFolder)
    mkdirSync(notesFolder)
    writeFileSync(path.join(privateFolder, 'forecast.txt'), 'Quarterly forecast')
    await join(page.context(), 'Alice')
    const bob = await join(teammate, 'Bob')
    const created = await page.request.post('/api/agents', { data: { name: 'Planning' } })
    expect(created.ok()).toBe(true)
    const { slug } = await created.json()
    const endpoint = `/api/agents/${slug}`
    expect((await page.request.post(`${endpoint}/access`, { data: { userId: bob.id, role: 'user' } })).status()).toBe(201)
    const attached = await page.request.post(`${endpoint}/mounts`, { data: { name, type: 'local', config: { path: privateFolder } } })
    expect(attached.status()).toBe(201)
    const { volumeId } = await attached.json()
    const own = await teammate.request.post('/api/volume-definitions', { data: { name: 'My notes', type: 'local', config: { path: notesFolder } } })
    expect(own.status()).toBe(201)
    const file = `${endpoint}/mount-files/${encodeURIComponent(name)}/forecast.txt`
    const contents = `${endpoint}/folders?root=${encodeURIComponent(`/mounts/${name}`)}`
    expect((await teammate.request.get(file)).status()).toBe(404)
    expect((await teammate.request.get(contents)).status()).toBe(404)

    const other = await teammate.newPage()
    await other.goto('/settings/volumes')
    await expect(other.getByRole('button', { name: 'Open My notes drive settings' })).toBeVisible({ timeout: 30_000 })
    await expect(other.getByText(name, { exact: true })).toHaveCount(0)
    await other.goto(`/agents/${slug}`)
    const drivesHeader = other.getByTestId('home-sections-panel').getByRole('button', { name: 'Drives', exact: true })
    await drivesHeader.click()
    await expect(other.getByText('Restricted drive', { exact: true })).toBeVisible()
    await other.getByTestId('add-mount-menu').click()
    await expect(other.getByRole('menuitem', { name: /My notes/ })).toBeVisible()
    await expect(other.getByRole('menuitem', { name: new RegExp(name) })).toHaveCount(0)
    await other.keyboard.press('Escape')

    await page.goto(`/settings/volumes?volume=${volumeId}`)
    const stack = page.getByRole('button', { name: `People with access to ${name}` })
    await expect(stack).toHaveAttribute('title', 'Alice')
    await stack.click()
    await expect(page.getByRole('button', { name: 'Remove Alice as owner' })).toBeDisabled()
    await page.getByRole('textbox', { name: 'Invite by name or email' }).fill(bob.email)
    await page.getByRole('checkbox', { name: new RegExp(bob.email) }).click()
    await page.getByRole('button', { name: 'Invite', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove Bob as owner' })).toBeVisible()
    await expect(stack).toHaveAttribute('title', /Bob/)
    await other.getByRole('button', { name: `Open ${name} drive settings` }).click()
    await expect(other.getByTestId('volume-title')).toHaveText(name)
    expect(await (await teammate.request.get(file)).text()).toBe('Quarterly forecast')
    await page.getByRole('button', { name: 'Remove Bob as owner' }).click()
    await expect(other.getByText('This drive is no longer available.')).toBeVisible()
    expect((await teammate.request.get(file)).status()).toBe(404)
    expect((await teammate.request.get(contents)).status()).toBe(404)
    await other.goto(`/agents/${slug}`)
    await expect(drivesHeader).toBeVisible()
    if ((await drivesHeader.getAttribute('aria-expanded')) !== 'true') await drivesHeader.click()
    await expect(other.getByText('Restricted drive')).toBeVisible()
  } finally {
    await teammate.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
