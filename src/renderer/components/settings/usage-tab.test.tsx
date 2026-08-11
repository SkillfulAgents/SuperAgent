// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { UsageTab } from './usage-tab'
import type { LlmProviderId } from '@shared/lib/config/settings'

const useSettingsMock = vi.fn()
const useUsageMock = vi.fn()
const refetchMock = vi.fn()

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
}))

vi.mock('@renderer/hooks/use-usage', () => ({
  useUsageData: (...args: unknown[]) => useUsageMock(...args),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, isAdmin: false }),
}))

describe('UsageTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useUsageMock.mockReturnValue({
      data: { daily: [] },
      isLoading: false,
      isFetching: false,
      refetch: refetchMock,
    })
  })

  it('relies on the query lifecycle instead of forcing a second mount refetch', () => {
    useSettingsMock.mockReturnValue({ data: {} })

    render(<UsageTab />)

    expect(refetchMock).not.toHaveBeenCalled()
  })

  it('keeps the explicit Refresh action', () => {
    useSettingsMock.mockReturnValue({ data: {} })
    render(<UsageTab />)
    refetchMock.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    expect(refetchMock).toHaveBeenCalledOnce()
  })

  it('explains that deleted agents and sessions are excluded', () => {
    useSettingsMock.mockReturnValue({ data: { llmProvider: 'anthropic' } })

    render(<UsageTab />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      "These estimates only include agents and sessions that haven't been deleted",
    )
    expect(screen.getByRole('alert')).toHaveTextContent('actual usage and costs may be higher')
  })

  it.each(
    [
      ['anthropic', 'Anthropic API Console', 'https://platform.claude.com/usage'],
      ['openrouter', 'OpenRouter Activity dashboard', 'https://openrouter.ai/activity'],
      ['platform', 'Gamut Platform', 'https://platform.gamutagents.com'],
    ] satisfies Array<[LlmProviderId, string, string]>,
  )('links the %s provider to its definitive usage view', (provider, label, href) => {
    useSettingsMock.mockReturnValue({ data: { llmProvider: provider } })

    render(<UsageTab />)

    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', href)
  })

  it('falls back to provider billing guidance when there is no known dashboard', () => {
    useSettingsMock.mockReturnValue({ data: { llmProvider: 'generic' } })

    render(<UsageTab />)

    expect(screen.getByRole('alert')).toHaveTextContent("check your provider's billing dashboard")
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('surfaces real summary metrics and switches the ranked breakdown', () => {
    useSettingsMock.mockReturnValue({ data: { llmProvider: 'anthropic' } })
    useUsageMock.mockReturnValue({
      data: {
        daily: [{
          date: '2026-08-10',
          totalCost: 12,
          totalTokens: 1_500,
          byModel: [{ model: 'claude-sonnet-4-6', cost: 12, totalTokens: 1_500 }],
          byAgent: [{
            agentSlug: 'research',
            agentName: 'Research Agent',
            cost: 12,
            totalTokens: 1_500,
          }],
        }],
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchMock,
    })

    render(<UsageTab />)

    expect(screen.getByRole('heading', { name: '$12.00' })).toBeInTheDocument()
    expect(screen.getAllByText('1.5K').length).toBeGreaterThan(0)
    expect(screen.getAllByText('claude-sonnet-4-6')).toHaveLength(2)
    expect(document.querySelector('[data-provider-icon="anthropic"]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Agent' }))

    expect(screen.getAllByText('Research Agent')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('switches the daily chart between cost and token views', () => {
    useSettingsMock.mockReturnValue({ data: {} })
    useUsageMock.mockReturnValue({
      data: {
        daily: [{
          date: '2026-08-10',
          totalCost: 1,
          totalTokens: 100,
          byModel: [{ model: 'test-model', cost: 1, totalTokens: 100 }],
          byAgent: [],
        }],
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchMock,
    })

    render(<UsageTab />)
    const tokensButton = screen.getByRole('button', { name: /tokens/i })

    fireEvent.click(tokensButton)

    expect(tokensButton).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /cost/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('isolates a selected series and compares its metrics with the overall totals', () => {
    useSettingsMock.mockReturnValue({ data: { llmProvider: 'anthropic' } })
    useUsageMock.mockReturnValue({
      data: {
        daily: [
          {
            date: '2026-08-09',
            totalCost: 14,
            totalTokens: 1_400,
            byModel: [
              { model: 'claude-sonnet-4-6', cost: 12, totalTokens: 1_200 },
              { model: 'gpt-5', cost: 2, totalTokens: 200 },
            ],
            byAgent: [],
          },
          {
            date: '2026-08-10',
            totalCost: 6,
            totalTokens: 600,
            byModel: [{ model: 'gpt-5', cost: 6, totalTokens: 600 }],
            byAgent: [],
          },
        ],
      },
      isLoading: false,
      isFetching: false,
      refetch: refetchMock,
    })

    render(<UsageTab />)

    const legendButton = screen.getByRole('button', { name: /^claude-sonnet-4-6$/ })
    const breakdownButton = screen.getByRole('button', { name: /claude-sonnet-4-6.*\$12\.00/ })
    const spendHeading = document.getElementById('usage-overview-heading')

    fireEvent.click(legendButton)

    expect(legendButton).toHaveAttribute('aria-pressed', 'true')
    expect(breakdownButton).toHaveAttribute('aria-pressed', 'true')
    expect(spendHeading).toHaveTextContent('$12.00 / $20.00')
    expect(screen.getByText('Processed tokens').parentElement).toHaveTextContent('1.2K / 2K')
    expect(screen.getByText('Active days').parentElement).toHaveTextContent('1 / 2')
    expect(screen.getByText('Peak spend').parentElement).toHaveTextContent('$12.00 / $14.00')
    expect(screen.getByText('Models in view').parentElement).toHaveTextContent('1 / 2')

    fireEvent.click(breakdownButton)

    expect(legendButton).toHaveAttribute('aria-pressed', 'false')
    expect(spendHeading).toHaveTextContent('$20.00')
    expect(spendHeading).not.toHaveTextContent('/')

    fireEvent.click(breakdownButton)
    expect(breakdownButton).toHaveAttribute('aria-pressed', 'true')
  })

})
