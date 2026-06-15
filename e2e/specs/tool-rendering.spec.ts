import { test, expect, type Page } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

async function setupToolTest(page: Page) {
  const appPage = new AppPage(page)
  const agentPage = new AgentPage(page)
  const sessionPage = new SessionPage(page)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()

  return { agentPage, sessionPage }
}

test.describe('Tool Call Rendering', () => {
  test('renders Bash tool call with terminal display', async ({ page }) => {
    const { agentPage, sessionPage } = await setupToolTest(page)
    const agentName = `Tool Agent Bash ${Date.now()}`
    await agentPage.createAgent(agentName)

    // Trigger the existing "list files" scenario which uses Bash tool
    await sessionPage.sendMessage('list files in the current directory')

    // Verify Bash tool call is rendered
    await sessionPage.expectToolCall('Bash', 15000)
    const toolCall = sessionPage.getToolCall('Bash')
    await expect(toolCall).toBeVisible()

    // Click to expand
    await toolCall.locator('button').first().click()

    // Verify terminal-style display (black background)
    await expect(toolCall.getByTestId('bash-terminal')).toBeVisible()
  })

  test('renders Read tool call with file path summary', async ({ page }) => {
    const { agentPage, sessionPage } = await setupToolTest(page)
    const agentName = `Tool Agent Read ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('read file please')

    // Verify Read tool call is rendered
    await sessionPage.expectToolCall('Read', 15000)
    const toolCall = sessionPage.getToolCall('Read')
    await expect(toolCall).toBeVisible()

    // Should show file path in summary
    await expect(toolCall).toContainText('src/index.ts')
  })

  test('renders Write tool call', async ({ page }) => {
    const { agentPage, sessionPage } = await setupToolTest(page)
    const agentName = `Tool Agent Write ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('write file for me')

    // Verify Write tool call is rendered
    await sessionPage.expectToolCall('Write', 15000)
    const toolCall = sessionPage.getToolCall('Write')
    await expect(toolCall).toBeVisible()

    // Should show file path in summary
    await expect(toolCall).toContainText('hello.ts')
  })

  test('renders Grep tool call with search pattern', async ({ page }) => {
    const { agentPage, sessionPage } = await setupToolTest(page)
    const agentName = `Tool Agent Grep ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('search code for TODOs')

    // Verify Grep tool call is rendered
    await sessionPage.expectToolCall('Grep', 15000)
    const toolCall = sessionPage.getToolCall('Grep')
    await expect(toolCall).toBeVisible()
  })

  test('renders Glob tool call', async ({ page }) => {
    const { agentPage, sessionPage } = await setupToolTest(page)
    const agentName = `Tool Agent Glob ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('find files matching pattern')

    // Verify Glob tool call is rendered
    await sessionPage.expectToolCall('Glob', 15000)
  })

  test('renders WebSearch tool call', async ({ page }) => {
    const { agentPage, sessionPage } = await setupToolTest(page)
    const agentName = `Tool Agent WebSearch ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('search web for TypeScript tips')

    // Verify WebSearch tool call is rendered
    await sessionPage.expectToolCall('WebSearch', 15000)
    const toolCall = sessionPage.getToolCall('WebSearch')
    await expect(toolCall).toBeVisible()

    // Should show search query in summary
    await expect(toolCall).toContainText('TypeScript best practices')
  })

  test('tool call expand/collapse works', async ({ page }) => {
    const { agentPage, sessionPage } = await setupToolTest(page)
    const agentName = `Tool Agent Expand ${Date.now()}`
    await agentPage.createAgent(agentName)

    await sessionPage.sendMessage('list files in the current directory')

    await sessionPage.expectToolCall('Bash', 15000)
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
