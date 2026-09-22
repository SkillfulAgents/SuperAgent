// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => ({ data: { app: { autoDeleteInactiveDays: 0, apiLogAutoDeleteDays: 30 } } }),
}))

const usePreferencesMock = vi.fn()
const mutateMock = vi.fn()
vi.mock('@renderer/hooks/use-agent-preferences', () => ({
  useAgentPreferences: () => usePreferencesMock(),
  useUpdateAgentPreferences: () => ({ mutate: mutateMock, isPending: false }),
}))

// Radix popovers portal their content and need pointer plumbing jsdom lacks;
// render trigger and content inline so the options are reachable.
vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

import { HomeRetention } from './home-retention'

beforeEach(() => {
  vi.clearAllMocks()
  usePreferencesMock.mockReturnValue({ data: {} })
})

afterEach(() => cleanup())

describe('HomeRetention', () => {
  it('shows the app-wide default on both triggers when the agent has no override', () => {
    render(<HomeRetention agentSlug="sales" />)

    expect(screen.getByTestId('home-session-auto-delete-trigger')).toHaveTextContent('Never')
    expect(screen.getByTestId('home-api-log-auto-delete-trigger')).toHaveTextContent('30d')
    expect(screen.getByTestId('home-session-auto-delete-app-default')).toBeDisabled()
  })

  it('writes a session auto-delete override in days', async () => {
    render(<HomeRetention agentSlug="sales" />)

    await userEvent.click(screen.getByTestId('home-session-auto-delete-option-90'))

    expect(mutateMock).toHaveBeenCalledWith({ autoDeleteInactiveDays: 90 })
  })

  it('marks the current override and resets it to the app default with null', async () => {
    usePreferencesMock.mockReturnValue({ data: { autoDeleteInactiveDays: 90 } })
    render(<HomeRetention agentSlug="sales" />)

    expect(screen.getByTestId('home-session-auto-delete-trigger')).toHaveTextContent('90d')
    expect(screen.getByTestId('home-session-auto-delete-option-90')).toHaveAttribute('aria-selected', 'true')

    await userEvent.click(screen.getByTestId('home-session-auto-delete-app-default'))

    expect(mutateMock).toHaveBeenCalledWith({ autoDeleteInactiveDays: null })
  })

  it('writes "Never" for sessions as zero, an explicit override of the default', async () => {
    render(<HomeRetention agentSlug="sales" />)

    await userEvent.click(screen.getByTestId('home-session-auto-delete-option-0'))

    expect(mutateMock).toHaveBeenCalledWith({ autoDeleteInactiveDays: 0 })
  })

  it('writes "Never" for API logs as zero, distinct from the default', async () => {
    render(<HomeRetention agentSlug="sales" />)

    await userEvent.click(screen.getByTestId('home-api-log-auto-delete-option-0'))

    expect(mutateMock).toHaveBeenCalledWith({ apiLogAutoDeleteDays: 0 })
  })

  it('lists and marks a custom API-log value that is not a preset', () => {
    usePreferencesMock.mockReturnValue({ data: { apiLogAutoDeleteDays: 45 } })
    render(<HomeRetention agentSlug="sales" />)

    expect(screen.getByTestId('home-api-log-auto-delete-trigger')).toHaveTextContent('45d')
    expect(screen.getByTestId('home-api-log-auto-delete-option-45')).toHaveAttribute('aria-selected', 'true')
  })
})
