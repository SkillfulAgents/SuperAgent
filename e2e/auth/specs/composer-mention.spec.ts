import { test, expect } from '../fixtures/multi-user.fixture'
import { AuthPage } from '../pages/auth.page'
import { AccessPage } from '../pages/access.page'
import { AppPage } from '../../pages/app.page'

const sender = { name: 'Graham Sender', email: 'graham-mention@test.com', password: 'password123' }
const teammate = { name: 'Iddo Gino', email: 'iddo-mention@test.com', password: 'password123' }
const agentName = 'Mention Agent'

async function signUp(page: import('@playwright/test').Page, user: typeof sender) {
  const authPage = new AuthPage(page)
  const appPage = new AppPage(page)
  await authPage.resetToAuthPage()
  await authPage.signUpOrSignIn(user.name, user.email, user.password)
  await appPage.waitForAppLoaded()
  await appPage.dismissWizardIfVisible()
}

test('mention: picker → chip → Notify → send with no agent turn, teammate sees @ and inbox', async ({
  user1Page: page,
  user2Page,
}) => {
  await signUp(page, sender)
  await signUp(user2Page, teammate)

  const agentRes = await page.request.post('/api/agents', { data: { name: agentName } })
  expect(agentRes.ok()).toBeTruthy()
  const { slug } = (await agentRes.json()) as { slug: string }

  const accessPage = new AccessPage(page)
  await page.goto('/')
  await accessPage.openAccessTab(agentName)
  await accessPage.inviteUser(teammate.email, 'user')
  await accessPage.closeSettings()

  const sessionRes = await page.request.post(`/api/agents/${slug}/sessions`, {
    data: { message: 'starting the shared thread' },
  })
  expect(sessionRes.ok()).toBeTruthy()
  const { id: sessionId } = (await sessionRes.json()) as { id: string }
  await page.goto(`/agents/${slug}/sessions/${sessionId}`)
  await expect(page.getByTestId('message-input')).toBeVisible({ timeout: 15000 })

  const editor = page.getByTestId('message-input')
  await editor.click()
  await page.keyboard.type('refunds fail, @idd')
  await expect(page.getByTestId('mention-menu')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(editor.getByTestId('mention-chip')).toHaveText('@Iddo Gino')
  await expect(page.getByTestId('mention-helper-strip')).toHaveCount(0)
  await expect(page.getByTestId('send-button')).toHaveAttribute('title', 'Notify')
  await page.getByTestId('send-button').click()
  await expect(page.getByTestId('message-user').last().getByTestId('mention-chip')).toHaveText('@Iddo Gino')
  await expect(page.getByTestId('mention-meta')).toHaveCount(0)
  await expect(page.getByLabel('working')).toHaveCount(0)

  await user2Page.reload()
  await expect(user2Page.getByTestId('mention-mark').first()).toBeVisible()
  await user2Page.goto('/notifications')
  await expect(user2Page.getByText('mentioned you')).toBeVisible()
})
