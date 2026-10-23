import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { sessionMetadataMapSchema } from '../../src/shared/lib/services/session-metadata-schema'
import { AppPage } from '../pages/app.page'
import { SessionPage } from '../pages/session.page'

interface ScheduledTask {
  id: string
  agentSlug: string
  name: string
  scheduleExpression: string
  timezone: string
  status: string
  nextExecutionAt: string
  executionCount: number
  lastSessionId: string | null
}

async function readTask(request: APIRequestContext, taskId: string): Promise<ScheduledTask> {
  const response = await request.get(`/api/scheduled-tasks/${taskId}`)
  expect(response.ok()).toBe(true)
  return response.json()
}

async function createTask(page: Page, request: APIRequestContext) {
  const response = await request.post('/api/agents', {
    data: { name: `Scheduling validation ${Date.now()}` },
  })
  expect(response.status()).toBe(201)
  const agent = await response.json() as { slug: string }
  await page.goto(`/agents/${agent.slug}`)
  await new AppPage(page).waitForAgentsLoaded()
  const session = new SessionPage(page)
  // The container's deterministic tool call goes through the real host tool,
  // schedule parser, database and APIs. Only model execution is mocked.
  await session.sendMessage('schedule task for daily issues')
  await session.waitForResponse(15_000)
  await session.waitForInputEnabled()
  let task: ScheduledTask | undefined
  await expect.poll(async () => {
    const tasks = await request.get(`/api/agents/${agent.slug}/scheduled-tasks`)
    expect(tasks.ok()).toBe(true)
    task = (await tasks.json() as ScheduledTask[]).find(item => item.name === 'Daily Issue Summary')
    return Boolean(task)
  }).toBe(true)
  return task!
}

async function openTask(page: Page, task: ScheduledTask) {
  await page.goto(`/agents/${task.agentSlug}/tasks/${task.id}`)
  await expect(page.getByTestId('scheduled-task-title')).toHaveText('Daily Issue Summary')
}

function detail(page: Page, label: string) {
  return page.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd')
}

function expectWeekdayMorning(task: ScheduledTask, minutes: number[]) {
  const next = new Date(task.nextExecutionAt)
  expect(next.getTime()).toBeGreaterThan(Date.now())
  expect(next.getTime() - Date.now()).toBeLessThan(4 * 24 * 60 * 60 * 1000)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: task.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(next)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  expect(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']).toContain(values.weekday)
  expect(values.hour).toBe('09')
  expect(minutes).toContain(Number(values.minute))
  expect(values.second).toBe('00')
}

test.describe('Scheduling lifecycle with the real parser and scheduler', () => {
  test('edits descriptions and timezone, preserves rejected edits, and runs a paused schedule manually', async ({ page, request }) => {
    test.setTimeout(75_000)
    const task = await createTask(page, request)
    try {
      expectWeekdayMorning(task, [0])
      await openTask(page, task)
      await expect(detail(page, 'Schedule')).toHaveText('Runs at 09:00 AM, Monday through Friday')
      await expect(detail(page, 'Timezone')).toHaveText('America/New York')

      // English-to-cron conversion is an unrelated LLM call. Its result is
      // deterministic here; the actual save, parser validation and UI's
      // cRonstrue description all remain real.
      await page.route(`**/api/scheduled-tasks/${task.id}/describe-schedule`, route =>
        route.fulfill({ json: { description: 'Every weekday at 9 AM' } }))
      await page.route(`**/api/scheduled-tasks/${task.id}/parse-schedule`, route =>
        route.fulfill({ json: { expression: '*/17 9 * * 1-5' } }))
      await page.getByRole('button', { name: 'Cron settings' }).click()
      await page.getByRole('button', { name: 'Edit Schedule', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Edit Schedule', exact: true })
      await dialog.getByLabel('Schedule Description').fill('At 9 AM and every 17 minutes until 10 AM on weekdays')
      await dialog.getByRole('button', { name: 'Convert to Cron' }).click()
      await expect(dialog.getByText('*/17 9 * * 1-5', { exact: true })).toBeVisible()
      await dialog.getByRole('combobox', { name: 'Select timezone' }).click()
      await page.getByPlaceholder('Search timezone...').fill('Chatham')
      await page.getByRole('button', { name: /Pacific\/Chatham/ }).click()
      await dialog.getByRole('button', { name: 'Save Schedule' }).click()
      await expect(dialog).not.toBeVisible()
      await expect(detail(page, 'Schedule')).toContainText('at 0, 17, 34, and 51 minutes past the hour')
      await expect(detail(page, 'Timezone')).toHaveText('Pacific/Chatham')
      const edited = await readTask(request, task.id)
      expect(edited.scheduleExpression).toBe('*/17 9 * * 1-5')
      expect(edited.timezone).toBe('Pacific/Chatham')
      expectWeekdayMorning(edited, [0, 17, 34, 51])

      // Rejected expressions and timezone edits must not silently replace an
      // existing valid schedule or its persisted next run.
      for (const expression of ['*/0 * * * *', '0 9 31 2 *', '60 9 * * *']) {
        const invalid = await request.patch(`/api/scheduled-tasks/${task.id}/schedule`, { data: { scheduleExpression: expression } })
        expect(invalid.status()).toBe(400)
      }
      expect((await request.patch(`/api/scheduled-tasks/${task.id}/timezone`, { data: { timezone: 'Invalid/Zone' } })).status()).toBe(400)
      expect(await readTask(request, task.id)).toMatchObject({
        scheduleExpression: edited.scheduleExpression, timezone: edited.timezone, nextExecutionAt: edited.nextExecutionAt,
      })

      await page.getByRole('switch', { name: 'Pause cron' }).click()
      await expect(page.getByRole('switch', { name: 'Resume cron' })).not.toBeChecked()
      await expect(page.locator('dt', { hasText: /^Next Run$/ })).not.toBeVisible()
      expect((await readTask(request, task.id)).status).toBe('paused')

      const runResponse = page.waitForResponse(response => response.url().endsWith(`/api/scheduled-tasks/${task.id}/run-now`) && response.request().method() === 'POST')
      await page.getByRole('button', { name: 'Run Now', exact: true }).click()
      const run = await runResponse
      expect(run.status()).toBe(201)
      const { sessionId } = await run.json() as { sessionId: string }
      await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`))
      await new SessionPage(page).waitForResponse(15_000)
      const afterRun = await readTask(request, task.id)
      expect(afterRun).toMatchObject({ status: 'paused', executionCount: 1, lastSessionId: sessionId, nextExecutionAt: edited.nextExecutionAt })
      await openTask(page, task)
      await expect(page.getByText('No runs yet. Sessions will appear here once this cron runs.')).not.toBeVisible()
      await expect(page.getByTestId(`session-row-menu-${sessionId}`)).toBeAttached()
      await page.getByRole('switch', { name: 'Resume cron' }).click()
      await expect(page.getByRole('switch', { name: 'Pause cron' })).toBeChecked()
      expectWeekdayMorning(await readTask(request, task.id), [0, 17, 34, 51])
      await page.reload()
      await expect(detail(page, 'Timezone')).toHaveText('Pacific/Chatham')
      await expect(detail(page, 'Schedule')).toContainText('at 0, 17, 34, and 51 minutes past the hour')
      await expect(page.getByTestId(`session-row-menu-${sessionId}`)).toBeAttached()
    } finally {
      // A timed-out test may already have closed its request context; preserve
      // the original failure rather than replacing it with a cleanup error.
      await request.delete(`/api/scheduled-tasks/${task.id}`).catch(() => undefined)
    }
  })

  test('the real poll dispatches a due task and preserves the planned slot through successful history', async ({ page, request }) => {
    // The application polls every 60 seconds, and activity intentionally waits
    // 60 seconds before classifying a slot. Exercise those real clocks rather
    // than exposing a special test-only scheduler trigger.
    test.setTimeout(150_000)
    const task = await createTask(page, request)
    try {
      const updated = await request.patch(`/api/scheduled-tasks/${task.id}/schedule`, { data: { scheduleExpression: '*/10 * * * * *' } })
      expect(updated.ok()).toBe(true)
      const due = await updated.json() as ScheduledTask
      expect(new Date(due.nextExecutionAt).getTime() - Date.now()).toBeLessThanOrEqual(10_000)
      expect(new Date(due.nextExecutionAt).getTime()).toBeGreaterThan(Date.now() - 1000)
      await expect.poll(async () => (await readTask(request, task.id)).executionCount, { timeout: 85_000, intervals: [500, 1000] }).toBe(1)
      const fired = await readTask(request, task.id)
      expect(fired.lastSessionId).toBeTruthy()
      expect(new Date(fired.nextExecutionAt).getTime()).toBeGreaterThan(new Date(due.nextExecutionAt).getTime())
      expect((await request.post(`/api/scheduled-tasks/${task.id}/pause`)).ok()).toBe(true)

      const dataDir = process.env.SUPERAGENT_DATA_DIR
      expect(dataDir).toBeTruthy()
      const metadataPath = path.join(dataDir!, 'agents', task.agentSlug, 'workspace', 'session-metadata.json')
      await expect.poll(async () => {
        const metadata = sessionMetadataMapSchema.parse(JSON.parse(await readFile(metadataPath, 'utf8')))
        return metadata[fired.lastSessionId!]
      }).toMatchObject({
        isScheduledExecution: true,
        scheduledTaskId: task.id,
        scheduledExecutionAt: due.nextExecutionAt,
        automationStatus: 'succeeded',
      })

      await expect.poll(async () => {
        const response = await request.get(`/api/activity/agents/${task.agentSlug}?days=14&tz=0`)
        expect(response.ok()).toBe(true)
        const stats = await response.json() as { cronByTaskId: Record<string, Array<{ scheduledAt: string; status: string }>> }
        return stats.cronByTaskId[task.id]?.find(slot => slot.scheduledAt === due.nextExecutionAt)?.status
      }, { timeout: 75_000, intervals: [1000] }).toBe('succeeded')

      await openTask(page, task)
      await expect(page.getByTestId(`session-row-menu-${fired.lastSessionId}`)).toBeAttached()
      await expect(page.getByRole('switch', { name: 'Resume cron' })).not.toBeChecked()
      expect((await readTask(request, task.id)).executionCount).toBe(1)
    } finally {
      await request.delete(`/api/scheduled-tasks/${task.id}`).catch(() => undefined)
    }
  })
})
