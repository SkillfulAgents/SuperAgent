import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { getE2EBaseUrl } from './base-url'

const API = getE2EBaseUrl()

export interface TestAgent {
  slug: string
  name: string
}

export async function createAgent(request: APIRequestContext, name: string): Promise<TestAgent> {
  const response = await request.post(`${API}/api/agents`, {
    data: { name },
  })

  expect(response.ok()).toBeTruthy()
  const agent = await response.json() as TestAgent
  expect(agent.slug).toBeTruthy()
  expect(agent.name).toBe(name)

  return agent
}

export async function openAgentHome(page: Page, agent: Pick<TestAgent, 'slug' | 'name'>) {
  const agentItemBySlug = page.locator(`[data-testid="agent-item-${agent.slug}"]`)
  const agentItemByName = page.locator('[data-testid^="agent-item-"]', { hasText: agent.name }).first()
  const agentItem = (await agentItemBySlug.count()) > 0 ? agentItemBySlug : agentItemByName

  await agentItem.scrollIntoViewIfNeeded({ timeout: 10000 })
  await expect(agentItem).toBeVisible({ timeout: 10000 })
  await agentItem.click()
  await expect(page.locator('[data-testid="agent-breadcrumb"]')).toHaveText(agent.name, { timeout: 10000 })
  await expect(page.locator('[data-testid="home-message-input"]')).toBeVisible()
}
