/**
 * Team directories end to end, on the mock server's Demo Directory (E2E_MOCK):
 * an admin connects it, a directory person is shared with and mentioned before
 * they join, and then they sign up with their email, from the link their DM
 * carries, to find both waiting.
 */
import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../../pages/app.page'

const PASSWORD = 'DirectoryTesting123!'

async function openShare(page: Page) {
  await page.getByTestId('agent-share-button').click()
  await expect(page.getByTestId('agent-share-popover')).toBeVisible()
}

test('a directory person is shared with and mentioned before joining, then finds both waiting', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)

  // The first user of this server is its admin.
  const signUp = await page.request.post('/api/auth/sign-up/email', { data: { name: 'Ada Admin', email: 'ada@acme.test', password: PASSWORD } })
  expect(signUp.ok()).toBeTruthy()
  expect((await page.request.put('/api/user-settings', { data: { setupCompleted: true } })).ok()).toBeTruthy()
  const app = new AppPage(page)
  await app.goto()
  await app.waitForAppLoaded(60_000)

  // Settings → Team Directory: connect the Demo Directory with one token, then
  // one Install. Its install page is the host's own callback, so the window
  // that opens comes straight back.
  await page.goto('/settings/team-directory')
  await page.getByRole('radio', { name: 'Demo Directory' }).click()
  await page.getByLabel('Key').fill('demo-key')
  await page.getByRole('button', { name: 'Continue' }).click()
  const installWindow = page.waitForEvent('popup')
  await page.getByRole('button', { name: 'Install on Demo Directory' }).click()
  await expect((await installWindow).getByRole('heading', { name: 'ACME connected' })).toBeVisible()
  await expect(page.getByTestId('team-directory-row')).toContainText('ACME')

  const agent = await (await page.request.post('/api/agents', { data: { name: 'Support Desk' } })).json() as { slug: string }
  const session = await (await page.request.post(`/api/agents/${agent.slug}/sessions`, { data: { message: 'Draft the launch plan' } })).json() as { id: string }

  // Share with Dana, found in the directory and marked as not on Gamut.
  await page.goto(`/agents/${agent.slug}`)
  await openShare(page)
  await page.getByTestId('invite-search-input').fill('dana')
  const dana = page.locator('[data-testid^="invite-user-result-directory:"]').filter({ hasText: 'Dana Whitfield' })
  await expect(dana).toContainText('Not on Gamut')
  await dana.click()
  await page.getByTestId('invite-add-button').click()
  await page.getByTestId('invite-search-input').fill('')
  const danaMember = page.locator('[data-testid^="access-entry-"]').filter({ hasText: 'Dana Whitfield' })
  await expect(danaMember).toContainText('Invite pending')
  await page.keyboard.press('Escape')

  // Mention Lee, also from the directory: sharing comes first, then the mention.
  await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)
  const input = page.getByTestId('message-input')
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.click()
  await input.pressSequentially('@lee')
  const lee = page.locator('[data-testid^="mention-option-directory-"]').filter({ hasText: 'Lee Park' })
  await expect(lee).toContainText('Not on Gamut')
  await page.keyboard.press('Enter')
  await expect(input.getByTestId('user-mention')).toContainText('@Lee Park')
  await input.pressSequentially('can you check the refund queue?')
  await page.keyboard.press('Enter')
  const share = page.getByTestId('mention-access-dialog')
  await expect(share).toContainText('Share this agent with Lee Park?')
  await share.getByRole('button', { name: 'Share and send' }).click()
  await expect(share).not.toBeVisible()
  await expect(page.getByTestId('user-mention').last()).toContainText('@Lee Park')

  const members = await (await page.request.get(`/api/agents/${agent.slug}/members`)).json() as Array<{ email: string; invited?: boolean }>
  expect(members.filter((m) => m.invited).map((m) => m.email).sort()).toEqual(['dana@acme.test', 'lee.park@acme.test'])

  // Lee signs up with their email from the DM's link (the Demo Directory keeps
  // its DMs in memory, so the test opens the link the DM would carry) and is
  // signed in to what was waiting. (This server's data dir has admin approval
  // off; joining pending approval is in invited-user-claim.integration.test.ts.)
  const leeContext = await browser.newContext({ baseURL })
  try {
    const leePage = await leeContext.newPage()
    await leePage.goto(`/?join=${encodeURIComponent('lee.park@acme.test')}`)
    await expect(leePage.getByLabel('Email')).toHaveValue('lee.park@acme.test')
    await leePage.getByLabel('Name').fill('Lee Park')
    await leePage.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await leePage.getByLabel('Confirm Password').fill(PASSWORD)
    await leePage.getByTestId('signup-submit').click()
    await expect(leePage.getByTestId('app-sidebar')).toContainText('Support Desk', { timeout: 30_000 })
    await expect(leePage.getByText('Mentioned you')).toBeVisible()

    const listed = await (await page.request.get('/api/auth/admin/list-users?filterField=email&filterValue=lee.park@acme.test&filterOperator=eq')).json() as { users: Array<{ status: string }> }
    expect(listed.users).toEqual([expect.objectContaining({ status: 'active' })])
    const agents = await (await leeContext.request.get('/api/agents')).json() as Array<{ slug: string }>
    expect(agents.map((a) => a.slug)).toContain(agent.slug)
    const inbox = await (await leeContext.request.get('/api/notifications')).json() as { items: Array<{ type: string; body: string }> }
    expect(inbox.items.filter((n) => n.type === 'session_mention').map((n) => n.body)).toEqual([expect.stringContaining('can you check the refund queue?')])
  } finally {
    await leeContext.close()
  }

  // Lee is a member now; Dana is still invited.
  const after = await (await page.request.get(`/api/agents/${agent.slug}/members`)).json() as Array<{ email: string; invited?: boolean }>
  expect(after.filter((m) => m.invited).map((m) => m.email)).toEqual(['dana@acme.test'])
})
