import { expect, type Page } from '@playwright/test'
import type { AgentPage } from '../pages/agent.page'

export interface SeededChatIntegration {
  slug: string
  integrationId: string
}

/**
 * Create an agent via the UI, seed a Telegram chat integration for it, and return
 * its slug + integration id. Chat integrations ARE seedable in mock mode (POST
 * /api/chat-integrations/<slug>); sessions and access rows are not. Each call
 * makes a fresh agent, so callers stay isolated from one another.
 */
export async function createAgentWithTelegramIntegration(
  page: Page,
  agentPage: AgentPage,
  { agentName, integrationName, chatId = '12345' }: { agentName: string; integrationName: string; chatId?: string },
): Promise<SeededChatIntegration> {
  await agentPage.createAgent(agentName)
  const slug = page.url().match(/\/agents\/([^/?#]+)/)?.[1]
  expect(slug).toBeTruthy()

  const seedResp = await page.request.post(`/api/chat-integrations/${slug}`, {
    data: {
      provider: 'telegram',
      name: integrationName,
      config: { botToken: `fake-${Date.now()}`, chatId },
    },
  })
  expect(seedResp.ok()).toBeTruthy()

  const listResp = await page.request.get(`/api/agents/${slug}/chat-integrations`)
  expect(listResp.ok()).toBeTruthy()
  const integrations = (await listResp.json()) as Array<{ id: string }>
  const integrationId = integrations[0]?.id
  expect(integrationId).toBeTruthy()

  return { slug: slug!, integrationId: integrationId! }
}
