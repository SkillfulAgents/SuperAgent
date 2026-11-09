/**
 * Team directories end to end, on the mock server's Demo Directory (E2E_MOCK):
 * an admin connects it, a directory person is shared with and mentioned before
 * they join, and then they join from their invite link to find both waiting.
 */
import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { AppPage } from '../../pages/app.page'

const PASSWORD = 'DirectoryTesting123!'

/**
 * The invite link a DM would carry. The Demo Directory keeps its DMs in the
 * server's memory, so the test writes a link for the person the way the server does.
 */
function inviteLinkFor(dataDir: string, email: string): string {
  const db = new Database(path.join(dataDir, 'superagent.db'))
  try {
    const row = db.prepare(`select id from user where email = ? and status = 'invited'`).get(email) as { id: string } | undefined
    expect(row, `${email} is an invited user`).toBeTruthy()
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    db.prepare('insert into verification (id, identifier, value, expires_at, created_at, updated_at) values (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), `team-invite:${createHash('sha256').update(token).digest('base64url')}`, row!.id, now + 3_600_000, now, now)
    return `/?invite=${token}`
  } finally {
    db.close()
  }
}

async function openShare(page: Page) {
  await page.getByTestId('agent-share-button').click()
  await expect(page.getByTestId('agent-share-popover')).toBeVisible()
}

test('a directory person is shared with and mentioned before joining, then finds both waiting', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000)
  const dataDir = test.info().project.metadata.dataDir as string

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
  // In the transcript the mention of someone not on Gamut yet is dashed.
  await expect(page.locator('[data-testid="user-mention"][data-invited]').last()).toContainText('@Lee Park')

  const members = await (await page.request.get(`/api/agents/${agent.slug}/members`)).json() as Array<{ email: string; invited?: boolean }>
  expect(members.filter((m) => m.invited).map((m) => m.email).sort()).toEqual(['dana@acme.test', 'lee.park@acme.test'])

  // Lee joins from the invite link and is signed in to what was waiting. (This
  // server's data dir has admin approval off; joining pending approval is in
  // invited-user-claim.integration.test.ts.)
  const leeContext = await browser.newContext({ baseURL })
  try {
    const leePage = await leeContext.newPage()
    await leePage.goto(inviteLinkFor(dataDir, 'lee.park@acme.test'))
    await expect(leePage.getByTestId('invite-join-greeting')).toContainText('Ada Admin invited you to Gamut.')
    await leePage.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await leePage.getByLabel('Confirm Password').fill(PASSWORD)
    await leePage.getByTestId('invite-join-submit').click()
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
