import { test, expect } from '@playwright/test'

test('the Share popover gives an agent a role, takes it away, and blocks it', async ({ page }) => {
  test.setTimeout(90_000)
  const email = `share-agents-${Date.now()}@example.test`
  expect((await page.request.post('/api/auth/sign-up/email', { data: { name: 'Olivia Owner', email, password: 'CollaborationTesting123!' } })).ok()).toBeTruthy()
  expect((await page.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
  const create = async (name: string) => (await (await page.request.post('/api/agents', { data: { name } })).json()).slug as string
  const work = await create('Share Work')
  const helper = await create('Share Helper')
  // What the helper may do with Work, and what Work may do with the helper.
  const links = async (caller: string, target: string) => {
    const { policies } = await (await page.request.get(`/api/agents/${caller}/x-agent-policies`)).json() as { policies: { operation: string; targetAgentSlug: string | null; decision: string }[] }
    return Object.fromEntries(policies.filter((p) => p.targetAgentSlug === target).map((p) => [p.operation, p.decision]))
  }

  await page.goto(`/agents/${work}`)
  await page.getByTestId('agent-share-button').click()
  const sharing = page.getByTestId('agent-share-popover')
  await sharing.getByPlaceholder('Invite people or agents...').fill('Share Helper')
  await sharing.getByTestId(`invite-agent-result-${helper}`).click()
  await sharing.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(sharing.getByTestId(`access-agent-role-${helper}`)).toHaveText('User')
  expect(await links(helper, work)).toEqual({ invoke: 'allow', read: 'allow' })

  await sharing.getByTestId(`access-agent-role-${helper}`).click()
  await page.getByRole('option', { name: /^Viewer/ }).click()
  await expect(sharing.getByTestId(`access-agent-role-${helper}`)).toHaveText('Viewer')
  expect(await links(helper, work)).toEqual({ invoke: 'review', read: 'allow' })

  await sharing.getByTestId(`access-agent-role-${helper}`).click()
  await page.getByTestId(`access-agent-block-${helper}`).click()
  await expect(sharing.getByTestId('access-blocked-toggle')).toHaveText(/1 blocked agent/)
  expect(await links(helper, work)).toEqual({ invoke: 'block', read: 'block' })
  expect(await links(work, helper)).toEqual({ invoke: 'block', read: 'block' })

  await sharing.getByTestId('access-blocked-toggle').click()
  await sharing.getByTestId(`access-blocked-role-${helper}`).click()
  await page.getByTestId(`access-unblock-${helper}`).click()
  await expect(sharing.getByTestId('access-blocked-toggle')).toHaveCount(0)
  expect(await links(helper, work)).toEqual({ invoke: 'review', read: 'review' })
  expect(await links(work, helper)).toEqual({ invoke: 'review', read: 'review' })
})
