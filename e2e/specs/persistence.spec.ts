import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Run persistence tests serially to avoid conflicts
test.describe.configure({ mode: 'serial' })

test.describe('Persistence', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
  })

  test('agent persists after page reload', async ({ page }) => {
    const agentName = `Persist Agent ${Date.now()}`

    // Create agent
    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Reload page
    await appPage.reload()

    // Verify agent still exists
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Clean up
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('messages persist after page reload', async ({ page, request }) => {
    const agentName = `Message Persist Agent ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Send a message and wait for response
    await sessionPage.sendMessage('Persistent message')
    await sessionPage.waitForResponse()
    await sessionPage.waitForInputEnabled()
    await sessionPage.expectUserMessage('Persistent message')

    // Verify assistant response is visible
    await expect(sessionPage.getAssistantMessages().first()).toBeVisible()

    // Get the agent slug from the agents list API
    const agentsResponse = await request.get('http://localhost:3000/api/agents')
    expect(agentsResponse.ok()).toBeTruthy()
    const agents = await agentsResponse.json()
    const agent = agents.find((a: { name: string }) => a.name === agentName)
    expect(agent).toBeDefined()
    const agentSlug = agent.slug

    // Get sessions for this agent via API
    const sessionsResponse = await request.get(`http://localhost:3000/api/agents/${agentSlug}/sessions`)
    expect(sessionsResponse.ok()).toBeTruthy()
    const sessions = await sessionsResponse.json()
    expect(sessions.length).toBeGreaterThan(0)

    const sessionId = sessions[0].id

    // Get messages for the session via API
    const messagesResponse = await request.get(
      `http://localhost:3000/api/agents/${agentSlug}/sessions/${sessionId}/messages`
    )
    expect(messagesResponse.ok()).toBeTruthy()
    const messages = await messagesResponse.json()

    // Verify messages are persisted
    expect(messages.length).toBeGreaterThan(0)
    const userMessage = messages.find((m: { type: string }) => m.type === 'user')
    expect(userMessage).toBeDefined()
    // content is { text: string } not a plain string
    expect(userMessage.content.text).toContain('Persistent message')

    // Reload page to verify data survives reload
    await appPage.reload()

    // Verify via API that messages still exist after reload
    const messagesAfterReload = await request.get(
      `http://localhost:3000/api/agents/${agentSlug}/sessions/${sessionId}/messages`
    )
    expect(messagesAfterReload.ok()).toBeTruthy()
    const messagesAfter = await messagesAfterReload.json()
    expect(messagesAfter.length).toBeGreaterThan(0)

    // Clean up
    await agentPage.selectAgent(agentName)
    await agentPage.deleteAgent()
  })

  test('deleted agent stays deleted after reload', async ({ page }) => {
    const agentName = `Deletable Agent ${Date.now()}`

    // Create agent
    await agentPage.createAgent(agentName)
    await expect(agentPage.getAgentItem(agentName)).toBeVisible()

    // Delete agent
    await agentPage.deleteAgent()
    await expect(agentPage.getAgentItem(agentName)).not.toBeVisible()

    // Reload page
    await appPage.reload()

    // Verify agent is still gone
    await expect(agentPage.getAgentItem(agentName)).not.toBeVisible()
  })

  test('multiple agents persist', async ({ page }) => {
    const timestamp = Date.now()
    const agents = [`Agent One ${timestamp}`, `Agent Two ${timestamp}`, `Agent Three ${timestamp}`]

    // Create multiple agents
    for (const name of agents) {
      await agentPage.createAgent(name)
      await expect(agentPage.getAgentItem(name)).toBeVisible()
    }

    // Reload page
    await appPage.reload()

    // Verify all agents still exist
    for (const name of agents) {
      await expect(agentPage.getAgentItem(name)).toBeVisible()
    }

    // Clean up - delete all agents
    for (const name of agents) {
      await agentPage.selectAgent(name)
      await agentPage.deleteAgent()
    }
  })
})
