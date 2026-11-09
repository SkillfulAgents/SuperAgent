import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import type { UsageResponse } from '../../src/shared/lib/types/usage'
import type { ConnectionActivityStats } from '../../src/shared/lib/types/activity'

/** App flows shared with local browser and Electron validation. */
export interface UsageChartsContext {
  page: Page
  request: APIRequestContext
  apiBaseUrl: string
  navigate: (path: string) => Promise<unknown>
}

export const usageChartFixture: UsageResponse = {
  daily: [
    {
      date: '2026-08-09', totalCost: 14, totalTokens: 1_400,
      byModel: [
        { model: 'claude-sonnet-4-6', cost: 12, totalTokens: 1_200 },
        { model: 'gpt-5', cost: 2, totalTokens: 200 },
      ],
      byAgent: [
        { agentSlug: 'research', agentName: 'Research Agent', cost: 10, totalTokens: 1_000 },
        { agentSlug: 'support', agentName: 'Support Agent', cost: 4, totalTokens: 400 },
      ],
    },
    {
      date: '2026-08-10', totalCost: 6, totalTokens: 600,
      byModel: [{ model: 'gpt-5', cost: 6, totalTokens: 600 }],
      byAgent: [
        { agentSlug: 'research', agentName: 'Research Agent', cost: 2, totalTokens: 200 },
        { agentSlug: 'support', agentName: 'Support Agent', cost: 4, totalTokens: 400 },
      ],
    },
    { date: '2026-08-11', totalCost: 0, totalTokens: 0, byModel: [], byAgent: [] },
  ],
}

function tooltip(page: Page) {
  return page.getByTestId('global-settings-page').getByRole('status')
}

async function expectKeyboardFocus(chart: Locator) {
  await expect(chart).toBeFocused()
  await expect.poll(() => chart.evaluate(element => {
    const style = getComputedStyle(element)
    return element.matches(':focus-visible') &&
      style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
  }), { message: 'The focused chart has a visible keyboard focus indicator' }).toBe(true)
}

async function firstDay(chart: Locator, page: Page) {
  await page.mouse.move(0, 0)
  await chart.focus()
  // Reactivate navigation after using a control, then return to the first day.
  // Let each key's focus/tooltip render settle before sending another input;
  // an existing hover tooltip must not satisfy a keyboard-navigation wait.
  const pressAndRender = async (key: string) => {
    await chart.press(key)
    await chart.evaluate(() => new Promise<void>(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
  }
  await pressAndRender('ArrowRight')
  await expect(tooltip(page)).toBeVisible()
  await pressAndRender('ArrowLeft')
  await expect(tooltip(page)).not.toContainText('Aug 11')
  await chart.press('ArrowLeft')
  await expect(tooltip(page)).toContainText('Aug 9')
}

export async function checkUsageChart(context: UsageChartsContext) {
  const { page, request, apiBaseUrl, navigate } = context
  // Exercise the app's system-theme path without changing shared user settings.
  const settingsResponse = await request.get(`${apiBaseUrl}/api/user-settings`)
  expect(settingsResponse.ok(), 'Read user settings for the chart theme scenario').toBe(true)
  const settings = await settingsResponse.json() as Record<string, unknown>
  await page.route('**/api/user-settings', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { ...settings, theme: 'system' } })
    : route.continue())
  // Control the historical input only; render the real Settings page, chart,
  // tooltip, selection controls and routing with the installed chart library.
  await page.route('**/api/usage?*', route => route.fulfill({ json: usageChartFixture }))
  await navigate('/settings/usage')
  await expect(page.getByRole('heading', { name: '$20.00', exact: true })).toBeVisible()

  const costChart = page.getByRole('application', { name: 'Daily estimated cost in USD by model' })
  await expect(costChart).toBeVisible()
  const mutedLabel = page.getByText('Estimated spend', { exact: true })
  const axisLabels = costChart.locator('text')
  await expect(axisLabels.first()).toBeVisible()
  const themeColors: string[] = []
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(colorScheme === 'dark')
    const mutedColor = await mutedLabel.evaluate(element => getComputedStyle(element).color)
    themeColors.push(mutedColor)
    await expect.poll(() => axisLabels.evaluateAll(elements => elements.map(element => getComputedStyle(element).fill)), {
      message: `Usage axis labels match the app's muted text color in ${colorScheme} mode`,
    }).toEqual(Array(await axisLabels.count()).fill(mutedColor))
  }
  expect(themeColors[0], 'The chart follows the distinct light and dark palettes').not.toBe(themeColors[1])
  await page.getByRole('button', { name: /^tokens$/i }).focus()
  await page.keyboard.press('Tab')
  await expectKeyboardFocus(costChart)
  await expect(tooltip(page)).toHaveAttribute('aria-live', 'polite')
  await expect(tooltip(page)).toContainText('Aug 9')
  await expect(tooltip(page)).toContainText('claude-sonnet-4-6')
  await expect(tooltip(page)).toContainText('$12.00')
  await expect(tooltip(page)).toContainText('gpt-5')
  await expect(tooltip(page)).toContainText('$2.00')

  await costChart.press('ArrowRight')
  await expect(tooltip(page)).toContainText('Aug 10')
  await expect(tooltip(page)).toContainText('$6.00')
  await expect(tooltip(page)).toContainText('$0.00')
  await costChart.press('Tab')
  await expect(costChart).not.toBeFocused()

  const sonnet = page.getByRole('button', { name: 'claude-sonnet-4-6', exact: true })
  await sonnet.click()
  await expect(sonnet).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('#usage-overview-heading')).toHaveText('$12.00 / $20.00')
  await firstDay(costChart, page)
  await expect(tooltip(page)).toContainText('$12.00')
  await expect(tooltip(page)).not.toContainText('gpt-5')

  await page.getByRole('button', { name: /^tokens$/i }).click()
  await expect(sonnet).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('#usage-overview-heading')).toHaveText('$20.00')
  const tokenChart = page.getByRole('application', { name: 'Daily token usage by model' })
  await firstDay(tokenChart, page)
  await expect(tooltip(page)).toContainText('1.2K tokens')
  await expect(tooltip(page)).toContainText('200 tokens')
  await expect(tooltip(page)).not.toContainText('$')

  await page.getByRole('button', { name: 'Agent', exact: true }).click()
  await firstDay(page.getByRole('application', { name: 'Daily token usage by agent' }), page)
  await expect(tooltip(page)).toContainText('Research Agent')
  await expect(tooltip(page)).toContainText('1K tokens')
  await expect(tooltip(page)).toContainText('Support Agent')
  await expect(tooltip(page)).toContainText('400 tokens')
}

export async function checkConnectionActivityChart(context: UsageChartsContext) {
  const { page, request, apiBaseUrl, navigate } = context
  const response = await request.post(`${apiBaseUrl}/api/connected-accounts`, {
    data: {
      providerConnectionId: `chart-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      providerName: 'e2e', toolkitSlug: 'github', displayName: 'Chart Work GitHub', status: 'active',
    },
  })
  expect(response.ok(), 'Create a real connection for its usage detail page').toBe(true)
  const { account } = await response.json() as { account: { id: string } }
  expect(account.id).toBeTruthy()
  const activity: ConnectionActivityStats = {
    days: 14,
    generatedAt: '2026-08-11T12:00:00.000Z',
    connectionById: {
      [`account-${account.id}`]: [
        { date: '2026-08-09', succeeded: 2, failed: 1 },
        { date: '2026-08-10', succeeded: 0, failed: 0 },
        { date: '2026-08-11', succeeded: 3, failed: 0 },
      ],
    },
  }

  try {
    await page.route('**/api/activity/connections?*', route => route.fulfill({ json: activity }))
    await navigate(`/settings/connections?detail=account-${account.id}`)
    const card = page.getByTestId('connection-usage-card')
    await expect(card.getByText('6 calls', { exact: true })).toBeVisible()
    await expect(card.getByText('5 succeeded', { exact: true })).toBeVisible()
    await expect(card.getByText('1 failed', { exact: true })).toBeVisible()
    await expect(card.getByRole('group', {
      name: /activity: 6 calls over 3 days, 5 succeeded and 1 failed\./,
    })).toBeVisible()
    const chart = card.getByRole('application', { name: /daily activity$/ })
    await page.keyboard.press('Tab')
    await firstDay(chart, page)
    await expectKeyboardFocus(chart)
    await expect(tooltip(page)).toHaveAttribute('aria-live', 'polite')
    await expect(tooltip(page)).toContainText('Succeeded')
    await expect(tooltip(page)).toContainText('2 calls')
    await expect(tooltip(page)).toContainText('Failed')
    await expect(tooltip(page)).toContainText('1 call')

    await chart.press('ArrowRight')
    await expect(tooltip(page)).toContainText('Aug 10')
    await expect(tooltip(page).getByText('0 calls', { exact: true })).toHaveCount(2)
    await chart.press('Tab')
    await expect(card.getByRole('button', { name: 'View logs' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('heading', { name: 'Connection Logs' })).toBeVisible()
  } finally {
    const deleted = await request.delete(`${apiBaseUrl}/api/connected-accounts/${account.id}`)
    expect(deleted.ok(), 'Remove the connection created by this scenario').toBe(true)
  }
}

export const usageChartScenarios = [
  ['usage chart keeps dates, units and selected series aligned through keyboard navigation', checkUsageChart],
  ['connection activity exposes successful, failed and zero-call days before opening logs', checkConnectionActivityChart],
] as const
