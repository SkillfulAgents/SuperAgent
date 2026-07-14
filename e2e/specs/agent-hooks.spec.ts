import * as fs from 'fs'
import * as path from 'path'
import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

const e2eDataDir = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')

async function getLatestAgentSlug(page: import('@playwright/test').Page): Promise<string> {
  const breadcrumb = page.locator('[data-testid="agent-breadcrumb"]')
  const agentName = await breadcrumb.textContent() || ''

  const response = await page.request.get('/api/agents')
  const agents = await response.json() as Array<{ slug: string; name: string; createdAt: string }>
  const match = agents.find(a => a.name === agentName.trim())
  if (match) return match.slug

  agents.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return agents[0]?.slug || ''
}

function claudeSettingsPath(agentSlug: string): string {
  return path.join(e2eDataDir, 'agents', agentSlug, 'workspace', '.claude', 'settings.json')
}

function seedClaudeSettings(agentSlug: string, settings: unknown) {
  const filePath = claudeSettingsPath(agentSlug)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(settings, null, 2))
}

// A self-installed prompt gate plus an unrelated CLI-owned setting that must
// survive hook removal untouched.
const SEEDED_SETTINGS = {
  cleanupPeriodDays: 9999,
  hooks: {
    UserPromptSubmit: [
      {
        hooks: [
          { type: 'command', command: 'python3 /workspace/.claude/hooks/gate.py', timeout: 10 },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'echo pre-bash-check' }],
      },
    ],
  },
}

test.describe('Agent hooks', () => {
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

  test('homepage lists configured hooks with a blocking-hook warning', async ({ page }) => {
    await agentPage.createAgent(`HooksList ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedClaudeSettings(agentSlug, SEEDED_SETTINGS)

    // The section self-hides when the (already fetched) hook list is empty —
    // reload so the seeded settings are picked up.
    await page.reload()
    await expect(page.getByText('Hooks', { exact: true })).toBeVisible({ timeout: 15000 })

    const rows = page.getByTestId('home-hooks-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'UserPromptSubmit' })).toContainText('gate.py')
    await expect(rows.filter({ hasText: 'PreToolUse' })).toContainText('echo pre-bash-check')

    // UserPromptSubmit hooks can block all input — the section must warn.
    await expect(page.getByTestId('home-hooks-warning')).toBeVisible()
  })

  test('removing a hook rewrites only the hooks key and hides the row', async ({ page }) => {
    await agentPage.createAgent(`HooksRemove ${Date.now()}`)
    const agentSlug = await getLatestAgentSlug(page)
    seedClaudeSettings(agentSlug, SEEDED_SETTINGS)
    await page.reload()

    const promptRow = page.getByTestId('home-hooks-row').filter({ hasText: 'UserPromptSubmit' })
    await expect(promptRow).toBeVisible({ timeout: 15000 })

    await promptRow.hover()
    await promptRow.getByRole('button', { name: 'Hook actions' }).click()
    await page.getByRole('button', { name: 'Remove Hook' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove Hook' }).click()

    await expect(page.getByTestId('home-hooks-row')).toHaveCount(1, { timeout: 10000 })
    await expect(page.getByTestId('home-hooks-warning')).not.toBeVisible()

    // The settings file keeps everything except the removed hook. A parse
    // failure here fails the test, which is exactly what it should do.
    let onDisk: { cleanupPeriodDays?: number; hooks?: Record<string, unknown[]> }
    try {
      onDisk = JSON.parse(fs.readFileSync(claudeSettingsPath(agentSlug), 'utf-8'))
    } catch {
      throw new Error('settings.json was rewritten to invalid JSON')
    }
    expect(onDisk.cleanupPeriodDays).toBe(9999)
    expect(onDisk.hooks?.UserPromptSubmit).toBeUndefined()
    expect(onDisk.hooks?.PreToolUse).toHaveLength(1)
  })

  test('a hook-blocked prompt surfaces as a warning card in the transcript', async ({ page }) => {
    await agentPage.createAgent(`HookBlock ${Date.now()}`)

    // The mock runtime mirrors the CLI's block shape for this phrase: an
    // informational warning + a num_turns:0 result, with NOTHING written to
    // the transcript by the runtime itself.
    await sessionPage.sendMessage('please trip the breaker now')

    const card = page.getByTestId('informational-item')
    await expect(card).toBeVisible({ timeout: 15000 })
    await expect(card).toContainText('blocked by hook')
    await expect(card).toContainText('Original prompt: please trip the breaker now')

    // Reload-safe: the banner was persisted to the transcript, not just streamed.
    await page.reload()
    await expect(page.getByTestId('informational-item')).toBeVisible({ timeout: 15000 })
  })
})
