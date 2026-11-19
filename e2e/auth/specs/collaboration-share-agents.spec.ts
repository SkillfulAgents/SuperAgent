import { test, expect } from '@playwright/test'

test('direct agents count in the stack, while inherited access links to global settings', async ({ page, browser, baseURL }) => {
  const signup = await page.request.post('/api/auth/sign-up/email', { data: {
    name: 'Olivia Owner', email: `share-agents-${Date.now()}@example.test`, password: 'CollaborationTesting123!',
  } })
  expect(signup.ok()).toBeTruthy()
  expect((await page.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
  const create = async (name: string) => {
    const response = await page.request.post('/api/agents', { data: { name } })
    expect(response.ok()).toBeTruthy()
    return (await response.json()).slug as string
  }
  const target = await create('Research')
  const direct = await create('Editor')
  const global = await create('Librarian')
  for (const [caller, targetSlug, operation] of [[direct, target, 'invoke'], [direct, null, 'read'], [global, null, 'read']]) {
    expect((await page.request.patch(`/api/agents/${caller}/x-agent-policies`, { data: { targetSlug, operation, decision: 'allow' } })).ok()).toBeTruthy()
  }

  await page.goto(`/agents/${target}`)
  const stack = page.getByTestId(`agent-members-${target}`)
  await expect(stack).toHaveAccessibleName('2 members of Research')
  await stack.click()
  const roster = page.getByTestId(`agent-members-list-${target}`)
  await expect(roster.getByRole('combobox', { name: 'Role for Editor' })).toHaveText('User')
  await expect(roster.getByText('+ 1 agent with global access')).toBeVisible()
  await expect(roster.getByRole('link', { name: 'Librarian' })).toBeHidden()
  await roster.getByRole('combobox', { name: 'Role for Editor' }).click()
  await page.getByRole('option', { name: 'Viewer', exact: true }).click()
  await expect(roster.getByRole('combobox', { name: 'Role for Editor' })).toHaveText('Viewer')
  await page.keyboard.press('Escape')

  await page.getByTestId('agent-share-button').click()
  const share = page.getByTestId('agent-share-popover')
  const role = share.getByRole('combobox', { name: 'Role for Editor' })
  await expect(role).toHaveText('Viewer')
  await role.click()
  await page.getByRole('option', { name: 'Remove', exact: true }).click()
  await expect(role).toHaveCount(0)
  await expect(stack).toHaveCount(0)
  await share.getByText('+ 2 agents with global access').click()
  await expect(share.getByRole('link', { name: 'Editor' })).toBeVisible()
  await share.getByRole('link', { name: 'Librarian' }).click()
  await expect(page).toHaveURL(new RegExp(`/agents/${global}/x-agent-permissions$`))
  await expect(page.getByRole('heading', { name: 'Global permissions' })).toBeVisible()

  const guest = await browser.newContext({ baseURL })
  try {
    const signup = await guest.request.post('/api/auth/sign-up/email', { data: {
      name: 'Victor Viewer', email: `viewer-${Date.now()}@example.test`, password: 'CollaborationTesting123!',
    } })
    expect(signup.ok()).toBeTruthy()
    const { user } = await signup.json()
    for (const slug of [target, global]) {
      expect((await page.request.post(`/api/agents/${slug}/access`, { data: { userId: user.id, role: 'viewer' } })).ok()).toBeTruthy()
    }
    expect((await guest.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
    const viewer = await guest.newPage()
    await viewer.goto(`/agents/${target}`)
    await viewer.getByTestId(`agent-members-${target}`).click()
    const visible = viewer.getByTestId(`agent-members-list-${target}`)
    await visible.getByText('+ 1 agent with global access').click()
    await expect(visible.getByRole('link', { name: 'Editor' })).toHaveCount(0)
    await visible.getByRole('link', { name: 'Librarian' }).click()
    await expect(viewer.getByTestId('x-agent-policy-global-read').getByRole('button')).toBeDisabled()
  } finally {
    await guest.close()
  }
})
