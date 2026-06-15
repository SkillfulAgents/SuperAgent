import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import { createAgent, openAgentHome } from '../helpers/agents'

async function setupToolTest(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
  label: string,
) {
  const appPage = new AppPage(page)
  const sessionPage = new SessionPage(page)
  const agentName = `Tool Agent ${label} ${testInfo.workerIndex}-${testInfo.repeatEachIndex}-${Date.now()}`
  const agent = await createAgent(request, agentName)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await openAgentHome(page, agent)

  return { sessionPage }
}

test.describe('Tool Call Rendering', () => {
  test('renders Bash tool call with terminal display', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Bash')

    // Trigger the existing "list files" scenario which uses Bash tool
    await sessionPage.sendMessage('list files in the current directory')
    await sessionPage.waitForResponse(15000)

    // Verify Bash tool call is rendered
    await sessionPage.expectToolCall('Bash', 15000)
    const toolCall = sessionPage.getToolCall('Bash')
    await expect(toolCall).toBeVisible()

    // Click to expand
    await toolCall.locator('button').first().click()

    // Verify terminal-style display (black background)
    await expect(toolCall.getByTestId('bash-terminal')).toBeVisible()
  })

  test('renders Read tool call with file path summary', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Read')

    await sessionPage.sendMessage('read file please')
    await sessionPage.waitForResponse(15000)

    // Verify Read tool call is rendered
    await sessionPage.expectToolCall('Read', 15000)
    const toolCall = sessionPage.getToolCall('Read')
    await expect(toolCall).toBeVisible()

    // Should show file path in summary
    await expect(toolCall).toContainText('src/index.ts')
  })

  test('renders Write tool call', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Write')

    await sessionPage.sendMessage('write file for me')
    await sessionPage.waitForResponse(15000)

    // Verify Write tool call is rendered
    await sessionPage.expectToolCall('Write', 15000)
    const toolCall = sessionPage.getToolCall('Write')
    await expect(toolCall).toBeVisible()

    // Should show file path in summary
    await expect(toolCall).toContainText('hello.ts')
  })

  test('renders Grep tool call with search pattern', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Grep')

    await sessionPage.sendMessage('search code for TODOs')
    await sessionPage.waitForResponse(15000)

    // Verify Grep tool call is rendered
    await sessionPage.expectToolCall('Grep', 15000)
    const toolCall = sessionPage.getToolCall('Grep')
    await expect(toolCall).toBeVisible()
  })

  test('renders Glob tool call', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Glob')

    await sessionPage.sendMessage('find files matching pattern')
    await sessionPage.waitForResponse(15000)

    // Verify Glob tool call is rendered
    await sessionPage.expectToolCall('Glob', 15000)
  })

  test('renders WebSearch tool call', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'WebSearch')

    await sessionPage.sendMessage('search web for TypeScript tips')
    await sessionPage.waitForResponse(15000)

    // Verify WebSearch tool call is rendered
    await sessionPage.expectToolCall('WebSearch', 15000)
    const toolCall = sessionPage.getToolCall('WebSearch')
    await expect(toolCall).toBeVisible()

    // Should show search query in summary
    await expect(toolCall).toContainText('TypeScript best practices')
  })

  test('tool call expand/collapse works', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Expand')

    await sessionPage.sendMessage('list files in the current directory')
    await sessionPage.waitForResponse(15000)

    const toolCall = sessionPage.getToolCall('Bash')
    await expect(toolCall).toBeVisible()

    // Initially collapsed - no expanded content
    await expect(toolCall.getByTestId('bash-terminal')).not.toBeVisible()

    // Click to expand
    await toolCall.locator('button').first().click()
    await expect(toolCall.getByTestId('bash-terminal')).toBeVisible()

    // Click to collapse
    await toolCall.locator('button').first().click()
    await expect(toolCall.getByTestId('bash-terminal')).not.toBeVisible()
  })
})
