import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createAgent } from '../helpers/agents'
import { SessionPage } from '../pages/session.page'
import type { ApiMessage } from '../../src/shared/lib/types/api'
import type { ConnectionInfo } from '../../src/shared/lib/llm-provider/connection-schema'

type TrackedEvent = { event: string; properties: Record<string, unknown> }
async function trackedEvents(page: Page): Promise<TrackedEvent[]> {
  return page.evaluate(() => (window as unknown as { paywallTestEvents?: TrackedEvent[] }).paywallTestEvents ?? [])
}

// Billing and the exhausted response are mocked. Connection creation, message
// sending, and the session's saved provider all go through the real app API.
async function openPaywall(page: Page, request: APIRequestContext, subscribed = false) {
  // E2E disables outbound analytics. Replace only the SDK adapter with a memory
  // sink, exercising the real AnalyticsProvider and component event handlers.
  await page.route(/\/lib\/analytics\.ts(?:\?|$)/, route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      export const hasActivePlugins = () => true;
      export const getAnalyticsMetadata = () => ({});
      export const createAnalyticsInstance = () => ({
        identify() {},
        track(event, properties) {
          window.paywallTestEvents ??= [];
          window.paywallTestEvents.push({ event, properties });
        }
      });
    `,
  }))
  const agent = await createAgent(request, `Subscription recovery ${Date.now()}`)
  const created = await request.post(`/api/agents/${agent.slug}/sessions`, { data: { message: 'Hello' } })
  expect(created.ok()).toBe(true)
  const session = await created.json() as { id: string }
  const endpoint = `/api/agents/${agent.slug}/sessions/${session.id}`
  await expect.poll(async () => (await (await request.get(endpoint)).json()).isActive).toBe(false)

  const sends: Array<{ content: string; llmProviderId?: string; model?: string }> = []
  await page.route('**/api/platform-auth', route => route.fulfill({ json: {
    connected: true, orgId: 'test-org', role: 'owner', platformBaseUrl: 'https://platform.example.test',
  } }))
  await page.route('**/api/platform-auth/billing', route => route.fulfill({ json: {
    connected: true,
    billing: {
      configured: true,
      subscription: { status: subscribed ? 'active' : 'none', paymentStatus: 'current', currentPeriodEnd: null },
      seat: { balanceCents: 0, startingBalanceCents: 2000 }, orgPool: { poolBalanceCents: 0 },
      hasPaymentMethod: true, access: { allowed: false, reason: 'insufficient_balance' },
    },
  } }))
  await page.route(`**${endpoint}/messages?*`, async route => {
    const response = await route.fetch()
    const body = await response.json() as { messages: ApiMessage[] }
    if (sends.length === 0) {
      body.messages = body.messages.map(message => message.type === 'assistant' ? {
        ...message,
        content: { text: `API Error: 402 {"error":"insufficient_balance","subscription_required":${!subscribed}}` },
        apiError: 'billing_error',
        errorPresentation: {
          severity: 'error', icon: 'circle-dollar-sign', component: 'platform-paywall', placement: 'composer',
          message: '**You need more usage credit to continue** Subscribe or top up.',
          href: 'https://platform.example.test/dashboard/organizations/test-org?tab=billing',
        },
      } : message)
    }
    await route.fulfill({ response, json: body })
  })
  await page.route(`**${endpoint}/messages`, async route => {
    if (route.request().method() === 'POST') sends.push(route.request().postDataJSON())
    await route.continue()
  })
  await page.goto(`/agents/${agent.slug}/sessions/${session.id}`)
  await expect(page.getByTestId('paywall-card')).toBeVisible({ timeout: 15000 })
  return { agent, endpoint, sends }
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`connects from the subscription paywall and continues on the new provider (${colorScheme})`, async ({ page, request }, testInfo) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
    const baseline = await (await request.get('/api/llm-connections')).json()
    const { agent, endpoint, sends } = await openPaywall(page, request)
    let connectionId: string | undefined
    try {
      const options = page.getByTestId('paywall-subscriptions')
      await expect(options).toBeVisible()
      await expect(page.getByTestId('message-input')).not.toBeVisible()
      await page.getByTestId('paywall-card-frame').screenshot({ path: testInfo.outputPath(`paywall-${colorScheme}.png`), animations: 'disabled' })

      for (const [name, signInName] of [['Grok', 'Grok'], ['OpenAI', 'Codex'], ['Kimi', 'Kimi'], ['MiniMax', 'MiniMax']]) {
        await options.getByRole('button', { name: `Connect ${name}`, exact: true }).click()
        const dialog = page.getByRole('dialog')
        await expect(dialog.getByRole('button', { name: `Sign in with ${signInName}`, exact: true })).toBeVisible()
        await expect(dialog.getByRole('button', { name: 'Save and resume chat' })).toBeDisabled()
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      }

      await options.getByRole('button', { name: 'Connect Claude Code', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('claude setup-token', { exact: true })).toBeVisible()
      await dialog.screenshot({ path: testInfo.outputPath(`subscription-modal-${colorScheme}.png`), animations: 'disabled' })
      const name = `Paywall Claude ${testInfo.workerIndex}-${Date.now()}`
      await dialog.getByLabel('Connection name', { exact: true }).fill(name)
      await dialog.getByLabel('Subscription token', { exact: true }).fill('sk-ant-oat01-e2e-placeholder')
      const saveResponse = page.waitForResponse(response => response.url().endsWith('/api/llm-connections') && response.request().method() === 'POST')
      await dialog.getByRole('button', { name: 'Save and resume chat' }).click()
      const saved = await saveResponse
      expect(saved.ok(), await saved.text()).toBe(true)
      connectionId = (await saved.json()).id
      await expect(page.getByTestId('paywall-card')).not.toBeVisible()
      await expect(dialog).not.toBeVisible()
      await expect.poll(() => sends.length).toBe(1)
      const after = await (await request.get('/api/llm-connections')).json()
      const connection = (after.connections as ConnectionInfo[]).find(item => item.name === name)!
      connectionId = connection.id
      expect(connection.provider).toBe('claude-subscription')
      expect(sends[0]).toMatchObject({ content: 'Continue', llmProviderId: connectionId, model: connection.defaultModel })
      await expect.poll(async () => (await (await request.get(endpoint)).json()).llmProviderId).toBe(connectionId)
      expect(after.defaultSelection).toEqual(baseline.defaultSelection)

      await expect.poll(async () => (await trackedEvents(page)).filter(item => item.event === 'paywall_subscription_resumed').length).toBe(1)
      const events = await trackedEvents(page)
      const shown = events.filter(item => item.event === 'paywall_shown')
      expect(shown).toHaveLength(1)
      const flow = events.filter(item => item.properties.provider === 'claude-subscription')
      expect(flow.map(item => item.event)).toEqual([
        'paywall_subscription_clicked', 'paywall_subscription_token_entered',
        'paywall_subscription_save_started', 'paywall_subscription_saved',
        'paywall_subscription_resume_started', 'paywall_subscription_resumed', 'paywall_cleared',
      ])
      const attemptId = flow[0].properties.attemptId
      for (const { properties } of flow) {
        expect(properties).toMatchObject({ attemptId, paywallId: shown[0].properties.paywallId, entryPoint: 'platform_paywall', paywallType: 'subscription' })
      }
      expect(flow.at(-1)?.properties.resolution).toBe('subscription')
      expect(events.filter(item => item.event === 'paywall_subscription_cancelled')).toHaveLength(4)
      expect(JSON.stringify(events)).not.toContain('sk-ant-oat01-e2e-placeholder')
      expect(JSON.stringify(events)).not.toContain(name)

      // The composer's next send must retain the subscription rather than
      // resurrecting the platform selection it had before the paywall.
      const chat = new SessionPage(page)
      await chat.waitForInputEnabled()
      await expect.poll(async () => (await (await request.get(endpoint)).json()).isActive).toBe(false)
      await chat.sendMessage('Thanks, keep going')
      await expect.poll(() => sends.length).toBe(2)
      expect(sends[1].llmProviderId).toBe(connectionId)
      await page.reload()
      await expect(page.getByTestId('message-input')).toBeVisible()
      await expect(page.getByTestId('paywall-card')).not.toBeVisible()
    } finally {
      await request.delete(`/api/agents/${agent.slug}`)
      if (connectionId) await request.delete(`/api/llm-connections/${connectionId}`)
    }
  })
}

test('does not offer subscription connections on a top-up paywall', async ({ page, request }) => {
  const { agent } = await openPaywall(page, request, true)
  try {
    await expect(page.getByRole('button', { name: 'Add usage', exact: true })).toBeVisible()
    await expect(page.getByTestId('paywall-subscriptions')).not.toBeVisible()
    const events = await trackedEvents(page)
    expect(events.some(item => item.event.startsWith('paywall_subscription_'))).toBe(false)
    expect(events.find(item => item.event === 'paywall_shown')?.properties.paywallType).toBe('topup')
  } finally {
    await request.delete(`/api/agents/${agent.slug}`)
  }
})
