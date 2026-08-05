// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UsageTab } from './usage-tab'
import type { LlmProviderId } from '@shared/lib/config/settings'

const useSettingsMock = vi.fn()
const refetchMock = vi.fn()

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
}))

vi.mock('@renderer/hooks/use-usage', () => ({
  useUsageData: () => ({
    data: { daily: [] },
    isLoading: false,
    isFetching: false,
    refetch: refetchMock,
  }),
}))

vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAuthMode: false, isAdmin: false }),
}))

describe('UsageTab estimate notice', () => {
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
})
