import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

async function setupChatFlowTest(page: Page, workerIndex: number) {
  const appPage = new AppPage(page)
  const agentPage = new AgentPage(page)
  const sessionPage = new SessionPage(page)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await agentPage.createAgent(`Chat Agent ${workerIndex}-${Date.now()}`)

  return { sessionPage }
}

test.describe('Chat Flow', () => {
  test('send message and see user message appear', async ({ page }, testInfo) => {
    const { sessionPage } = await setupChatFlowTest(page, testInfo.workerIndex)
    const messageText = 'Hello, this is a test message'

    // Send a message
    await sessionPage.sendMessage(messageText)

    // Verify user message appears
    await sessionPage.waitForUserMessageCount(1)
    await sessionPage.expectUserMessage(messageText)
  })

  test('send message and see streaming response', async ({ page }, testInfo) => {
    const { sessionPage } = await setupChatFlowTest(page, testInfo.workerIndex)
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

  test('complete message exchange', async ({ page }, testInfo) => {
    const { sessionPage } = await setupChatFlowTest(page, testInfo.workerIndex)
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

  test('see tool call in response', async ({ page }, testInfo) => {
    const { sessionPage } = await setupChatFlowTest(page, testInfo.workerIndex)
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

  test('input is re-enabled after response', async ({ page }, testInfo) => {
    const { sessionPage } = await setupChatFlowTest(page, testInfo.workerIndex)
    // Send a message
    await sessionPage.sendMessage('Process this')

    // Wait for response (MockContainerClient auto-responds)
    await sessionPage.waitForResponse(15000)

    // Input should be enabled after response
    await sessionPage.waitForInputEnabled()
  })

  test('multiple messages in conversation', async ({ page }, testInfo) => {
    const { sessionPage } = await setupChatFlowTest(page, testInfo.workerIndex)
    const initialUserCount = await sessionPage.getUserMessages().count()
    const initialAssistantCount = await sessionPage.getAssistantMessages().count()

    // Send first message
    await sessionPage.sendMessage('First message')

    // Wait for response
    await expect(sessionPage.getUserMessages()).toHaveCount(initialUserCount + 1, { timeout: 15000 })
    await expect(sessionPage.getAssistantMessages()).toHaveCount(initialAssistantCount + 1, { timeout: 15000 })
    await sessionPage.waitForInputEnabled()

    // Send second message
    await sessionPage.sendMessage('Second message')
    await expect(sessionPage.getUserMessages()).toHaveCount(initialUserCount + 2, { timeout: 15000 })

    // Wait for second response
    await expect(sessionPage.getAssistantMessages()).toHaveCount(initialAssistantCount + 2, { timeout: 15000 })
  })

  // Note: No cleanup needed - global setup resets data between test runs
})
