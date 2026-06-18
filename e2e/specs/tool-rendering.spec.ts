import { test, expect, type APIRequestContext, type Locator, type Page, type TestInfo } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'
import { createAgent, createSession, openAgentSession, waitForSessionIdle } from '../helpers/agents'

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
  const setupSession = await createSession(
    request,
    agent,
    `setup tool rendering ${label} ${testInfo.workerIndex}-${testInfo.repeatEachIndex}`,
  )
  await waitForSessionIdle(request, agent, setupSession)

  await appPage.goto()
  await appPage.waitForAgentsLoaded()
  await openAgentSession(page, agent, setupSession)
  await sessionPage.waitForInputEnabled(15000)

  return { sessionPage }
}

function renderedToolCall(sessionPage: SessionPage, toolName: string) {
  return sessionPage.getToolCall(toolName).last()
}

async function setToolCallExpanded(toolCall: Locator, toolName: string, expanded: boolean) {
  const toggle = toolCall.getByTestId(`tool-call-toggle-${toolName}`)
  await expect(toggle).toBeVisible()
  if (await toggle.getAttribute('aria-expanded') !== String(expanded)) {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('aria-expanded', String(expanded))
}

test.describe('Tool Call Rendering', () => {
  test('renders Bash tool call with terminal display', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Bash')

    // Trigger the existing "list files" scenario which uses Bash tool
    await sessionPage.sendMessage('list files in the current directory')
    await sessionPage.waitForInputEnabled(20000)

    // Verify Bash tool call is rendered
    await sessionPage.expectToolCall('Bash', 20000)
    const toolCall = renderedToolCall(sessionPage, 'Bash')
    await expect(toolCall).toBeVisible()

    // Click to expand
    await setToolCallExpanded(toolCall, 'Bash', true)

    // Verify terminal-style display (black background)
    await expect(toolCall.getByTestId('bash-terminal')).toBeVisible()
  })

  test('renders Read tool call with file path summary', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Read')

    await sessionPage.sendMessage('read file please')
    await sessionPage.waitForInputEnabled(20000)

    // Verify Read tool call is rendered
    await sessionPage.expectToolCall('Read', 20000)
    const toolCall = renderedToolCall(sessionPage, 'Read')
    await expect(toolCall).toBeVisible()

    // Should show file path in summary
    await expect(toolCall).toContainText('src/index.ts')
  })

  test('renders Write tool call', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Write')

    await sessionPage.sendMessage('write file for me')
    await sessionPage.waitForInputEnabled(20000)

    // Verify Write tool call is rendered
    await sessionPage.expectToolCall('Write', 20000)
    const toolCall = renderedToolCall(sessionPage, 'Write')
    await expect(toolCall).toBeVisible()

    // Should show file path in summary
    await expect(toolCall).toContainText('hello.ts')
  })

  test('renders Grep tool call with search pattern', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Grep')

    await sessionPage.sendMessage('search code for TODOs')
    await sessionPage.waitForInputEnabled(20000)

    // Verify Grep tool call is rendered
    await sessionPage.expectToolCall('Grep', 20000)
    const toolCall = renderedToolCall(sessionPage, 'Grep')
    await expect(toolCall).toBeVisible()
  })

  test('renders Glob tool call', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Glob')

    await sessionPage.sendMessage('find files matching pattern')
    await sessionPage.waitForInputEnabled(20000)

    // Verify Glob tool call is rendered
    await sessionPage.expectToolCall('Glob', 20000)
  })

  test('renders WebSearch tool call', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'WebSearch')

    await sessionPage.sendMessage('search web for TypeScript tips')
    await sessionPage.waitForInputEnabled(20000)

    // Verify WebSearch tool call is rendered
    await sessionPage.expectToolCall('WebSearch', 20000)
    const toolCall = renderedToolCall(sessionPage, 'WebSearch')
    await expect(toolCall).toBeVisible()

    // Should show search query in summary
    await expect(toolCall).toContainText('TypeScript best practices')
  })

  test('tool call expand/collapse works', async ({ page, request }, testInfo) => {
    const { sessionPage } = await setupToolTest(page, request, testInfo, 'Expand')

    await sessionPage.sendMessage('list files in the current directory')
    await sessionPage.waitForInputEnabled(20000)

    const toolCall = renderedToolCall(sessionPage, 'Bash')
    await expect(toolCall).toBeVisible({ timeout: 20000 })

    // The row's expanded state is local; a post-turn message refetch can remount
    // it and reset the toggle. Re-drive each transition until the rendered
    // terminal matches, so the assertions don't race that remount.
    await expect(async () => {
      await setToolCallExpanded(toolCall, 'Bash', false)
      await expect(toolCall.getByTestId('bash-terminal')).not.toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 20000 })

    await expect(async () => {
      await setToolCallExpanded(toolCall, 'Bash', true)
      await expect(toolCall.getByTestId('bash-terminal')).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 20000 })

    await expect(async () => {
      await setToolCallExpanded(toolCall, 'Bash', false)
      await expect(toolCall.getByTestId('bash-terminal')).not.toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 20000 })
  })
})
