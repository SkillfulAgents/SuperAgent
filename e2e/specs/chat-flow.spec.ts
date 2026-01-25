import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

// Run chat flow tests serially to avoid conflicts
test.describe.configure({ mode: 'serial' })

test.describe('Chat Flow', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage
  let testAgentName: string

  test.beforeEach(async ({ page }, testInfo) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)

    await appPage.goto()
    await appPage.waitForAgentsLoaded()

    // Use unique agent name per test
    testAgentName = `Chat Agent ${testInfo.workerIndex}-${Date.now()}`
    await agentPage.createAgent(testAgentName)
  })

  test('send message and see user message appear', async ({ page }) => {
    const messageText = 'Hello, this is a test message'

    // Send a message
    await sessionPage.sendMessage(messageText)

    // Verify user message appears
    await sessionPage.waitForUserMessageCount(1)
    await sessionPage.expectUserMessage(messageText)
  })

  test('send message and see streaming response', async ({ page }) => {
    // Send a message - MockContainerClient will automatically respond
    await sessionPage.sendMessage('Hello')

    // Verify user message appears
    await sessionPage.waitForUserMessageCount(1)

    // Wait for assistant response to appear (MockContainerClient auto-responds)
    await sessionPage.waitForResponse(15000)

    // Verify assistant message is visible
    const assistantMessages = sessionPage.getAssistantMessages()
    await expect(assistantMessages.first()).toBeVisible()
  })

  test('complete message exchange', async ({ page }) => {
    // Send a message
    await sessionPage.sendMessage('Tell me something')

    // Wait for user message
    await sessionPage.waitForUserMessageCount(1)

    // Wait for response to complete (MockContainerClient auto-responds)
    await sessionPage.waitForResponse(15000)

    // Verify we got both user and assistant messages
    await sessionPage.expectUserMessage('Tell me something')
    const assistantMessages = sessionPage.getAssistantMessages()
    await expect(assistantMessages.first()).toBeVisible()
  })

  test('see tool call in response', async ({ page }) => {
    // Send a message that triggers tool use scenario
    // MockContainerClient has a pattern match for "list files"
    await sessionPage.sendMessage('list files in the current directory')

    // Wait for user message
    await sessionPage.waitForUserMessageCount(1)

    // Wait for response (MockContainerClient auto-responds with tool use)
    await sessionPage.waitForResponse(15000)

    // Verify tool call is visible
    await sessionPage.expectToolCall('Bash', 15000)
  })

  test('input is re-enabled after response', async ({ page }) => {
    // Send a message
    await sessionPage.sendMessage('Process this')

    // Wait for response (MockContainerClient auto-responds)
    await sessionPage.waitForResponse(15000)

    // Input should be enabled after response
    await sessionPage.waitForInputEnabled()
  })

  test('multiple messages in conversation', async ({ page }) => {
    // Send first message
    await sessionPage.sendMessage('First message')

    // Wait for response
    await sessionPage.waitForResponse(15000)
    await sessionPage.waitForInputEnabled()

    // Send second message
    await sessionPage.sendMessage('Second message')
    await sessionPage.waitForUserMessageCount(2)

    // Wait for second response
    await sessionPage.waitForAssistantMessageCount(2, 15000)
  })

  // Note: No cleanup needed - global setup resets data between test runs
})
