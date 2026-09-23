// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutate: vi.fn(),
}))
vi.mock('@renderer/hooks/use-llm-connections', () => ({
  useLlmConnections: () => ({ data: state.data }),
  useConnectionMutation: () => ({ mutate: state.mutate, isPending: false }),
}))
vi.mock('@renderer/hooks/use-settings', () => ({
  useModelSettings: () => ({ data: {} }),
  useUpdateSettings: () => ({ mutate: vi.fn() }),
}))
vi.mock('@renderer/context/user-context', () => ({
  useUser: () => ({ isAdmin: true, isAuthMode: false }),
}))
vi.mock('./settings-model-select', () => ({
  SettingsModelSelect: ({ directApiOnly, model, llmProviderId }: { directApiOnly?: boolean; model?: string; llmProviderId?: string }) =>
    <div data-testid={directApiOnly ? 'summarizer-selection' : 'default-selection'}>{llmProviderId}:{model}</div>,
}))
vi.mock('./model-catalog/catalog-editor', () => ({ CatalogEditor: () => null }))
// Keep tooltip text visible so the assertion targets the page's reason, not Radix timing.
vi.mock('@renderer/components/ui/tooltip', () => {
  const Wrapper = ({ children }: { children: ReactNode }) => <>{children}</>
  return { TooltipProvider: Wrapper, Tooltip: Wrapper, TooltipTrigger: Wrapper, TooltipContent: Wrapper }
})
import { LlmConnectionsTab } from './llm-connections-tab'

beforeEach(() => {
  vi.clearAllMocks()
  state.data = {
    connections: [{ id: 'api', name: 'API', userId: null, supportsDirectApi: true, canDelete: false, deletionBlockedReason: 'Change the app default first' }],
    defaultSelection: { llmProviderId: 'api', model: 'sonnet' },
    summarizerSelection: null,
  }
})

describe('global helper settings', () => {
  it('identifies an inherited summarizer explicitly', () => {
    render(<LlmConnectionsTab />)
    expect(screen.getByText('Using app default')).toBeVisible()
    expect(screen.getByTestId('summarizer-selection')).toHaveTextContent('api:sonnet')
    expect(screen.queryByRole('button', { name: 'Use app default' })).not.toBeInTheDocument()
  })

  it('explains why an agent-only default requires its separate helper', async () => {
    state.data = { ...state.data,
      connections: [{ id: 'sub', name: 'Subscription', supportsDirectApi: false, canDelete: true }],
      defaultSelection: { llmProviderId: 'sub', model: 'opus' },
      summarizerSelection: { llmProviderId: 'api', model: 'haiku' },
    }
    render(<LlmConnectionsTab />)
    expect(screen.getByText('This app default requires a separate API-capable summarizer.')).toBeVisible()
    const inherit = screen.getByRole('button', { name: 'Use app default' })
    expect(inherit).toBeDisabled()
    await userEvent.click(inherit)
    expect(state.mutate).not.toHaveBeenCalled()
  })

  it('does not display an agent-only model as the missing summarizer', () => {
    state.data = { ...state.data,
      connections: [{ id: 'sub', name: 'Subscription', supportsDirectApi: false, canDelete: true }],
      defaultSelection: { llmProviderId: 'sub', model: 'opus' },
    }
    render(<LlmConnectionsTab />)
    expect(screen.getByTestId('summarizer-selection')).not.toHaveTextContent('opus')
  })

  it('shows the server deletion blocker verbatim', () => {
    render(<LlmConnectionsTab />)
    expect(screen.getByRole('button', { name: 'Delete API' })).toBeDisabled()
    expect(screen.getByText('Change the app default first')).toBeVisible()
  })

  it('allows returning to an API-capable app default', async () => {
    state.data.summarizerSelection = { llmProviderId: 'api', model: 'haiku' }
    render(<LlmConnectionsTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Use app default' }))
    expect(state.mutate).toHaveBeenCalledWith({ path: '/defaults/summarizer', method: 'PUT', body: null }, expect.anything())
  })
})
