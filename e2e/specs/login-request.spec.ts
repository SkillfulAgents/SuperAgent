import { test, expect, type Locator, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'
import { mockRecorder } from '../helpers/mock-recorder'

/**
 * request_login end to end: the agent maps a sign-in form, the app draws its
 * own form for the site the browser reported, and what the user types goes to
 * the container's page writer — never into the transcript. The mock container
 * serves a fixed form on https://example.com and records each fill it gets.
 */

interface LoginFillRecord {
  type: 'loginFill'
  agentSlug: string
  toolUseId: string
  origin: string
  values: string[]
}

const recorder = mockRecorder<LoginFillRecord>()

/**
 * On to the card's fields. Every test signs in to example.com on one shared
 * server, so another test's saved account may be there: the card then opens
 * on the saved accounts, and "Use a different account" leads to the fields.
 */
async function toFields(card: Locator): Promise<void> {
  const different = card.getByTestId('login-different-account')
  const field = card.getByTestId('login-field-0')
  await expect(different.or(field)).toBeVisible({ timeout: 15000 })
  if (await different.isVisible()) await different.click()
  await expect(field).toBeEnabled({ timeout: 10000 })
}

function sessionFromUrl(page: Page): { agentSlug: string; sessionId: string } {
  const match = page.url().match(/\/agents\/([^/?#]+)\/sessions\/([^/?#]+)/)
  if (!match) throw new Error(`not on a session page: ${page.url()}`)
  return { agentSlug: match[1], sessionId: match[2] }
}

test.describe('Sign-in requests', () => {
  test.describe.configure({ timeout: 60_000 })

  let sessionPage: SessionPage

  test.beforeEach(async ({ page }, testInfo) => {
    const appPage = new AppPage(page)
    const agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Login Agent ${testInfo.workerIndex}-${Date.now()}`, { waitForSidebarName: false })
  })

  test('fills the page from the app\'s form, and keeps the password out of the transcript', async ({ page }, testInfo) => {
    const password = `pw-${testInfo.workerIndex}-${Date.now()}-secret`
    await sessionPage.sendMessage('ask login')

    const card = page.getByTestId('login-request')
    await expect(card).toBeVisible({ timeout: 15000 })
    // The title is the site the browser reported, not the agent's words.
    await expect(card.getByText('Sign in to example.com')).toBeVisible()
    await expect(card.getByTestId('login-origin')).toHaveText('https://example.com')

    const email = card.getByTestId('login-field-0')
    const secret = card.getByTestId('login-field-1')
    await toFields(card)
    // Kept out of the browser's password manager: another site's credentials,
    // typed on this app's origin.
    await expect(email).toHaveAttribute('autocomplete', 'off')
    await expect(secret).toHaveAttribute('type', 'text')
    await expect(secret).toHaveCSS('-webkit-text-security', 'disc')
    await expect(secret).toHaveAttribute('data-1p-ignore', 'true')
    await expect(card.getByTestId('login-privacy')).toHaveText('What you enter goes straight into example.com. The agent never sees the password; it can see the username.')
    await expect(card.getByTestId('login-submit')).toBeDisabled()

    await email.fill('person@example.com')
    await secret.fill(password)
    await card.getByTestId('login-submit').click()

    // Answered: the card leaves the stack.
    await expect(page.getByTestId('login-request')).toHaveCount(0, { timeout: 10000 })
    const fill = await recorder.waitFor((r) => r.type === 'loginFill' && r.values.includes(password), { label: 'loginFill' })
    expect(fill).toMatchObject({ origin: 'https://example.com', values: ['person@example.com', password] })

    // Nowhere the agent or the transcript can see it.
    await sessionPage.waitForInputEnabled(15000)
    const { agentSlug, sessionId } = sessionFromUrl(page)
    const messages = await page.request.get(`/api/agents/${agentSlug}/sessions/${sessionId}/messages`)
    expect(messages.ok()).toBe(true)
    expect(await messages.text()).not.toContain(password)
    // Nothing on the page holds it any more: no text, and no input's value.
    const onPage = await page.evaluate((secret) => document.body.innerText.includes(secret)
      || Array.from(document.querySelectorAll('input, textarea')).some((el) => (el as HTMLInputElement).value.includes(secret)), password)
    expect(onPage).toBe(false)
  })

  test('lets the user sign in on the page instead', async ({ page }) => {
    await sessionPage.sendMessage('ask login')
    const card = page.getByTestId('login-request')
    await expect(card).toBeVisible({ timeout: 15000 })
    await toFields(card)

    await card.getByTestId('login-take-over').click()
    await expect(card.getByTestId('login-manual')).toContainText('Sign in directly in the browser view on example.com')
    await card.getByTestId('login-manual-done').click()

    await expect(page.getByTestId('login-request')).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)
    // Nothing was sent to the page from the form.
    const { agentSlug } = sessionFromUrl(page)
    expect(recorder.read().some((r) => r.type === 'loginFill' && r.agentSlug === agentSlug)).toBe(false)
  })

  test('saves the account, then signs the agent in from the vault without a card, and manages it in settings', async ({ page }, testInfo) => {
    const username = `vault-${testInfo.workerIndex}-${Date.now()}@example.com`
    const password = `pw-${testInfo.workerIndex}-${Date.now()}-vault`
    await sessionPage.sendMessage('ask login')
    const card = page.getByTestId('login-request')
    await toFields(card)
    // On by default for an agent no one else uses.
    await expect(card.getByTestId('login-save')).toHaveAttribute('data-state', 'checked')
    await card.getByTestId('login-field-0').fill(username)
    await card.getByTestId('login-field-1').fill(password)
    await card.getByTestId('login-submit').click()
    await expect(page.getByTestId('login-request')).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)

    // The agent asks again: its saved account answers, and no card asks the user.
    await sessionPage.sendMessage('ask login')
    await sessionPage.waitForInputEnabled(15000)
    await expect(page.getByTestId('login-request')).toHaveCount(0)

    // Settings → Logins lists it, with this agent allowed to sign in with it.
    await page.goto('/settings/logins')
    const row = page.locator('[data-testid^="login-row-"]', { hasText: username }).first()
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toContainText('example.com')
    await expect(row).toContainText('Password')
    await row.click()
    // The one agent with access: its switch reads "Stop … signing in as …".
    const toggle = page.getByRole('switch', { name: new RegExp(`^Stop .* signing in as ${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} on example\\.com$`) })
    await expect(toggle).toHaveCount(1)
    await expect(toggle).toBeChecked()
    // Nothing on the page holds the password.
    expect(await page.evaluate((secret) => document.body.innerText.includes(secret), password)).toBe(false)

    // Deleted: the next sign-in asks the user again.
    await page.getByTestId('login-detail-delete').click()
    await page.getByTestId('login-delete-confirm').click()
    await expect(page.getByTestId('logins-settings')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid^="login-row-"]', { hasText: username })).toHaveCount(0)
  })

  test('declines', async ({ page }) => {
    await sessionPage.sendMessage('ask login')
    const card = page.getByTestId('login-request')
    await expect(card).toBeVisible({ timeout: 15000 })
    await card.getByTestId('login-decline').click()
    await expect(page.getByTestId('login-request')).toHaveCount(0, { timeout: 10000 })
    await sessionPage.waitForInputEnabled(15000)
  })
})
