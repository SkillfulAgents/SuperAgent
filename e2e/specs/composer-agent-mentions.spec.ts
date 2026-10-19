import { expect, test, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { mockRecorder } from '../helpers/mock-recorder'

interface MockRecord {
  type: 'sendMessage' | 'createSession'
  agentSlug: string
  initialMessage?: string
  content?: string
}

interface Agent { slug: string; displaySlug: string; name: string }
interface Policy { operation: string; targetAgentSlug: string | null; decision: string }

const recorder = mockRecorder<MockRecord>()

async function createAgent(page: Page, name: string): Promise<Agent> {
  const response = await page.request.post('/api/agents', { data: { name } })
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function policiesOf(page: Page, agent: Agent): Promise<Policy[]> {
  const response = await page.request.get(`/api/agents/${agent.slug}/x-agent-policies`)
  expect(response.ok()).toBeTruthy()
  return (await response.json()).policies
}

test.describe('composer agent mentions', () => {
  // Unique words, so `@<word>` finds this test's agents only.
  let tag: string
  let support: Agent
  let billing: Agent

  test.beforeEach(async ({ page }, testInfo) => {
    tag = `w${testInfo.workerIndex}t${Date.now().toString(36)}`
    support = await createAgent(page, `Support ${tag}`)
    billing = await createAgent(page, `Billing ${tag}`)
    const app = new AppPage(page)
    await app.goto()
    await app.waitForAgentsLoaded()
    await page.goto(`/agents/${support.slug}`)
    await expect(page.getByTestId('home-message-input')).toBeVisible({ timeout: 15_000 })
  })

  test('tags another agent with the slug its tools take, after offering access', async ({ page }) => {
    const input = page.getByTestId('home-message-input')
    await input.click()
    await input.pressSequentially(`Get the Q3 numbers from @${tag}`)

    // The agent being messaged is never offered.
    const menu = page.getByTestId('mention-menu')
    await expect(menu.getByRole('option')).toHaveCount(1)
    await expect(menu.getByTestId(`mention-option-agent-${billing.slug}`)).toContainText(`Billing ${tag}`)
    await page.keyboard.press('Enter')
    await expect(input.getByTestId('agent-mention')).toContainText(`@Billing ${tag}`)
    await input.pressSequentially('and summarize them')
    await page.getByTestId('home-send-button').click()

    const dialog = page.getByTestId('mention-access-dialog')
    await expect(dialog).toContainText(`Let Support ${tag} reach Billing ${tag}?`)
    await dialog.getByTestId('mention-reach-select').click()
    await page.getByRole('option', { name: 'Send it messages', exact: true }).click()
    await dialog.getByRole('button', { name: 'Allow and send' }).click()

    // The bubble draws the chip; the agent reads the name, and the slug to reach it by.
    const bubble = page.getByTestId('message-user').filter({ hasText: 'and summarize them' })
    await expect(bubble.getByTestId('agent-mention')).toContainText(`@Billing ${tag}`, { timeout: 15_000 })
    await expect(bubble).not.toContainText('Mentioned')
    const record = await recorder.waitFor((candidate) => candidate.type === 'createSession' && candidate.agentSlug === support.slug)
    expect(record.initialMessage).toBe(
      `Get the Q3 numbers from @Billing ${tag} and summarize them\n\n[Mentioned:]\n`
      + `- @Billing ${tag}: agent, slug ${billing.displaySlug} (call it by this slug with the agents tools, no need to list agents first)`,
    )
    expect(await policiesOf(page, support)).toEqual([
      expect.objectContaining({ operation: 'invoke', targetAgentSlug: billing.slug, decision: 'allow' }),
    ])

    // Now that it may, tagging the agent again asks nothing.
    await expect(page.getByTestId('message-assistant').first()).toBeVisible({ timeout: 30_000 })
    const sessionInput = page.getByTestId('message-input')
    await sessionInput.click()
    await sessionInput.pressSequentially(`Thank @${tag}`)
    await page.keyboard.press('Enter')
    await sessionInput.pressSequentially('for me')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('message-user').filter({ hasText: 'for me' }).getByTestId('agent-mention')).toBeVisible()
    await expect(page.getByTestId('mention-access-dialog')).toHaveCount(0)
    await recorder.waitFor((candidate) => candidate.type === 'sendMessage' && candidate.agentSlug === support.slug
      && !!candidate.content?.startsWith(`Thank @Billing ${tag} for me`))
  })

  test('keeps the draft when the access prompt is cancelled', async ({ page }) => {
    const input = page.getByTestId('home-message-input')
    await input.click()
    await input.pressSequentially(`Ask @${tag}`)
    await page.keyboard.press('Tab')
    await page.getByTestId('home-send-button').click()

    const dialog = page.getByTestId('mention-access-dialog')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).not.toBeVisible()

    await expect(input.getByTestId('agent-mention')).toContainText(`@Billing ${tag}`)
    await expect(page.getByTestId('message-list')).toHaveCount(0)
    expect(await policiesOf(page, support)).toEqual([])
  })
})
